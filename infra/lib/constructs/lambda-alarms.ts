import { Duration } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/** The duration alarm fires when the slowest 1% of invocations take this share of the timeout or more. */
export const durationAlarmShareOfTimeout = 0.8;

export interface LambdaAlarmsProps {
    readonly function: IFunction;
    /** The timeout of the function, which the duration alarm is measured against. */
    readonly timeout: Duration;
    /** Where the alarms notify. Without one, the alarms exist and notify nobody. */
    readonly alarmTopic?: ITopic;
}

/**
 * The three alarms every function gets: errors, throttles and duration. `ServiceFunction` adds them itself, and a function that is not a `ServiceFunction` can use them on its own.
 *
 * An error or a throttle in a five minute window alarms. Duration alarms when the p99 is at 80% of the timeout or more in two of three windows, so one slow cold start does not.
 * A window with no invocations is not a breach.
 *
 * @example
 * new LambdaAlarms(this, 'HelloAlarms', { function: hello, timeout: Duration.seconds(10), alarmTopic });
 */
export class LambdaAlarms extends Construct {
    readonly errors: Alarm;
    readonly throttles: Alarm;
    readonly duration: Alarm;

    constructor(scope: Construct, id: string, props: LambdaAlarmsProps) {
        super(scope, id);
        const period = Duration.minutes(5);

        this.errors = new Alarm(this, 'Errors', {
            alarmDescription: 'The function failed at least once.',
            metric: props.function.metricErrors({ period, statistic: 'Sum' }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: TreatMissingData.NOT_BREACHING
        });
        this.throttles = new Alarm(this, 'Throttles', {
            alarmDescription: 'Lambda refused at least one invocation of the function because it ran out of concurrency.',
            metric: props.function.metricThrottles({ period, statistic: 'Sum' }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: TreatMissingData.NOT_BREACHING
        });
        this.duration = new Alarm(this, 'Duration', {
            alarmDescription: 'The slowest 1% of invocations are close to the timeout of the function.',
            metric: props.function.metricDuration({ period, statistic: 'p99' }),
            threshold: props.timeout.toMilliseconds() * durationAlarmShareOfTimeout,
            evaluationPeriods: 3,
            datapointsToAlarm: 2,
            comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: TreatMissingData.NOT_BREACHING
        });

        if (props.alarmTopic) {
            for (const alarm of [this.errors, this.throttles, this.duration]) {
                alarm.addAlarmAction(new SnsAction(props.alarmTopic));
            }
        }
    }
}
