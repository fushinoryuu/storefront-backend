import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { describe, expect, it } from 'vitest';
import { applyStandardTags } from '../lib/aspects/standard-tags';
import { stageNames, stages } from '../lib/config/stages';
import type { StageName } from '../lib/config/stages';
import { ServiceApi, defaultApiVersion } from '../lib/constructs/service-api';
import type { ServiceApiProps } from '../lib/constructs/service-api';
import { ServiceFunction } from '../lib/constructs/service-function';
import { apiKeyIdParameterName, apiKeyKinds, ssmParameterName } from '../lib/naming';
import { applyNag } from '../lib/nag';

const entry = 'infra/test/fixtures/handler.ts';
const specVersions = { v0: '0.2.0', v1: '0.3.0', v2: '0.1.0' };

/** Bundling is skipped, because esbuild is slow and the template does not depend on it. */
const newApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });

/**
 * A stack with one function and one API with a few routes, the way a service stack uses them. It does not synthesize, so cdk-nag can still be added to the app.
 * A REST API with no method does not synthesize, so the API always has the routes of `routes`.
 */
function build(stage: StageName, options: { overrides?: Partial<ServiceApiProps>; tags?: boolean; app?: App; routes?: (api: ServiceApi, handler: ServiceFunction) => void } = {}) {
    const stack = new Stack(options.app ?? newApp(), 'Demo');
    if (options.tags) applyStandardTags(stack, stages[stage], 'Customers');
    const config = stages[stage];
    const eventBus = new EventBus(stack, 'Bus');
    const handler = new ServiceFunction(stack, 'GetCustomer', { config, service: 'Customers', entry, timeout: Duration.seconds(10), eventBusName: eventBus.eventBusName });
    const serviceApi = new ServiceApi(stack, 'Api', { config, service: 'Customers', specVersions, ...options.overrides });
    (options.routes ?? ((api, fn) => api.addRoute('GET', '/customers/{customerId}', fn)))(serviceApi, handler);
    return { stack, serviceApi, handler };
}

/** The same, with its template, which synthesizes the stack. */
function setup(stage: StageName, options: Parameters<typeof build>[1] = {}) {
    const built = build(stage, options);
    return { ...built, template: Template.fromStack(built.stack) };
}

/** The `PathPart`s from the root to the resource, as one path: `/v1/customers/{customerId}`. */
function pathsOf(template: Template): string[] {
    const resources = template.findResources('AWS::ApiGateway::Resource');
    const pathOf = (id: string): string => {
        const { PathPart, ParentId } = resources[id]!.Properties as { PathPart: string; ParentId: { Ref?: string } };
        return `${ParentId.Ref !== undefined && resources[ParentId.Ref] ? pathOf(ParentId.Ref) : ''}/${PathPart}`;
    };
    return Object.keys(resources).map(pathOf);
}

const accessLogGroupId = (template: Template) => Object.keys(template.findResources('AWS::Logs::LogGroup')).find((id) => id.includes('AccessLogs'))!;

interface Statement {
    Effect: string;
    Action: string | string[];
    Resource?: unknown;
}

describe.each(stageNames)('ServiceApi in %s', (stage) => {
    const config = stages[stage];
    const { template, serviceApi } = setup(stage);

    it('is one Regional REST API, which is not left to the default of the CDK', () => {
        template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
        template.hasResourceProperties('AWS::ApiGateway::RestApi', { Name: `Storefront-${stage}-Customers`, EndpointConfiguration: { Types: ['REGIONAL'] } });
    });

    it('has one stage, named after the deployment stage, with low default throttling for every method', () => {
        template.resourceCountIs('AWS::ApiGateway::Stage', 1);
        template.hasResourceProperties('AWS::ApiGateway::Stage', {
            StageName: stage,
            MethodSettings: [{ HttpMethod: '*', ResourcePath: '/*', ThrottlingRateLimit: config.api.defaultThrottle.rateLimit, ThrottlingBurstLimit: config.api.defaultThrottle.burstLimit }]
        });
    });

    it('logs every request to a log group that keeps logs for the retention of the stage', () => {
        const groupId = accessLogGroupId(template);
        expect(template.findResources('AWS::Logs::LogGroup')[groupId]!.Properties.RetentionInDays).toBe(config.logRetention);
        template.hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: { DestinationArn: { 'Fn::GetAtt': [groupId, 'Arn'] }, Format: Match.stringLikeRegexp('^\\{') } });
    });

    it('logs the declared route and not the real path, so no id reaches the logs', () => {
        const stageResource = Object.values(template.findResources('AWS::ApiGateway::Stage'))[0]!;
        const format = stageResource.Properties.AccessLogSetting.Format as string;
        const line = JSON.parse(format) as Record<string, string>;

        expect(line.resourcePath).toBe('$context.resourcePath');
        expect(line.apiKeyId).toBe('$context.identity.apiKeyId');
        expect(format).not.toContain('$context.path');
    });

    it('keeps the access logs in a persistent stage only', () => {
        expect(template.findResources('AWS::Logs::LogGroup')[accessLogGroupId(template)]!.DeletionPolicy).toBe(stage === 'prod' ? 'Retain' : 'Delete');
    });

    it('requires an API key on every method', () => {
        const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));

        expect(methods).toHaveLength(1);
        for (const method of methods) expect(method.Properties.ApiKeyRequired).toBe(true);
    });

    it('puts a route under /v1 by default, with the path as given', () => {
        expect(pathsOf(template)).toEqual(expect.arrayContaining(['/v1', '/v1/customers', '/v1/customers/{customerId}']));
        expect(defaultApiVersion).toBe('v1');
    });

    it('has a usage plan for each kind of key, with its throttle and daily quota, attached to the stage', () => {
        template.resourceCountIs('AWS::ApiGateway::UsagePlan', apiKeyKinds.length);
        for (const kind of apiKeyKinds) {
            const { rateLimit, burstLimit, quotaPerDay } = config.api.usagePlans[kind];
            template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
                UsagePlanName: `Storefront-${stage}-Customers-${kind}`,
                Throttle: { RateLimit: rateLimit, BurstLimit: burstLimit },
                Quota: { Limit: quotaPerDay, Period: 'DAY' },
                ApiStages: [{ ApiId: { Ref: Object.keys(template.findResources('AWS::ApiGateway::RestApi'))[0] }, Stage: { Ref: Object.keys(template.findResources('AWS::ApiGateway::Stage'))[0] } }]
            });
        }
    });

    it('attaches the keys of the platform stack to the plans, by the ids that it publishes to SSM', () => {
        template.resourceCountIs('AWS::ApiGateway::UsagePlanKey', apiKeyKinds.length);
        template.resourceCountIs('AWS::ApiGateway::ApiKey', 0);
        const parameters = Object.entries(template.toJSON().Parameters as Record<string, { Type: string; Default: string }>).filter(([name]) => name !== 'BootstrapVersion');

        expect(parameters.every(([, parameter]) => parameter.Type === 'AWS::SSM::Parameter::Value<String>')).toBe(true);
        expect(parameters.map(([, parameter]) => parameter.Default).sort()).toEqual(apiKeyKinds.map((kind) => apiKeyIdParameterName(config, kind)).sort());
        // Every plan holds a key by its id, which is the value of one of those parameters. No value of a key is in the template.
        for (const key of Object.values(template.findResources('AWS::ApiGateway::UsagePlanKey'))) {
            expect(key.Properties.KeyType).toBe('API_KEY');
            expect(parameters.map(([name]) => name)).toContain((key.Properties.KeyId as { Ref: string }).Ref);
        }
    });

    it('publishes its base URL to SSM, with the stage and no trailing slash', () => {
        template.hasResourceProperties('AWS::SSM::Parameter', { Name: ssmParameterName(config, 'Customers', 'base-url'), Type: 'String' });
        const parameter = Object.values(template.findResources('AWS::SSM::Parameter')).find((resource) => resource.Properties.Name === ssmParameterName(config, 'Customers', 'base-url'))!;
        const [separator, parts] = parameter.Properties.Value['Fn::Join'] as [string, unknown[]];

        expect(separator).toBe('');
        expect(parts[0]).toBe('https://');
        expect(parts.at(-1)).toBe(`/${stage}`);
        expect(JSON.stringify(parts)).toContain('execute-api');
    });

    it('does not create the account-wide role for access logs, which has a stack of its own', () => {
        template.resourceCountIs('AWS::ApiGateway::Account', 0);
        template.resourceCountIs('AWS::IAM::Role', 1); // the role of the function
    });

    it('lets this API invoke the function, on its stage and for the method it is added to only', () => {
        const permissions = Object.values(template.findResources('AWS::Lambda::Permission'));

        expect(permissions).toHaveLength(1); // no second one for the test button of the console
        expect(permissions[0]!.Properties.Principal).toBe('apigateway.amazonaws.com');
        expect(permissions[0]!.Properties.Action).toBe('lambda:InvokeFunction');
        const source = JSON.stringify(permissions[0]!.Properties.SourceArn);
        expect(source).toContain(Object.keys(template.findResources('AWS::ApiGateway::RestApi'))[0]);
        expect(source).toContain(Object.keys(template.findResources('AWS::ApiGateway::Stage'))[0]);
        expect(source).toContain('/GET/v1/customers/*'); // CDK writes a path parameter as a wildcard in the source ARN
    });

    it('adds no wildcard action to any policy', () => {
        const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) => policy.Properties.PolicyDocument.Statement as Statement[]);
        const actions = statements.flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]));

        expect(actions.filter((action) => action === '*' || action.endsWith(':*'))).toEqual([]);
    });

    it('exposes the pieces for other constructs', () => {
        expect(serviceApi.usagePlans.tests).toBeDefined();
        expect(Object.keys(serviceApi.usagePlans).sort()).toEqual(['admin', 'services', 'tests']);
    });
});

describe('ServiceApi versions', () => {
    it('serves /v1 and /v2 routes side by side under one API', () => {
        const { template } = setup('dev', {
            routes: (api, fn) => {
                api.addRoute('GET', '/customers/{customerId}', fn);
                api.addRoute('GET', '/customers/{customerId}', fn, { version: 'v2' });
                api.addRoute('POST', '/customers', fn, { version: 'v2' });
            }
        });

        template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
        expect(pathsOf(template)).toEqual(expect.arrayContaining(['/v1/customers/{customerId}', '/v2/customers/{customerId}', '/v2/customers']));
        const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
        expect(methods).toHaveLength(3);
        for (const method of methods) expect(method.Properties.ApiKeyRequired).toBe(true);
    });

    it('refuses a version that the API does not serve', () => {
        expect(() => build('dev', { routes: (api, fn) => api.addRoute('GET', '/customers', fn, { version: 'v3' }) })).toThrow(/serves v0, v1, v2 and not v3/);
    });

    it('refuses v0, which is for the operational routes, even though it is one of the spec versions', () => {
        expect(() => build('dev', { routes: (api, fn) => api.addRoute('GET', '/health', fn, { version: 'v0' }) })).toThrow(/operational routes/);
    });

    it('refuses a path that has no leading slash, names no resource, or starts with a version', () => {
        for (const path of ['customers', '/']) {
            expect(() => build('dev', { routes: (api, fn) => api.addRoute('GET', path, fn) })).toThrow(/must start with/);
        }
        for (const path of ['/v1/customers', '/v2']) {
            expect(() => build('dev', { routes: (api, fn) => api.addRoute('GET', path, fn) })).toThrow(/starts with a version/);
        }
    });

    it('accepts a resource that merely begins with the letter v', () => {
        const { template } = setup('dev', { routes: (api, fn) => api.addRoute('GET', '/vendors', fn) });

        expect(pathsOf(template)).toContain('/v1/vendors');
    });

    it('needs at least one spec version, and each one must be a prefix like v1', () => {
        expect(() => build('dev', { overrides: { specVersions: {} } })).toThrow(/at least one spec/);
        expect(() => build('dev', { overrides: { specVersions: { one: '1.0.0' } } })).toThrow(/must look like v1/);
    });
});

describe('ServiceApi tags', () => {
    it('has the standard tags on the API, its stage, its usage plans and its log group, from the tags of its stack', () => {
        const { template } = setup('dev', { tags: true });
        const tags = [
            { Key: 'owner', Value: stages.dev.owner },
            { Key: 'project', Value: 'storefront' },
            { Key: 'service', Value: 'Customers' },
            { Key: 'stage', Value: 'dev' }
        ];

        for (const type of ['AWS::ApiGateway::RestApi', 'AWS::ApiGateway::Stage', 'AWS::ApiGateway::UsagePlan', 'AWS::Logs::LogGroup']) {
            for (const resource of Object.values(template.findResources(type))) {
                expect(resource.Properties.Tags, type).toEqual(expect.arrayContaining(tags));
            }
        }
    });
});

describe('ServiceApi and cdk-nag', () => {
    // The app is not synthesized before cdk-nag is added: a synthesized app would skip the validation, and this test would pass without checking anything.
    it.each(stageNames)('passes the AWS Solutions rules in %s with no acknowledgement from the stack', (stage) => {
        const app = newApp();
        build(stage, { app });
        applyNag(app, []);

        expect(() => app.synth()).not.toThrow();
    });
});
