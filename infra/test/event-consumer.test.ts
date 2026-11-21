import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { applyStandardTags } from '../lib/aspects/standard-tags';
import { stageNames, stages } from '../lib/config/stages';
import type { StageName } from '../lib/config/stages';
import { EventConsumer, deadLetterAgeAlarmThreshold, deadLetterRetention, defaultBatchSize, defaultMaxReceiveCount, visibilityTimeoutMultiple } from '../lib/constructs/event-consumer';
import type { EventConsumerProps } from '../lib/constructs/event-consumer';
import { ServiceFunction } from '../lib/constructs/service-function';
import { applyNag } from '../lib/nag';

const entry = 'infra/test/fixtures/handler.ts';

/** Bundling is skipped, because esbuild is slow and the template does not depend on it. */
const newApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });

/** The topic of the function, which a function must have. It is not the topic of the consumer, so a test can tell them apart. */
const functionAlarmTopicArn = 'arn:aws:sns:us-west-2:111111111111:function-alarms';
const functionAlarmTopic = (stack: Stack) => Topic.fromTopicArn(stack, 'FunctionAlarmTopic', functionAlarmTopicArn);

/** A stack with one function and one consumer of it, the way a service stack uses them. It does not synthesize, so cdk-nag can still be added to the app. */
function build(stage: StageName, options: { timeout?: Duration; overrides?: Partial<Omit<EventConsumerProps, 'config' | 'function' | 'eventBus'>>; tags?: boolean; app?: App } = {}) {
    const stack = new Stack(options.app ?? newApp(), 'Demo');
    if (options.tags) applyStandardTags(stack, stages[stage], 'Shipping');
    const config = stages[stage];
    const eventBus = new EventBus(stack, 'Bus');
    const fn = new ServiceFunction(stack, 'OnOrderPlaced', { config, service: 'Shipping', entry, timeout: options.timeout ?? Duration.seconds(30), eventBusName: eventBus.eventBusName, alarmTopic: functionAlarmTopic(stack) });
    const consumer = new EventConsumer(stack, 'OrderPlaced', { config, function: fn, eventBus, source: 'storefront.orders', detailTypes: ['OrderPlaced'], ...options.overrides });
    return { stack, consumer };
}

/** The same, with its template, which synthesizes the stack. */
function setup(stage: StageName, options: Parameters<typeof build>[1] = {}) {
    const { stack, consumer } = build(stage, options);
    return { stack, consumer, template: Template.fromStack(stack) };
}

const queues = (template: Template) => template.findResources('AWS::SQS::Queue');
const sourceQueueId = (template: Template) => Object.keys(queues(template)).find((id) => queues(template)[id]!.Properties.RedrivePolicy !== undefined)!;
const deadLetterQueueId = (template: Template) => Object.keys(queues(template)).find((id) => id !== sourceQueueId(template))!;

interface Statement {
    Effect: string;
    Action: string | string[];
    Resource?: unknown;
    Principal?: unknown;
}

const asList = (value: string | string[]) => (Array.isArray(value) ? value : [value]);

/** Every statement of every IAM policy and every queue policy in the template. */
function allStatements(template: Template): Statement[] {
    return [...Object.values(template.findResources('AWS::IAM::Policy')), ...Object.values(template.findResources('AWS::SQS::QueuePolicy'))].flatMap((policy) => policy.Properties.PolicyDocument.Statement as Statement[]);
}

describe.each(stageNames)('EventConsumer in %s', (stage) => {
    const { template } = setup(stage);

    it('has a queue with a dead-letter queue and a redrive policy, and no other queue', () => {
        template.resourceCountIs('AWS::SQS::Queue', 2);
        template.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [deadLetterQueueId(template), 'Arn'] }, maxReceiveCount: defaultMaxReceiveCount } });
        expect(queues(template)[deadLetterQueueId(template)]!.Properties.RedrivePolicy).toBeUndefined();
    });

    it('sets the visibility timeout to a multiple of the function timeout', () => {
        const [fn] = Object.values(template.findResources('AWS::Lambda::Function'));
        const queue = queues(template)[sourceQueueId(template)]!;

        expect(fn!.Properties.Timeout).toBe(30);
        expect(queue.Properties.VisibilityTimeout).toBe(30 * visibilityTimeoutMultiple);
        expect(visibilityTimeoutMultiple).toBeGreaterThanOrEqual(6);
    });

    it('reads the queue with partial batch failure reporting on', () => {
        template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
        template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
            EventSourceArn: { 'Fn::GetAtt': [sourceQueueId(template), 'Arn'] },
            FunctionResponseTypes: ['ReportBatchItemFailures'],
            BatchSize: defaultBatchSize
        });
    });

    it('keeps a failed message for the longest time SQS allows, and longer than the queue keeps its own', () => {
        const { Properties: source } = queues(template)[sourceQueueId(template)]!;
        const { Properties: deadLetter } = queues(template)[deadLetterQueueId(template)]!;

        expect(deadLetter.MessageRetentionPeriod).toBe(deadLetterRetention.toSeconds());
        expect(deadLetter.MessageRetentionPeriod).toBeGreaterThan(source.MessageRetentionPeriod ?? 4 * 24 * 60 * 60);
    });

    it('has a rule on the custom bus that sends the event to the queue', () => {
        template.resourceCountIs('AWS::Events::Rule', 1);
        template.hasResourceProperties('AWS::Events::Rule', {
            EventBusName: { Ref: Object.keys(template.findResources('AWS::Events::EventBus'))[0] },
            EventPattern: { source: ['storefront.orders'], 'detail-type': ['OrderPlaced'] },
            Targets: [{ Arn: { 'Fn::GetAtt': [sourceQueueId(template), 'Arn'] } }]
        });
    });

    it('has the two dead-letter queue alarms, on that queue and no other, and the three of the function', () => {
        const deadLetterQueue = { Name: 'QueueName', Value: { 'Fn::GetAtt': [deadLetterQueueId(template), 'QueueName'] } };

        template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            Namespace: 'AWS/SQS',
            MetricName: 'ApproximateNumberOfMessagesVisible',
            Statistic: 'Maximum',
            Threshold: 1,
            ComparisonOperator: 'GreaterThanOrEqualToThreshold',
            Dimensions: [deadLetterQueue]
        });
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            Namespace: 'AWS/SQS',
            MetricName: 'ApproximateAgeOfOldestMessage',
            Statistic: 'Maximum',
            Threshold: deadLetterAgeAlarmThreshold.toSeconds(),
            ComparisonOperator: 'GreaterThanOrEqualToThreshold',
            Dimensions: [deadLetterQueue]
        });
    });

    it('treats a silent queue as healthy, because SQS stops reporting for an idle queue', () => {
        for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
            expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
        }
    });

    it('encrypts both queues and refuses requests without TLS', () => {
        for (const queue of Object.values(queues(template))) {
            expect(queue.Properties.SqsManagedSseEnabled).toBe(true);
        }
        const denied = allStatements(template).filter(({ Effect, Action }) => Effect === 'Deny' && asList(Action).includes('sqs:*'));
        expect(denied).toHaveLength(2);
        for (const statement of denied) {
            expect(JSON.stringify(statement)).toContain('"aws:SecureTransport":"false"');
        }
    });

    it('keeps the queues in a persistent stage only, because a failed message is evidence', () => {
        for (const queue of Object.values(queues(template))) {
            expect(queue.DeletionPolicy).toBe(stage === 'prod' ? 'Retain' : 'Delete');
        }
    });
});

describe('EventConsumer permissions', () => {
    const { template } = setup('dev');
    const allowed = allStatements(template).filter(({ Effect }) => Effect === 'Allow');

    it('has no wildcard in an allowed action or principal, and no wildcard resource except the one of X-Ray', () => {
        expect(allowed.length).toBeGreaterThan(0);
        for (const { Action, Resource, Principal } of allowed) {
            expect(asList(Action).filter((action) => action.includes('*'))).toEqual([]);
            expect(JSON.stringify(Principal ?? {})).not.toContain('"*"');
            if (Resource === '*') expect(asList(Action).every((action) => action.startsWith('xray:'))).toBe(true);
        }
        expect(allowed.filter(({ Resource }) => Resource === '*')).toHaveLength(1);
    });

    it('lets the function read the queue it consumes and no other queue', () => {
        const statement = allowed.find(({ Action }) => asList(Action).includes('sqs:ReceiveMessage'));

        expect(statement).toBeDefined();
        expect(asList(statement!.Action).sort()).toEqual(['sqs:ChangeMessageVisibility', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:ReceiveMessage']);
        expect(statement!.Resource).toEqual({ 'Fn::GetAtt': [sourceQueueId(template), 'Arn'] });
    });

    it('lets only the rule send to the queue', () => {
        const statement = allowed.find(({ Action }) => asList(Action).includes('sqs:SendMessage'));

        expect(statement).toBeDefined();
        expect(statement!.Principal).toEqual({ Service: 'events.amazonaws.com' });
        expect(statement!.Resource).toEqual({ 'Fn::GetAtt': [sourceQueueId(template), 'Arn'] });
        expect(JSON.stringify(statement)).toContain('aws:SourceArn');
    });
});

describe('EventConsumer props', () => {
    it('follows the function timeout in the visibility timeout', () => {
        const { template } = setup('dev', { timeout: Duration.minutes(2) });

        expect(queues(template)[sourceQueueId(template)]!.Properties.VisibilityTimeout).toBe(120 * visibilityTimeoutMultiple);
    });

    it('takes the receive count and the batch size it is asked for', () => {
        const { template } = setup('dev', { overrides: { maxReceiveCount: 8, batchSize: 4 } });

        template.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: { maxReceiveCount: 8 } });
        template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 4 });
    });

    it('matches every detail type it is given, from one source', () => {
        const { template } = setup('dev', { overrides: { source: 'storefront.shipping', detailTypes: ['ShipmentDispatched', 'ShipmentDelivered'] } });

        template.hasResourceProperties('AWS::Events::Rule', { EventPattern: { source: ['storefront.shipping'], 'detail-type': ['ShipmentDispatched', 'ShipmentDelivered'] } });
    });

    it('refuses a rule that would match nothing', () => {
        expect(() => setup('dev', { overrides: { detailTypes: [] } })).toThrow(/at least one detail type/);
    });

    it('sends its two alarms to the alarm topic it is given, and leaves the alarms of the function with the topic of the function', () => {
        const stack = new Stack(newApp(), 'Demo');
        const alarmTopic = Topic.fromTopicArn(stack, 'AlarmTopic', 'arn:aws:sns:us-west-2:111111111111:alarms');
        const eventBus = new EventBus(stack, 'Bus');
        const fn = new ServiceFunction(stack, 'Fn', { config: stages.dev, service: 'Shipping', entry, timeout: Duration.seconds(30), eventBusName: 'bus', alarmTopic: functionAlarmTopic(stack) });
        new EventConsumer(stack, 'Consumer', { config: stages.dev, function: fn, eventBus, source: 'storefront.orders', detailTypes: ['OrderPlaced'], alarmTopic });
        const alarms = Object.values(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm'));

        expect(alarms.filter((alarm) => alarm.Properties.Namespace === 'AWS/SQS').map((alarm) => alarm.Properties.AlarmActions)).toEqual([['arn:aws:sns:us-west-2:111111111111:alarms'], ['arn:aws:sns:us-west-2:111111111111:alarms']]);
        expect(alarms.filter((alarm) => alarm.Properties.Namespace === 'AWS/Lambda').every((alarm) => JSON.stringify(alarm.Properties.AlarmActions) === JSON.stringify([functionAlarmTopicArn]))).toBe(true);
    });

    it('leaves its own two alarms without an action when there is no alarm topic, as the function has its own', () => {
        const { template } = setup('dev');
        const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));

        expect(alarms.filter((alarm) => alarm.Properties.Namespace === 'AWS/SQS')).toHaveLength(2);
        for (const alarm of alarms.filter((each) => each.Properties.Namespace === 'AWS/SQS')) {
            expect(alarm.Properties.AlarmActions).toBeUndefined();
        }
    });
});

describe('EventConsumer tags', () => {
    it('has the standard tags on both queues, from the tags of its stack', () => {
        const { template } = setup('dev', { tags: true });
        const tags = [
            { Key: 'owner', Value: stages.dev.owner },
            { Key: 'project', Value: 'storefront' },
            { Key: 'service', Value: 'Shipping' },
            { Key: 'stage', Value: 'dev' }
        ];

        for (const queue of Object.values(queues(template))) {
            expect(queue.Properties.Tags).toEqual(tags);
        }
        expect(Object.keys(queues(template))).toHaveLength(2);
    });
});

describe('EventConsumer and cdk-nag', () => {
    it.each(stageNames)(
        'passes the AWS Solutions rules in %s, with no acknowledgement from the stack',
        (stage) => {
            const app = newApp();
            build(stage, { app });
            applyNag(app, []);

            expect(() => app.synth()).not.toThrow();
        },
        30000
    );
});
