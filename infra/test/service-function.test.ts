import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { applyStandardTags } from '../lib/aspects/standard-tags';
import { stageNames, stages } from '../lib/config/stages';
import type { StageName } from '../lib/config/stages';
import { ServiceFunction } from '../lib/constructs/service-function';
import type { ServiceFunctionProps } from '../lib/constructs/service-function';
import { applyNag } from '../lib/nag';

const entry = 'infra/test/fixtures/handler.ts';

/** Bundling is skipped, because esbuild is slow and the template does not depend on it. One test below bundles for real. */
const newApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });

function build(stage: StageName, overrides: Partial<ServiceFunctionProps> = {}, grant?: (fn: ServiceFunction, stack: Stack) => void) {
    const stack = new Stack(newApp(), 'Demo');
    const fn = new ServiceFunction(stack, 'Hello', { config: stages[stage], service: 'Customers', entry, timeout: Duration.seconds(10), eventBusName: 'storefront-bus', ...overrides });
    grant?.(fn, stack);
    return Template.fromStack(stack);
}

interface Statement {
    Action: string | string[];
    Resource: unknown;
}

function statements(template: Template): Statement[] {
    return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) => policy.Properties.PolicyDocument.Statement as Statement[]);
}

const asList = (value: string | string[]) => (Array.isArray(value) ? value : [value]);

describe.each(stageNames)('ServiceFunction in %s', (stage) => {
    const config = stages[stage];
    const template = build(stage);

    it('runs on arm64 and a current Node.js, with a modest amount of memory', () => {
        template.hasResourceProperties('AWS::Lambda::Function', { Architectures: ['arm64'], Runtime: 'nodejs24.x', MemorySize: 256, Handler: 'index.handler' });
    });

    it('has X-Ray tracing on', () => {
        template.hasResourceProperties('AWS::Lambda::Function', { TracingConfig: { Mode: 'Active' } });
    });

    it('writes to a log group of its own, which keeps logs for the retention of the stage', () => {
        template.resourceCountIs('AWS::Logs::LogGroup', 1);
        template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: config.logRetention });
        template.hasResourceProperties('AWS::Lambda::Function', { LoggingConfig: { LogGroup: { Ref: Object.keys(template.findResources('AWS::Logs::LogGroup'))[0] } } });
    });

    it('keeps its logs in a persistent stage only', () => {
        for (const group of Object.values(template.findResources('AWS::Logs::LogGroup'))) {
            expect(group.DeletionPolicy).toBe(stage === 'prod' ? 'Retain' : 'Delete');
        }
    });

    it('has the standard environment variables', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            Environment: {
                Variables: {
                    STAGE: stage,
                    SERVICE_NAME: 'customers',
                    EVENT_BUS_NAME: 'storefront-bus',
                    POWERTOOLS_SERVICE_NAME: 'customers',
                    POWERTOOLS_LOG_LEVEL: 'INFO',
                    NODE_OPTIONS: '--enable-source-maps'
                }
            }
        });
    });

    it('has no alarm besides the three Lambda alarms', () => {
        template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    });

    it.each(['Errors', 'Throttles', 'Duration'])('has the %s alarm, on this function and no other', (metric) => {
        const [functionId] = Object.keys(template.findResources('AWS::Lambda::Function'));

        template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/Lambda', MetricName: metric, Dimensions: [{ Name: 'FunctionName', Value: { Ref: functionId } }] });
    });
});

describe('ServiceFunction props', () => {
    it('sets the timeout it is given, and the memory and log level it is asked for', () => {
        const template = build('dev', { timeout: Duration.seconds(25), memorySize: 512, logLevel: 'DEBUG' });

        template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 25, MemorySize: 512, Environment: { Variables: { POWERTOOLS_LOG_LEVEL: 'DEBUG' } } });
        template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Duration', Threshold: 20_000 });
    });

    it('exports the handler it is asked for, and handler by default', () => {
        build('dev', { handler: 'main' }).hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.main' });
        build('dev').hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler' });
    });

    it('adds the variables of the caller, which cannot replace a standard one', () => {
        const template = build('dev', { environment: { TABLE_NAME: 'orders', STAGE: 'prod', EVENT_BUS_NAME: 'other' } });

        template.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: { TABLE_NAME: 'orders', STAGE: 'dev', EVENT_BUS_NAME: 'storefront-bus' } } });
    });

    it('has no EVENT_BUS_NAME when it is not given the name of a bus', () => {
        const [fn] = Object.values(build('dev', { eventBusName: undefined }).findResources('AWS::Lambda::Function'));

        expect(fn!.Properties.Environment.Variables).toMatchObject({ STAGE: 'dev', SERVICE_NAME: 'customers' });
        expect(fn!.Properties.Environment.Variables).not.toHaveProperty('EVENT_BUS_NAME');
    });

    it('sends its alarms to the alarm topic it is given', () => {
        const template = build('dev', { alarmTopic: Topic.fromTopicArn(new Stack(newApp(), 'Other'), 'AlarmTopic', 'arn:aws:sns:us-west-2:111111111111:alarms') });

        for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
            expect(alarm.Properties.AlarmActions).toEqual(['arn:aws:sns:us-west-2:111111111111:alarms']);
        }
    });
});

describe('ServiceFunction tags', () => {
    it('has the standard tags on the function and its log group, from the tags of its stack', () => {
        const stack = new Stack(newApp(), 'Demo');
        applyStandardTags(stack, stages.dev, 'Customers');
        new ServiceFunction(stack, 'Hello', { config: stages.dev, service: 'Customers', entry, timeout: Duration.seconds(10), eventBusName: 'storefront-bus' });
        const template = Template.fromStack(stack);

        const tags = [
            { Key: 'owner', Value: stages.dev.owner },
            { Key: 'project', Value: 'storefront' },
            { Key: 'service', Value: 'Customers' },
            { Key: 'stage', Value: 'dev' }
        ];
        for (const type of ['AWS::Lambda::Function', 'AWS::Logs::LogGroup']) {
            template.hasResourceProperties(type, { Tags: tags });
        }
    });
});

describe('ServiceFunction permissions', () => {
    const grantAll = (fn: ServiceFunction, stack: Stack) => {
        new Secret(stack, 'Secret').grantRead(fn);
        new EventBus(stack, 'Bus').grantPutEventsTo(fn);
    };

    it('can write to its own log group and send traces, and nothing else, until it is granted more', () => {
        const all = statements(build('dev'));

        expect(all).toHaveLength(2);
        expect(all.map((statement) => asList(statement.Action))).toEqual([
            ['logs:CreateLogStream', 'logs:PutLogEvents'],
            ['xray:PutTraceSegments', 'xray:PutTelemetryRecords']
        ]);
    });

    it('produces no wildcard policy, except the resource of X-Ray, which has none', () => {
        const all = statements(build('dev', {}, grantAll));

        expect(all.length).toBeGreaterThan(2);
        for (const { Action, Resource } of all) {
            expect(asList(Action).filter((action) => action.includes('*'))).toEqual([]);
            if (Resource === '*') expect(asList(Action).every((action) => action.startsWith('xray:'))).toBe(true);
        }
        expect(all.filter(({ Resource }) => Resource === '*')).toHaveLength(1);
    });

    it('has a policy that names what it is granted, which a grant method gives', () => {
        const all = statements(build('dev', {}, grantAll));

        expect(all.some(({ Action }) => asList(Action).includes('secretsmanager:GetSecretValue'))).toBe(true);
        expect(all.some(({ Action }) => asList(Action).includes('events:PutEvents'))).toBe(true);
    });

    it('does not use the AWS managed policy for Lambda, which allows every log group', () => {
        expect(JSON.stringify(build('dev').findResources('AWS::IAM::Role'))).not.toContain('AWSLambdaBasicExecutionRole');
    });
});

describe('ServiceFunction and cdk-nag', () => {
    it.each(stageNames)(
        'passes the AWS Solutions rules in %s, with no acknowledgement from the stack',
        (stage) => {
            const app = newApp();
            const stack = new Stack(app, 'Demo');
            const alarmTopic = Topic.fromTopicArn(stack, 'AlarmTopic', 'arn:aws:sns:us-west-2:111111111111:alarms');
            new ServiceFunction(stack, 'Hello', { config: stages[stage], service: 'Customers', entry, timeout: Duration.seconds(10), eventBusName: 'storefront-bus', alarmTopic });
            applyNag(app, []);

            expect(() => app.synth()).not.toThrow();
        },
        30000
    );
});

describe('ServiceFunction bundling', () => {
    it('bundles the handler with esbuild and writes a source map next to it', () => {
        const app = new App();
        new ServiceFunction(new Stack(app, 'Demo'), 'Hello', { config: stages.dev, service: 'Customers', entry, timeout: Duration.seconds(10), eventBusName: 'storefront-bus' });
        const { directory } = app.synth();

        const bundles = readdirSync(directory).filter((name) => name.startsWith('asset.') && existsSync(join(directory, name, 'index.js')));
        expect(bundles).toHaveLength(1);
        expect(existsSync(join(directory, bundles[0]!, 'index.js.map'))).toBe(true);
    }, 60000);
});
