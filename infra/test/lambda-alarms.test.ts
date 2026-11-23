import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { LambdaAlarms, durationAlarmShareOfTimeout } from '../lib/constructs/lambda-alarms';

/** A function that is not a `ServiceFunction`, because the alarms are meant to work on any function. */
function build(options: { withTopic: boolean; timeout?: Duration }) {
    const stack = new Stack(new App());
    const timeout = options.timeout ?? Duration.seconds(10);
    const fn = new LambdaFunction(stack, 'Fn', { runtime: Runtime.NODEJS_26_X, handler: 'index.handler', code: Code.fromInline('exports.handler = async () => {};'), timeout });
    const alarmTopic = options.withTopic ? new Topic(stack, 'Topic') : undefined;
    new LambdaAlarms(stack, 'Alarms', { function: fn, timeout, alarmTopic });
    return Template.fromStack(stack);
}

describe('LambdaAlarms', () => {
    const template = build({ withTopic: true });

    it('has an alarm for errors, throttles and duration, and no other', () => {
        template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
        for (const metric of ['Errors', 'Throttles', 'Duration']) {
            template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/Lambda', MetricName: metric });
        }
    });

    it.each(['Errors', 'Throttles'])('alarms on one %s in five minutes', (metric) => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            MetricName: metric,
            Statistic: 'Sum',
            Period: 300,
            Threshold: 1,
            EvaluationPeriods: 1,
            ComparisonOperator: 'GreaterThanOrEqualToThreshold'
        });
    });

    it('alarms when the p99 duration is close to the timeout, in two of three windows', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            MetricName: 'Duration',
            ExtendedStatistic: 'p99',
            Period: 300,
            Threshold: 10_000 * durationAlarmShareOfTimeout,
            EvaluationPeriods: 3,
            DatapointsToAlarm: 2
        });
    });

    it('follows the timeout it is given', () => {
        build({ withTopic: false, timeout: Duration.seconds(30) }).hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Duration', Threshold: 24_000 });
    });

    it('does not alarm for a window with no invocations', () => {
        for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
            expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
        }
    });

    it('notifies the alarm topic when it is given one', () => {
        const [topicId] = Object.keys(template.findResources('AWS::SNS::Topic'));
        for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
            expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicId }]);
        }
    });

    it('notifies nobody when it is not given a topic', () => {
        const alone = build({ withTopic: false });

        alone.resourceCountIs('AWS::CloudWatch::Alarm', 3);
        for (const alarm of Object.values(alone.findResources('AWS::CloudWatch::Alarm'))) {
            expect(alarm.Properties.AlarmActions).toBeUndefined();
        }
    });
});
