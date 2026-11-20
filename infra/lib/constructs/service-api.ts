import { Aws, Fn, Validations } from 'aws-cdk-lib';
import { AccessLogField, AccessLogFormat, ApiKey, EndpointType, LambdaIntegration, LogGroupLogDestination, Period, RestApi } from 'aws-cdk-lib/aws-apigateway';
import type { Method, UsagePlan } from 'aws-cdk-lib/aws-apigateway';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import type { ServiceName, StageConfig } from '../config/stages';
import { apiKeyIdParameterName, apiKeyKinds, ssmParameterName, stackName } from '../naming';
import type { ApiKeyKind } from '../naming';
import { removalPolicyFor } from '../removal-policy';

/** The services that expose an API. The platform and the database do not. */
export type ApiServiceName = Exclude<ServiceName, 'Platform' | 'Database'>;

export const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof httpMethods)[number];

/** The version that routes get when the caller does not say. */
export const defaultApiVersion = 'v1';

/** The prefix of the operational routes (health and version), which `ServiceApi` adds itself, so a route of a service cannot use it. */
export const operationalApiVersion = 'v0';

export interface ServiceApiProps {
    readonly config: StageConfig;
    readonly service: ApiServiceName;
    /**
     * The kinds of API key that this service accepts, for example `['tests', 'services']`. There is no default, so a service always says which callers it serves.
     * The API gets a usage plan for each kind, and the platform key of that kind is attached to it. A key of a kind that is not listed is refused at the gateway.
     * A service that checks the `admin` key in a handler must list `admin`, or the handler never sees that key.
     */
    readonly keyKinds: readonly ApiKeyKind[];
    /**
     * The `info.version` of every spec the API serves, keyed by prefix: `{ v0: '0.2.0', v1: '0.3.0' }`.
     * It is the list of versions that `addRoute` accepts, and what `GET /v0/version` reports.
     */
    readonly specVersions: Readonly<Record<string, string>>;
}

export interface AddRouteOptions {
    /** The prefix the route goes under, `v1` or `v2`. Defaults to `v1`. It must be one of the `specVersions` of the API. */
    readonly version?: string;
}

/**
 * The REST API of a service: a Regional endpoint with one stage, named after the deployment stage, and a usage plan for each kind of key the service accepts (`keyKinds`).
 * Routes are added with `addRoute`, which puts the route under `/v<N>` and requires an API key.
 *
 * It sets what every service API needs, so a stack only says what is different about its own:
 * - The endpoint is Regional, set explicitly. An edge-optimized API cannot raise the 29 second integration timeout that decision 0003 relies on, and the CDK default may be edge-optimized.
 * - The stage throttles every method (`api.defaultThrottle` of the stage config). One usage plan per accepted kind of key (`tests`, `services`, `admin`) carries the throttle and the daily quota of that caller type.
 *   Only the keys of the kinds in `keyKinds` are attached, so an API does not accept the key of a caller it has no use for (decision 0005).
 *   The keys belong to the platform stack (decision 0005), and their ids are read from its SSM parameters when the stack is deployed. Deploy the platform stack first.
 *   A platform stack that is destroyed and deployed again has new keys, so deploy the service stacks again after it.
 * - Access logs go to a log group with the retention of the stage (conventions: Logs). A line has the request id, the route as declared (`/v1/customers/{customerId}`, never the real path, so no id is logged), the status, the latencies and the id of the API key.
 * - The base URL, with the stage and no trailing slash, is published to SSM at `/storefront/<stage>/<service>/base-url`.
 *
 * It does not create the account-wide role that API Gateway needs to write access logs (`cloudWatchRole` is off). That role is set once for the account and region by its own stack,
 * and an API with access logs does not deploy until it exists.
 * It adds no alarms and no gateway responses, and the built-in `GET /v0/health` and `GET /v0/version` come with their own change. An API with no route does not synthesize.
 *
 * A route works the CDK way: the handler is in the same stack, and the integration gets permission to invoke that function from this API and nothing else.
 *
 * @example
 * const api = new ServiceApi(this, 'Api', { config, service: 'Customers', specVersions: { v0: '0.2.0', v1: '0.3.0' }, keyKinds: ['tests', 'services'] });
 * api.addRoute('GET', '/customers/{customerId}', getCustomer); // GET /v1/customers/{customerId}
 * api.addRoute('POST', '/customers', createCustomer, { version: 'v2' }); // POST /v2/customers
 */
export class ServiceApi extends Construct {
    readonly api: RestApi;
    readonly accessLogGroup: LogGroup;
    /** One per kind of API key in `keyKinds`, and no other. */
    readonly usagePlans: Readonly<Partial<Record<ApiKeyKind, UsagePlan>>>;
    /** `https://<id>.execute-api.<region>.amazonaws.com/<stage>`, with no trailing slash. */
    readonly baseUrl: string;
    readonly baseUrlParameter: StringParameter;
    private readonly versions: ReadonlySet<string>;

    constructor(scope: Construct, id: string, props: ServiceApiProps) {
        super(scope, id);
        const { config, service, specVersions, keyKinds } = props;
        if (keyKinds.length === 0) throw new Error('A ServiceApi needs at least one kind of API key in keyKinds.');
        for (const kind of keyKinds) {
            if (!apiKeyKinds.includes(kind)) throw new Error(`The key kind "${kind}" is not one of ${apiKeyKinds.join(', ')}.`);
        }
        const repeated = keyKinds.find((kind, index) => keyKinds.indexOf(kind) !== index);
        if (repeated !== undefined) throw new Error(`The key kind "${repeated}" is listed twice in keyKinds.`);
        const prefixes = Object.keys(specVersions);
        if (prefixes.length === 0) throw new Error('A ServiceApi needs the version of at least one spec.');
        for (const prefix of prefixes) {
            if (!/^v\d+$/.test(prefix)) throw new Error(`The spec version prefix "${prefix}" must look like v1: a "v" and a number.`);
        }
        this.versions = new Set(prefixes);

        this.accessLogGroup = new LogGroup(this, 'AccessLogs', { retention: config.logRetention, removalPolicy: removalPolicyFor(config) });
        this.api = new RestApi(this, 'Api', {
            restApiName: stackName(config, service),
            description: `The ${service} API of the ${config.name} stage.`,
            endpointConfiguration: { types: [EndpointType.REGIONAL] },
            // Set once for the account by its own stack, and not by every API (see the comment of the class).
            cloudWatchRole: false,
            deployOptions: {
                stageName: config.name,
                throttlingRateLimit: config.api.defaultThrottle.rateLimit,
                throttlingBurstLimit: config.api.defaultThrottle.burstLimit,
                accessLogDestination: new LogGroupLogDestination(this.accessLogGroup),
                accessLogFormat: accessLogFormat()
            }
        });

        const plans: Partial<Record<ApiKeyKind, UsagePlan>> = {};
        for (const kind of apiKeyKinds.filter((candidate) => keyKinds.includes(candidate))) {
            const { rateLimit, burstLimit, quotaPerDay } = config.api.usagePlans[kind];
            const name = pascalCase(kind);
            const plan = this.api.addUsagePlan(`${name}UsagePlan`, {
                name: `${stackName(config, service)}-${kind}`,
                description: `What the ${kind} API key may use of the ${service} API in the ${config.name} stage.`,
                throttle: { rateLimit, burstLimit },
                quota: { limit: quotaPerDay, period: Period.DAY },
                apiStages: [{ stage: this.api.deploymentStage }]
            });
            // The id of the key comes from SSM at deploy time. The value of a key is never in a template (decision 0005).
            plan.addApiKey(ApiKey.fromApiKeyId(this, `${name}ApiKey`, StringParameter.valueForStringParameter(this, apiKeyIdParameterName(config, kind))));
            plans[kind] = plan;
        }
        this.usagePlans = plans;

        this.baseUrl = Fn.join('', ['https://', this.api.restApiId, '.execute-api.', Aws.REGION, '.', Aws.URL_SUFFIX, '/', config.name]);
        this.baseUrlParameter = new StringParameter(this, 'BaseUrlParameter', {
            parameterName: ssmParameterName(config, service, 'base-url'),
            description: `Base URL of the ${service} API in the ${config.name} stage.`,
            stringValue: this.baseUrl
        });

        // Findings that every service API has, acknowledged here once and not in every stack (as `ServiceFunction` does).
        // Each is a finding that cdk-nag reports for this construct, so a new one fails the test of the construct, and one that is no longer reported shows up in review.
        const authorization = 'Callers are identified by an API key and limited by a usage plan (decision 0005), because the project has no user identity system to authorize against.';
        Validations.of(this.api).acknowledge(
            {
                id: 'AwsSolutions::AwsSolutions-APIG2',
                reason: 'The handlers validate every request against the schemas of the spec and answer with the shared error shape (decision 0004). A validator at the gateway would answer with a body of its own, which the spec does not describe.'
            },
            {
                id: 'AwsSolutions::AwsSolutions-APIG3',
                reason: 'A web ACL costs a monthly fee for the ACL and for each rule, and the project accepts the risk while it is a demo. WAF is an optional stretch of the delivery and operations phase, with its cost noted.'
            },
            { id: 'AwsSolutions::AwsSolutions-APIG4', reason: authorization },
            {
                id: 'AwsSolutions::AwsSolutions-APIG6',
                reason: 'Execution logging makes API Gateway create a log group of its own, named by API Gateway and kept forever, which breaks the rule that every log group has an explicit retention (conventions: Logs). Access logs cover every request, with the status, the latencies and the API key id.'
            },
            { id: 'AwsSolutions::AwsSolutions-COG4', reason: `${authorization} A Cognito authorizer is not part of that decision.` }
        );
    }

    /**
     * Adds a method with a Lambda integration under `/v<N>`, and requires an API key on it. `path` has no version: `/customers/{customerId}`.
     * Throws when the version is not one of the `specVersions` of the API, or is `v0`, and when `path` is not a path or already starts with a version.
     */
    addRoute(method: HttpMethod, path: string, handler: IFunction, options: AddRouteOptions = {}): Method {
        const version = options.version ?? defaultApiVersion;
        if (version === operationalApiVersion) throw new Error(`The ${operationalApiVersion} prefix is for the operational routes, which ServiceApi adds itself. Routes of a service use v1 or later.`);
        if (!this.versions.has(version)) throw new Error(`The API serves ${[...this.versions].join(', ')} and not ${version}. Add the version to specVersions first.`);
        if (!path.startsWith('/') || path.length === 1) throw new Error(`The path "${path}" must start with / and name a resource, for example /customers.`);
        if (/^\/v\d+(\/|$)/.test(path)) throw new Error(`The path "${path}" starts with a version. Pass the version as an option and leave it out of the path.`);
        const resource = this.api.root.resourceForPath(`/${version}${path}`);
        return resource.addMethod(method, new LambdaIntegration(handler, { allowTestInvoke: false }), { apiKeyRequired: true });
    }
}

function pascalCase(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/** One JSON object per request. The declared route is logged and the real path is not, so no customer or order id reaches the logs. */
function accessLogFormat(): AccessLogFormat {
    return AccessLogFormat.custom(
        JSON.stringify({
            requestId: AccessLogField.contextRequestId(),
            requestTime: AccessLogField.contextRequestTime(),
            httpMethod: AccessLogField.contextHttpMethod(),
            resourcePath: AccessLogField.contextResourcePath(),
            status: AccessLogField.contextStatus(),
            responseLength: AccessLogField.contextResponseLength(),
            responseLatency: AccessLogField.contextResponseLatency(),
            integrationLatency: AccessLogField.contextIntegrationLatency(),
            apiKeyId: AccessLogField.contextIdentityApiKeyId(),
            sourceIp: AccessLogField.contextIdentitySourceIp(),
            errorMessage: AccessLogField.contextErrorMessage()
        })
    );
}
