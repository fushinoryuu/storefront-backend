# Platform

What every service is built from: one stack per stage that holds what the services share, and a few constructs that turn a service stack into a short description. This page says what each piece gives you, shows one use of it, and records what was seen when a throwaway service built from them ran in `dev`.

The code is in `infra/lib/`, and the plan is in [phase 1](roadmap-phases/phase-1-shared-platform.md). The reasons are in the [decision records](decisions/), and each construct's doc comment has the full list of what it sets.

## What a service stack looks like

A service stack is built from the stage config, the alarm topic of the platform stack and the constructs below. A function, an API and its routes take about 15 lines:

```ts
const alarmTopic = Topic.fromTopicArn(this, 'AlarmTopic', StringParameter.valueForStringParameter(this, alarmTopicArnParameterName(config)));
const getCustomer = new ServiceFunction(this, 'GetCustomer', { config, service: 'Customers', entry: 'services/customers/src/get-customer.ts', timeout: Duration.seconds(10), alarmTopic });
const api = new ServiceApi(this, 'Api', { config, service: 'Customers', specVersions: { v0: '0.2.0', v1: '0.3.0' }, keyKinds: ['tests', 'services'], alarmTopic });
api.addRoute('GET', '/customers/{customerId}', getCustomer);
```

The platform stack must be deployed first: the service stack reads the alarm topic and the API key ids from SSM when it is deployed.

## Platform stack

`PlatformStack` (`Storefront-<stage>-Platform`) holds what the services of a stage share:

- The event bus, named `storefront-<stage>-platform-bus`, with an archive (7 days in `dev`, 30 in `prod`) so events can be replayed while debugging. The name is fixed on purpose: a bus that is given none gets a name from the construct path, which has no stage in it, so the second stage to deploy to the account was refused (see below).
- The alarm topic. It emails the addresses in `ALARM_RECIPIENTS` (see [aws-setup.md](aws-setup.md)), refuses requests that are not over TLS, and lets the CloudWatch alarms of the account and region publish to it.
- The three API keys (`tests`, `services` and `admin`), with generated values (decision 0005).

It publishes the bus name, the alarm topic ARN and the three key ids to SSM, under `/storefront/<stage>/platform/`. No key value is in SSM or in a template. `npm run get-api-keys -- --stage <stage>` reads the values after a deploy and writes them to a file that git ignores. A destroyed and deployed platform stack has new keys, so deploy the service stacks again after it.

```
ALARM_RECIPIENTS=you@example.com npx cdk deploy --profile storefront -c stage=dev Platform
```

Two stacks belong to no stage: `Storefront-Secrets` (the LaunchDarkly SDK key of each stage, created empty, decision 0011) and `Storefront-ApiGatewayAccount` (the one role API Gateway writes access logs with, set once for the account and region). Both are deployed once, with the steps in [aws-setup.md](aws-setup.md).

## ServiceFunction

A Lambda function with what every service function needs: arm64 on Node.js 24, bundled by esbuild with source maps, X-Ray tracing on, its own role and its own log group with the retention of the stage, and the standard environment variables (`STAGE`, `SERVICE_NAME`, the log level, and `EVENT_BUS_NAME` when you pass the bus). It also gets the three alarms of `LambdaAlarms`.

The timeout and the alarm topic are required, so every function has a timeout that someone chose and alarms that notify somebody. Permissions are given the CDK way and stay as narrow as the resource. Never add a wildcard.

```ts
const hello = new ServiceFunction(this, 'Hello', { config, service: 'Customers', entry: 'services/customers/src/hello.ts', timeout: Duration.seconds(10), alarmTopic });
sdkKeySecret.grantRead(hello); // the role gets read access to that one secret and nothing else
```

## LambdaAlarms

Errors (one or more in five minutes), throttles (one or more) and duration (the p99 at 80% of the timeout or more, in two of three windows). A window with no invocations is not a breach. `ServiceFunction` adds them itself. A function that is not a `ServiceFunction` can use them alone:

```ts
new LambdaAlarms(this, 'HelloAlarms', { function: hello, timeout: Duration.seconds(10), alarmTopic });
```

## ServiceApi

A Regional REST API with one stage named after the deployment stage, and one usage plan for each kind of key in `keyKinds`. The keys of the platform stack are attached to the plans, so a key of a kind that is not listed is refused at the gateway.

It adds `GET /v0/health` and `GET /v0/version` itself, with no key, and every route added with `addRoute` needs a key and goes under `/v<N>`. The access logs are one JSON line per request with the declared route (never the real path), the status, the latencies and the id of the key. It publishes its base URL to SSM at `/storefront/<stage>/<service>/base-url` and has the three alarms of `ApiAlarms`.

```ts
const api = new ServiceApi(this, 'Api', { config, service: 'Customers', specVersions: { v0: '0.2.0', v1: '0.3.0' }, keyKinds: ['tests', 'services'], alarmTopic });
api.addRoute('GET', '/customers/{customerId}', getCustomer); // GET /v1/customers/{customerId}
api.addRoute('POST', '/customers', createCustomer, { version: 'v2' }); // POST /v2/customers
```

Not built yet: the `adminOnly` flag, and customized gateway responses, so API Gateway's own error bodies reach callers for now (see what was seen below).

## ApiAlarms

One 5xx in five minutes, 100 or more 4xx in two of three windows, and a p95 latency of 5 seconds or more in two of three windows, all on the stage of the API. `ServiceApi` adds them itself. The numbers are a starting point that the delivery and operations phase tunes. They take the stage of an API that exists, so they are used alone only for an API that is not a `ServiceApi`:

```ts
new ApiAlarms(this, 'Alarms', { stage: restApi.deploymentStage, alarmTopic });
```

## EventConsumer

How a service reacts to events: a rule on the custom bus, a queue as its target, a dead-letter queue (a message is parked after 5 receives), and the function reading the queue with partial batch failure reporting. Two alarms watch the dead-letter queue: one message or more, and a message older than a day. A handler must be idempotent, because delivery is at least once.

```ts
const consumer = new EventConsumer(this, 'OrderPlaced', { config, function: onOrderPlaced, eventBus, source: 'storefront.orders', detailTypes: ['OrderPlaced'], alarmTopic });
table.grantReadWriteData(onOrderPlaced);
```

## Shared runtime

The code that runs inside the functions is in `packages/shared` (logger, correlation id, errors, validation, idempotency, HTTP client and the feature flag client) and `packages/events` (the event envelope). Its usage is in [the README of the shared package](../packages/shared/README.md). A service imports these packages and never Powertools itself (decision 0010).

The flag client takes the SDK key from Secrets Manager once per execution environment, and answers with the flag's default in code when it cannot reach LaunchDarkly. Create the client and the secret provider outside the handler:

```ts
const flags = createFlagClient({ service: 'customers', getSdkKey: createSecretProvider({ secretId: process.env.SDK_KEY_SECRET! }), timeoutMs: 3000, onFallback: logTheFallback });
const on = await flags.isEnabled('shipment-simulation'); // inside the handler
```

## What was seen in dev

A throwaway service with one `ServiceApi` and four functions was deployed to `dev` on 2026-11-22 and called. It was built on a branch that is not merged, so it is not on `main`. The checks, and what came back:

| Check                                                          | Result                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v0/health` and `GET /v0/version`, no key                 | 200 with `{"status":"ok"}`, and 200 with the build id, the stage and the spec versions. Both carry `x-correlation-id`.                                                                                                                                                   |
| A protected route with no key, or with a wrong key             | 403 with API Gateway's own body, `{"message":"Forbidden"}`. It is not `Problem` and has no correlation id.                                                                                                                                                               |
| A route that does not exist                                    | 403 with `{"message":"Missing Authentication Token"}`.                                                                                                                                                                                                                   |
| A protected route with the `tests` key                         | 200 with the handler's body and `x-correlation-id`.                                                                                                                                                                                                                      |
| A function that times out before the gateway does              | See below.                                                                                                                                                                                                                                                               |
| A function that throws                                         | 502 with the same body as the timeout, so a caller cannot tell the two apart.                                                                                                                                                                                            |
| An alarm on purpose                                            | The errors alarm of a function that throws went to ALARM, CloudWatch ran its SNS action on the alarm topic, and the email arrived. The 5xx alarm of the API and the errors alarm of the function that timed out also fired and sent email.                               |
| Access log                                                     | One JSON line per request with the declared route (`/v1/hello`), the status, the response and integration latencies, the API key id and the error message.                                                                                                               |
| The log group of a function                                    | Its logs reached its own log group, the one its role may write to, so the log statement of the role works as deployed.                                                                                                                                                   |
| A function that reads a flag with access to the SDK key secret | With the flag on in `dev` (its default in code is off), the log says `value: true` and has no fallback warning, on a cold start and on a warm call. The value came from LaunchDarkly. The route returns `{"message":"hello"}` and no flag state.                         |
| Service connections on LaunchDarkly's usage page               | `0.001` of 5 a month ("Monthly accumulated usage as of today", up from `0`) after the function read a flag about 9 times that day, most of them on a cold start. It is rounded to three decimals and may update late. Decision 0011 has the reading and what to do next. |
| A function without access to the SDK key secret                | The request is a 200. The log has a warning that the flag was answered with its default, with the reason `sdk-key` and the access denied error.                                                                                                                          |
| The first requests after the first deploy of a stage           | Every route answered 403, including the keyless ones, for about 30 seconds. After that the routes answered as above.                                                                                                                                                     |

### The first deploy of the platform stack to prod

On 2026-11-22 the first deploy of `Platform` to `prod` was refused by CloudFormation before it created anything: an event bus named `PlatformEventBus24204BC3` already existed. It was the bus of `dev`. The stack gave the bus no name, so CDK built one from the construct path (`Platform/EventBus`), which is the same in both stages, and both stages share one account and region. Nothing else in the platform stack had a fixed name that the stages shared. The bus now has a name with the stage in it. After the fix, the deploy to `prod` worked (`CREATE_COMPLETE`). Its SSM parameters under `/storefront/prod/platform/` are the bus name (`storefront-prod-platform-bus`), the ARN of the alarm topic and the ids of the `admin`, `services` and `tests` keys, and the archive of the bus keeps events for 30 days. The stack has no CloudFormation termination protection, on purpose: only a stack that would break others or lose data if it were destroyed by accident has it, which is the API Gateway account stack and, later, the Database stack. Every other stack deploys and destroys with one command. A name change replaces the bus, and the `dev` platform stack that was deployed before did: its next deploy on 2026-11-22 ended `UPDATE_COMPLETE`, the old bus and its archive are gone, and the new bus (`storefront-dev-platform-bus`, 7 days of archive) is the one in SSM. The API keys and the alarm topic were not replaced.

### The function times out first

On 2026-11-22, in `dev`, a route whose function has a 3 second timeout and sleeps for 10 seconds was called with the `tests` key. The gateway answered after 3.3 seconds:

- Status: `502`.
- Headers: `content-type: application/json` and `x-amzn-errortype: InternalServerErrorException`. There is no `x-correlation-id`.
- Body: `{"message": "Internal server error"}`.
- It does not match `Problem`: it has no `type`, `title`, `status` or `correlationId`.

The 502 is not a 503 or a 504, so the warm-up retry of the library project (503 and 504 only) would not retry it. A function that throws gets the same response. The customers spec has to document this response until a customized gateway response replaces it, and that work is planned with the other gateway responses.

### Bundle size and cold start

Measured on 2026-11-22. The bundle is built the way `ServiceFunction` builds it (esbuild, with the AWS SDK left out because the runtime has it).

| Function                                                   | Bundle        | Init duration of a cold start               |
| ---------------------------------------------------------- | ------------- | ------------------------------------------- |
| With the LaunchDarkly SDK (and the logger and the secrets) | 654,445 bytes | 278 to 402 ms, median about 300 ms (6 runs) |
| Without the SDK (the logger and the correlation id)        | 79,885 bytes  | 112 to 129 ms, median about 120 ms (6 runs) |

The SDK adds about 575 kB and about 180 ms to a cold start. The first flag evaluation on a cold start also takes 0.8 to 1.1 seconds inside the handler, for the secret read and the connection to LaunchDarkly. Both functions have 256 MB. The second row is the function behind `GET /v0/health`, which has no SDK. The cold starts were forced by changing an environment variable.

### Not seen yet

- An admin-only route rejecting the `tests` key, and a throttled key. Neither exists yet.
