import { Duration } from 'aws-cdk-lib';
import type { Stage } from 'aws-cdk-lib/aws-apigateway';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import type { Metric } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/** The 4xx alarm fires when a window has this many client errors or more. A few are normal (a 404 for an id that does not exist), so one error is not a reason to write to anyone. */
export const clientErrorAlarmThreshold = 100;

/** The latency alarm fires when the slowest 5% of requests take this long or more. Well above a cold start, and well below the 29 second integration timeout (decision 0003). */
export const latencyAlarmThreshold = Duration.seconds(5);

export interface ApiAlarmsProps {
    /** The stage of the API, which the metrics are for. The metrics of one stage are not those of another. */
    readonly stage: Stage;
    readonly alarmTopic: ITopic;
}

/**
 * The three alarms every API gets, all on one stage and all notifying the alarm topic: server errors, client errors and latency. `ServiceApi` adds them itself.
 *
 * - 5xx: one server error in a five minute window. An error that the handler did not turn into a response, and a gateway failure such as a timeout, both count.
 * - 4xx: `clientErrorAlarmThreshold` client errors in a five minute window, in two of three windows, so a burst of bad requests does not, but a client that keeps failing does.
 * - Latency: the p95 at `latencyAlarmThreshold` or more in two of three windows, so one slow cold start does not.
 *
 * A window with no requests is not a breach. These numbers are a starting point: the delivery and operations phase tunes the thresholds against what the services really do.
 *
 * @example
 * new ApiAlarms(this, 'Alarms', { stage: api.deploymentStage, alarmTopic });
 */
export class ApiAlarms extends Construct {
    readonly serverErrors: Alarm;
    readonly clientErrors: Alarm;
    readonly latency: Alarm;

    constructor(scope: Construct, id: string, props: ApiAlarmsProps) {
        super(scope, id);
        const period = Duration.minutes(5);
        const alarm = (name: string, description: string, metric: Metric, threshold: number, windows: { evaluationPeriods: number; datapointsToAlarm?: number }) =>
            new Alarm(this, name, {
                alarmDescription: description,
                metric,
                threshold,
                ...windows,
                comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: TreatMissingData.NOT_BREACHING
            });

        this.serverErrors = alarm('ServerErrors', 'The API answered at least one request with a 5xx.', props.stage.metricServerError({ period, statistic: 'Sum' }), 1, { evaluationPeriods: 1 });
        this.clientErrors = alarm('ClientErrors', 'Clients of the API keep getting 4xx responses.', props.stage.metricClientError({ period, statistic: 'Sum' }), clientErrorAlarmThreshold, { evaluationPeriods: 3, datapointsToAlarm: 2 });
        this.latency = alarm('Latency', 'The slowest 5% of requests to the API are slow.', props.stage.metricLatency({ period, statistic: 'p95' }), latencyAlarmThreshold.toMilliseconds(), { evaluationPeriods: 3, datapointsToAlarm: 2 });

        for (const each of [this.serverErrors, this.clientErrors, this.latency]) {
            each.addAlarmAction(new SnsAction(props.alarmTopic));
        }
    }
}
