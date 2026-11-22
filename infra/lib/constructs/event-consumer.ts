import { Duration } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Rule } from 'aws-cdk-lib/aws-events';
import type { IEventBus } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import type { StageConfig } from '../config/stages';
import { removalPolicyFor } from '../removal-policy';
import type { ServiceFunction } from './service-function';

/** The visibility timeout is this many times the timeout of the function. It is the minimum that Lambda's documentation recommends: the extra time covers a retry after a throttle. */
export const visibilityTimeoutMultiple = 6;

/** Receives of a message before it goes to the dead-letter queue. Lambda's documentation recommends at least 5, so a throttled function does not park a good message. */
export const defaultMaxReceiveCount = 5;

/** Messages per batch, the most that SQS gives Lambda when there is no batching window. */
export const defaultBatchSize = 10;

/** How long a failed message waits in the dead-letter queue. It is the maximum, and longer than the queue's own retention, because a message keeps the time it first entered the queue. */
export const deadLetterRetention = Duration.days(14);

/** The age alarm fires when a message has waited this long in the dead-letter queue, so a failure that nobody dealt with comes back as a second notification. */
export const deadLetterAgeAlarmThreshold = Duration.days(1);

export interface EventConsumerProps {
    readonly config: StageConfig;
    /** The function that handles the messages. It must be in the same stack, and the consumer sets its timeout as the base of the visibility timeout. */
    readonly function: ServiceFunction;
    /** The custom bus of the platform stack. */
    readonly eventBus: IEventBus;
    /** The producer of the events, as in the envelope: `storefront.orders` (conventions: Events). */
    readonly source: string;
    /** The events it reacts to, as PascalCase names: `OrderPlaced`. At least one. */
    readonly detailTypes: readonly string[];
    /** The alarm topic of the platform stack, which the two dead-letter alarms notify. It is required, so no alarm notifies nobody. */
    readonly alarmTopic: ITopic;
    /** Defaults to 5. */
    readonly maxReceiveCount?: number;
    /** Defaults to 10. */
    readonly batchSize?: number;
}

/**
 * How a service reacts to events: a rule on the custom bus, a queue as its target, a dead-letter queue, and the function reading the queue.
 * A message that fails is retried, and after `maxReceiveCount` receives it is parked in the dead-letter queue instead of lost. Two alarms watch the dead-letter queue, and both notify the alarm topic.
 *
 * The handler reports the messages that failed (`batchItemFailures`), and the ones that worked are deleted, so one bad message does not hold back the others.
 * The message body is the whole event from EventBridge, and the envelope of `packages/events` is its `detail`: `parseEventOfType('OrderPlaced', JSON.parse(record.body).detail)`.
 * A handler does not catch a parse error. The message goes back to the queue, and to the dead-letter queue in the end.
 * Delivery is at least once, so the handler must be idempotent (`packages/shared`).
 *
 * The queue's visibility timeout is 6 times the timeout of the function. There is no batching window, so nothing is added to it.
 * Both queues are encrypted with an SQS managed key and refuse requests that do not use TLS. A queue in a persistent stage (`prod`) is kept when the stack is deleted, because a failed message is evidence.
 *
 * Permissions are given the CDK way and stay narrow: the function can read this queue, and only this rule can send to it. There is no wildcard.
 * One consumer can take several event types, which then share the queue and the function. Events that need different handling get an `EventConsumer` each, with a queue and a dead-letter queue of their own.
 * An event rule cannot carry tags in CloudFormation, so the two queues carry the standard tags.
 * The rule has no dead-letter queue of its own: an event that EventBridge cannot deliver to the queue is retried for 24 hours (its default) and then dropped. That is accepted, because the target is a queue in the same account and the rule has permission to send to it.
 *
 * @example
 * const consumer = new EventConsumer(this, 'OrderPlaced', {
 *     config,
 *     function: onOrderPlaced, // a ServiceFunction in this stack
 *     eventBus,
 *     source: 'storefront.orders',
 *     detailTypes: ['OrderPlaced'],
 *     alarmTopic
 * });
 * table.grantReadWriteData(onOrderPlaced);
 */
export class EventConsumer extends Construct {
    readonly rule: Rule;
    readonly queue: Queue;
    readonly deadLetterQueue: Queue;
    /** At least one message is waiting in the dead-letter queue. */
    readonly deadLetterDepthAlarm: Alarm;
    /** The oldest message in the dead-letter queue has waited for `deadLetterAgeAlarmThreshold`. */
    readonly deadLetterAgeAlarm: Alarm;

    constructor(scope: Construct, id: string, props: EventConsumerProps) {
        super(scope, id);
        const timeout = props.function.timeout;
        if (timeout === undefined) throw new Error('The function of an EventConsumer needs a timeout, which sets the visibility timeout of its queue.');
        if (props.detailTypes.length === 0) throw new Error('An EventConsumer needs at least one detail type, or its rule matches nothing.');
        const maxReceiveCount = props.maxReceiveCount ?? defaultMaxReceiveCount;
        const batchSize = props.batchSize ?? defaultBatchSize;
        const removalPolicy = removalPolicyFor(props.config);

        this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', { retentionPeriod: deadLetterRetention, encryption: QueueEncryption.SQS_MANAGED, enforceSSL: true, removalPolicy });
        this.queue = new Queue(this, 'Queue', {
            visibilityTimeout: Duration.seconds(timeout.toSeconds() * visibilityTimeoutMultiple),
            encryption: QueueEncryption.SQS_MANAGED,
            enforceSSL: true,
            deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount },
            removalPolicy
        });

        this.rule = new Rule(this, 'Rule', {
            description: `Sends ${props.detailTypes.join(', ')} from ${props.source} to the queue of ${props.function.node.id}.`,
            eventBus: props.eventBus,
            eventPattern: { source: [props.source], detailType: [...props.detailTypes] },
            targets: [new SqsQueue(this.queue)]
        });
        props.function.addEventSource(new SqsEventSource(this.queue, { batchSize, reportBatchItemFailures: true }));

        const period = Duration.minutes(5);
        this.deadLetterDepthAlarm = new Alarm(this, 'DeadLetterDepth', {
            alarmDescription: 'A message failed every retry and is waiting in the dead-letter queue.',
            metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period, statistic: 'Maximum' }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: TreatMissingData.NOT_BREACHING
        });
        this.deadLetterAgeAlarm = new Alarm(this, 'DeadLetterAge', {
            alarmDescription: 'A message has waited in the dead-letter queue for a day, and nobody dealt with it.',
            metric: this.deadLetterQueue.metricApproximateAgeOfOldestMessage({ period, statistic: 'Maximum' }),
            threshold: deadLetterAgeAlarmThreshold.toSeconds(),
            evaluationPeriods: 1,
            comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: TreatMissingData.NOT_BREACHING
        });
        for (const alarm of [this.deadLetterDepthAlarm, this.deadLetterAgeAlarm]) {
            alarm.addAlarmAction(new SnsAction(props.alarmTopic));
        }
    }
}
