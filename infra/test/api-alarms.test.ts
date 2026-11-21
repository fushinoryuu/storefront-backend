import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Deployment, MockIntegration, RestApi, Stage } from 'aws-cdk-lib/aws-apigateway';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { ApiAlarms, clientErrorAlarmThreshold, latencyAlarmThreshold } from '../lib/constructs/api-alarms';

const alarmTopicArn = 'arn:aws:sns:us-west-2:111111111111:alarms';

/** An API that is not a `ServiceApi`, because the alarms are meant to work on any stage. A REST API with no method does not synthesize, so it has one. */
function build() {
    const stack = new Stack(new App());
    const api = new RestApi(stack, 'Api', { deploy: false, cloudWatchRole: false });
    api.root.addMethod('GET', new MockIntegration());
    const stage = new Stage(stack, 'Stage', { deployment: new Deployment(stack, 'Deployment', { api }), stageName: 'dev' });
    new ApiAlarms(stack, 'Alarms', { stage, alarmTopic: Topic.fromTopicArn(stack, 'AlarmTopic', alarmTopicArn) });
    return Template.fromStack(stack);
}

describe('ApiAlarms', () => {
    const template = build();
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));

    it('has an alarm for 5xx, 4xx and latency of the stage, and no other', () => {
        expect(alarms).toHaveLength(3);
        for (const metric of ['5XXError', '4XXError', 'Latency']) {
            template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/ApiGateway', MetricName: metric, Dimensions: Match.arrayWith([Match.objectLike({ Name: 'Stage' })]) });
        }
    });

    it('alarms on one 5xx in five minutes', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: '5XXError', Statistic: 'Sum', Period: 300, Threshold: 1, EvaluationPeriods: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold' });
    });

    it('alarms on a run of 4xx, in two of three windows, so one bad request does not', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: '4XXError', Statistic: 'Sum', Period: 300, Threshold: clientErrorAlarmThreshold, EvaluationPeriods: 3, DatapointsToAlarm: 2 });
        expect(clientErrorAlarmThreshold).toBeGreaterThan(1);
    });

    it('alarms when the p95 latency is slow, in two of three windows', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Latency', ExtendedStatistic: 'p95', Period: 300, Threshold: latencyAlarmThreshold.toMilliseconds(), EvaluationPeriods: 3, DatapointsToAlarm: 2 });
        expect(latencyAlarmThreshold.toSeconds()).toBeLessThan(29); // the integration timeout of decision 0003
    });

    it('does not alarm for a window with no requests', () => {
        for (const alarm of alarms) expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
    });

    it('notifies the alarm topic, and only it', () => {
        for (const alarm of alarms) expect(alarm.Properties.AlarmActions).toEqual([alarmTopicArn]);
    });
});
