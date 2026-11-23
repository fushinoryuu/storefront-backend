import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { zProblem } from '../../generated/customers-service-v0/zod.gen';
import { applyStandardTags } from '../lib/aspects/standard-tags';
import { stageNames, stages } from '../lib/config/stages';
import type { StageName } from '../lib/config/stages';
import { ServiceApi, defaultApiVersion } from '../lib/constructs/service-api';
import type { ServiceApiProps } from '../lib/constructs/service-api';
import { ServiceFunction } from '../lib/constructs/service-function';
import { apiKeyIdParameterName, apiKeyKinds, ssmParameterName } from '../lib/naming';
import type { ApiKeyKind } from '../lib/naming';
import { applyNag } from '../lib/nag';

const entry = 'infra/test/fixtures/handler.ts';
const specVersions = { v0: '0.2.0', v1: '0.3.0', v2: '0.1.0' };
const buildId = 'abc1234';
const alarmTopicArn = 'arn:aws:sns:us-west-2:111111111111:alarms';

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
    const alarmTopic = Topic.fromTopicArn(stack, 'AlarmTopic', alarmTopicArn);
    const handler = new ServiceFunction(stack, 'GetCustomer', { config, service: 'Customers', entry, timeout: Duration.seconds(10), eventBusName: eventBus.eventBusName, alarmTopic });
    const serviceApi = new ServiceApi(stack, 'Api', { config, service: 'Customers', specVersions, keyKinds: apiKeyKinds, alarmTopic, buildId, ...options.overrides });
    (options.routes ?? ((api, fn) => api.addRoute('GET', '/customers/{customerId}', fn)))(serviceApi, handler);
    return { stack, serviceApi, handler };
}

/** The same, with its template, which synthesizes the stack. */
function setup(stage: StageName, options: Parameters<typeof build>[1] = {}) {
    const built = build(stage, options);
    return { ...built, template: Template.fromStack(built.stack) };
}

/** The `PathPart`s from the root to the resource, as one path: `/v1/customers/{customerId}`. */
function pathOf(resources: ReturnType<Template['findResources']>, id: string): string {
    const { PathPart, ParentId } = resources[id]!.Properties as { PathPart: string; ParentId: { Ref?: string } };
    return `${ParentId.Ref !== undefined && resources[ParentId.Ref] ? pathOf(resources, ParentId.Ref) : ''}/${PathPart}`;
}

function pathsOf(template: Template): string[] {
    const resources = template.findResources('AWS::ApiGateway::Resource');
    return Object.keys(resources).map((id) => pathOf(resources, id));
}

/** Every method, as `GET /v1/customers/{customerId}`, with whether it requires an API key. */
function methodsOf(template: Template): Record<string, boolean> {
    const resources = template.findResources('AWS::ApiGateway::Resource');
    return Object.fromEntries(Object.values(template.findResources('AWS::ApiGateway::Method')).map(({ Properties }) => [`${Properties.HttpMethod} ${pathOf(resources, (Properties.ResourceId as { Ref: string }).Ref)}`, Properties.ApiKeyRequired === true]));
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

    it('requires an API key on every method, except GET /v0/health and GET /v0/version, which are the only two without one', () => {
        expect(methodsOf(template)).toEqual({ 'GET /v0/health': false, 'GET /v0/version': false, 'GET /v1/customers/{customerId}': true });
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
        template.resourceCountIs('AWS::IAM::Role', 2); // the roles of the two functions, the route and the operational routes
    });

    it('lets this API invoke each function, on its stage and for the methods it is added to only', () => {
        const permissions = Object.values(template.findResources('AWS::Lambda::Permission'));

        expect(permissions).toHaveLength(3); // one for each method, and none for the test button of the console
        const sources = permissions.map((permission) => JSON.stringify(permission.Properties.SourceArn));
        for (const permission of permissions) {
            expect(permission.Properties.Principal).toBe('apigateway.amazonaws.com');
            expect(permission.Properties.Action).toBe('lambda:InvokeFunction');
        }
        for (const source of sources) {
            expect(source).toContain(Object.keys(template.findResources('AWS::ApiGateway::RestApi'))[0]);
            expect(source).toContain(Object.keys(template.findResources('AWS::ApiGateway::Stage'))[0]);
        }
        // CDK writes a path parameter as a wildcard in the source ARN
        for (const method of ['/GET/v1/customers/*', '/GET/v0/health', '/GET/v0/version']) expect(sources.filter((source) => source.includes(method))).toHaveLength(1);
    });

    it('adds no wildcard action to any policy', () => {
        const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) => policy.Properties.PolicyDocument.Statement as Statement[]);
        const actions = statements.flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]));

        expect(actions.filter((action) => action === '*' || action.endsWith(':*'))).toEqual([]);
    });

    it('has the 5xx, 4xx and latency alarms of its stage, which notify the alarm topic', () => {
        const stageId = Object.keys(template.findResources('AWS::ApiGateway::Stage'))[0];
        const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(({ Properties }) => Properties.Namespace === 'AWS/ApiGateway');

        expect(alarms.map(({ Properties }) => Properties.MetricName).sort()).toEqual(['4XXError', '5XXError', 'Latency']);
        for (const { Properties } of alarms) {
            expect(Properties.Dimensions).toEqual(expect.arrayContaining([{ Name: 'Stage', Value: { Ref: stageId } }]));
            expect(Properties.AlarmActions).toEqual([alarmTopicArn]);
        }
    });

    it('notifies the alarm topic from every alarm it makes, including those of the functions', () => {
        const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));

        expect(alarms).toHaveLength(9); // three each for the function of the route, the function of health and version, and the API
        for (const { Properties } of alarms) expect(Properties.AlarmActions).toEqual([alarmTopicArn]);
    });

    it('requires the alarm topic (checked by the compiler: an optional prop would also allow undefined)', () => {
        expectTypeOf<ServiceApiProps['alarmTopic']>().toEqualTypeOf<ITopic>();
    });

    it('exposes the pieces for other constructs', () => {
        expect(serviceApi.usagePlans.tests).toBeDefined();
        expect(Object.keys(serviceApi.usagePlans).sort()).toEqual(['admin', 'services', 'tests']);
        expect(serviceApi.alarms.serverErrors).toBeDefined();
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
        expect(methodsOf(template)).toEqual({
            'GET /v0/health': false,
            'GET /v0/version': false,
            'GET /v1/customers/{customerId}': true,
            'GET /v2/customers/{customerId}': true,
            'POST /v2/customers': true
        });
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

describe('ServiceApi key kinds', () => {
    it.each(stageNames)('makes a plan and attaches a key only for the kinds the service accepts, in %s', (stage) => {
        const config = stages[stage];
        const { template, serviceApi } = setup(stage, { overrides: { keyKinds: ['tests', 'services'] } });
        const plans = Object.values(template.findResources('AWS::ApiGateway::UsagePlan')).map((plan) => plan.Properties.UsagePlanName as string);
        const parameters = Object.entries(template.toJSON().Parameters as Record<string, { Default: string }>)
            .filter(([name]) => name !== 'BootstrapVersion')
            .map(([, parameter]) => parameter.Default);

        expect(plans.sort()).toEqual([`Storefront-${stage}-Customers-services`, `Storefront-${stage}-Customers-tests`]);
        template.resourceCountIs('AWS::ApiGateway::UsagePlanKey', 2);
        // The id of the admin key is not read at all, so the stack does not depend on it.
        expect(parameters.sort()).toEqual([apiKeyIdParameterName(config, 'services'), apiKeyIdParameterName(config, 'tests')].sort());
        expect(Object.keys(serviceApi.usagePlans).sort()).toEqual(['services', 'tests']);
        expect(serviceApi.usagePlans.admin).toBeUndefined();
    });

    it('makes three plans when the service accepts all three kinds', () => {
        const { template, serviceApi } = setup('dev', { overrides: { keyKinds: ['admin', 'services', 'tests'] } });

        template.resourceCountIs('AWS::ApiGateway::UsagePlan', 3);
        template.resourceCountIs('AWS::ApiGateway::UsagePlanKey', 3);
        expect(Object.keys(serviceApi.usagePlans).sort()).toEqual(['admin', 'services', 'tests']);
    });

    it('keeps the limits of each kind from the stage config', () => {
        const { template } = setup('prod', { overrides: { keyKinds: ['services'] } });
        const { rateLimit, burstLimit, quotaPerDay } = stages.prod.api.usagePlans.services;

        template.hasResourceProperties('AWS::ApiGateway::UsagePlan', { Throttle: { RateLimit: rateLimit, BurstLimit: burstLimit }, Quota: { Limit: quotaPerDay, Period: 'DAY' } });
    });

    it('refuses an empty list, an unknown kind and a kind listed twice', () => {
        expect(() => build('dev', { overrides: { keyKinds: [] } })).toThrow(/at least one kind/);
        expect(() => build('dev', { overrides: { keyKinds: ['tests', 'root' as never] } })).toThrow(/"root" is not one of tests, services, admin/);
        expect(() => build('dev', { overrides: { keyKinds: ['tests', 'services', 'tests'] } })).toThrow(/"tests" is listed twice/);
    });

    it('passes cdk-nag with two kinds', () => {
        const app = newApp();
        build('dev', { app, overrides: { keyKinds: ['tests', 'services'] } });
        applyNag(app, []);

        expect(() => app.synth()).not.toThrow();
    });
});

describe('ServiceApi operational routes', () => {
    afterEach(() => vi.unstubAllEnvs());

    /** The function that answers them: the one with a build id. */
    const operationsFunction = (template: Template) => Object.entries(template.findResources('AWS::Lambda::Function')).find(([, fn]) => fn.Properties.Environment?.Variables?.BUILD_ID !== undefined)!;

    it.each(stageNames)('answers GET /v0/health and GET /v0/version with one function, which has the build id, the stage and the spec versions in %s', (stage) => {
        const { template } = setup(stage);
        const [id, fn] = operationsFunction(template);

        template.resourceCountIs('AWS::Lambda::Function', 2); // that one, and the one of the route
        expect(fn.Properties.Environment.Variables).toMatchObject({ STAGE: stage, BUILD_ID: buildId, SPEC_VERSIONS: JSON.stringify(specVersions) });
        expect(fn.Properties.Environment.Variables).not.toHaveProperty('EVENT_BUS_NAME');
        const integrations = Object.values(template.findResources('AWS::ApiGateway::Method')).filter(({ Properties }) => Properties.ApiKeyRequired !== true);
        expect(integrations).toHaveLength(2);
        for (const { Properties } of integrations) expect(JSON.stringify(Properties.Integration.Uri)).toContain(id);
    });

    it('has the alarms, the log group and the role of every ServiceFunction, and no wildcard beyond the resource of X-Ray', () => {
        const { template } = setup('dev');
        const [id] = operationsFunction(template);
        const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(({ Properties }) => JSON.stringify(Properties.Dimensions).includes(id));
        const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) => JSON.stringify(policy.Properties.Roles).includes('OperationsRole'));

        expect(alarms).toHaveLength(3);
        for (const { Properties } of alarms) expect(Properties.AlarmActions).toEqual([alarmTopicArn]);
        expect(policies).toHaveLength(1);
        for (const { Action, Resource } of policies[0]!.Properties.PolicyDocument.Statement as Statement[]) {
            const actions = Array.isArray(Action) ? Action : [Action];
            expect(actions.filter((action) => action === '*' || action.endsWith(':*'))).toEqual([]);
            if (Resource === '*') expect(actions.every((action) => action.startsWith('xray:'))).toBe(true);
        }
    });

    it('takes the build id from resolveBuildId when the stack does not give one', () => {
        vi.stubEnv('BUILD_ID', 'from-the-environment');
        const { template } = setup('dev', { overrides: { buildId: undefined } });

        expect(operationsFunction(template)[1].Properties.Environment.Variables.BUILD_ID).toBe('from-the-environment');
    });

    it('lists every version of the API, however many there are', () => {
        const { template } = setup('dev', { overrides: { specVersions: { v0: '0.2.0', v1: '1.0.0' } } });

        expect(JSON.parse(operationsFunction(template)[1].Properties.Environment.Variables.SPEC_VERSIONS)).toEqual({ v0: '0.2.0', v1: '1.0.0' });
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

describe('ServiceApi gateway responses', () => {
    // What API Gateway answers by itself, and what the shared spec says each answer is (specs/shared/components.yaml). Written out here, so a change in `gatewayResponses` shows up as a failure.
    const expected: [string, number, string][] = [
        ['INVALID_API_KEY', 403, 'forbidden'],
        ['THROTTLED', 429, 'too-many-requests'],
        ['QUOTA_EXCEEDED', 429, 'too-many-requests'],
        ['MISSING_AUTHENTICATION_TOKEN', 404, 'not-found'],
        ['INTEGRATION_TIMEOUT', 503, 'service-unavailable'],
        ['INTEGRATION_FAILURE', 503, 'service-unavailable'],
        ['DEFAULT_5XX', 500, 'internal-error']
    ];
    const { template } = setup('dev');
    const responses = Object.values(template.findResources('AWS::ApiGateway::GatewayResponse')).map((resource) => resource.Properties as GatewayResponseProperties);
    const sampleRequestId = '6f0d6b1c-0c46-4d4c-b0b5-0c8d1f3f8f11';

    interface GatewayResponseProperties {
        ResponseType: string;
        StatusCode: string;
        ResponseParameters: Record<string, string>;
        ResponseTemplates: Record<string, string>;
    }

    it('has exactly these responses, once each', () => {
        expect(responses.map((response) => response.ResponseType).sort()).toEqual(expected.map(([type]) => type).sort());
    });

    it.each(expected)('answers %s with %i and a body that is a Problem of kind %s, whose correlation id is the request id of the gateway', (type, status, slug) => {
        const response = responses.find((candidate) => candidate.ResponseType === type)!;
        const template = response.ResponseTemplates['application/json']!;
        // API Gateway replaces the variable with the request id before it answers, so the test does the same.
        const body = JSON.parse(template.replaceAll('$context.requestId', sampleRequestId)) as unknown;

        expect(response.StatusCode).toBe(String(status));
        expect(template).toContain('"correlationId":"$context.requestId"');
        expect(zProblem.parse(body)).toMatchObject({ type: `https://storefront.example/problems/${slug}`, status, correlationId: sampleRequestId });
    });

    it('gives the correlation id header the same value as the body, on every response', () => {
        for (const response of responses) expect(response.ResponseParameters['gatewayresponse.header.x-correlation-id'], response.ResponseType).toBe('context.requestId');
    });

    it('tells the caller when to try again after a 503, and after no other response', () => {
        for (const response of responses) {
            const retryAfter = response.ResponseParameters['gatewayresponse.header.retry-after'];
            if (response.StatusCode === '503') expect(retryAfter, response.ResponseType).toBe("'5'");
            else expect(retryAfter, response.ResponseType).toBeUndefined();
        }
    });

    it('gives the 500 and the 403 no detail that shows how the service works inside, only the spec wording', () => {
        const detailOf = (type: string) => (JSON.parse(responses.find((candidate) => candidate.ResponseType === type)!.ResponseTemplates['application/json']!.replaceAll('$context.requestId', 'id')) as { detail?: string }).detail;

        expect(detailOf('DEFAULT_5XX')).toBeUndefined(); // as the InternalError response of the shared spec
        expect(detailOf('INVALID_API_KEY')).toBe('The API key is missing or not allowed.');
    });

    it('is the same in prod', () => {
        const prod = Object.values(setup('prod').template.findResources('AWS::ApiGateway::GatewayResponse')).map((resource) => resource.Properties);

        expect(prod).toEqual(responses);
    });
});

describe('ServiceApi adminOnly routes', () => {
    const adminRoute = (api: ServiceApi, fn: ServiceFunction) => api.addRoute('POST', '/shipments/{shipmentId}/advance', fn, { adminOnly: true });

    it('adds the route when the API accepts the admin key, and the route still needs an API key', () => {
        const { template } = setup('dev', { routes: adminRoute });

        expect(methodsOf(template)['POST /v1/shipments/{shipmentId}/advance']).toBe(true);
    });

    it('is refused when the API does not accept the admin key, and added when it does', () => {
        const attempt = (keyKinds: readonly ApiKeyKind[]) => () => build('dev', { overrides: { keyKinds }, routes: adminRoute });

        expect(attempt(['tests', 'services'])).toThrow(/does not accept the admin key/);
        expect(attempt(['tests'])).toThrow(/does not accept the admin key/);
        expect(attempt(['admin'])).not.toThrow();
        expect(attempt(['tests', 'services', 'admin'])).not.toThrow();
    });

    it('leaves a route without the flag as it was, whether the flag is absent or false', () => {
        const plain = (api: ServiceApi, fn: ServiceFunction) => api.addRoute('POST', '/customers', fn);
        const withFalse = (api: ServiceApi, fn: ServiceFunction) => api.addRoute('POST', '/customers', fn, { adminOnly: false });

        expect(setup('dev', { routes: withFalse }).template.toJSON()).toEqual(setup('dev', { routes: plain }).template.toJSON());
    });

    it('lets a route without the flag be added to an API that does not accept the admin key', () => {
        expect(() => build('dev', { overrides: { keyKinds: ['tests'] }, routes: (api, fn) => api.addRoute('GET', '/customers', fn) })).not.toThrow();
    });
});
