# Phase 1: Shared Platform

Everything the three services have in common, built once: the event bus, authentication, reusable CDK constructs, and shared runtime libraries. Doing this well makes each service stack short and consistent.

## Goals

- One platform stack that owns the cross-service resources.
- Reusable constructs so a service stack reads like a description, not a wall of configuration.
- Shared runtime libraries so every service logs, errors, publishes events and reads feature flags the same way.
- One API construct that serves several API versions side by side.
- Quality gates (template tests, cdk-nag) established before the services exist.

## Deliverables

| Deliverable                  | Location                                               |
| ---------------------------- | ------------------------------------------------------ |
| Platform stack               | `infra/lib/stacks/platform-stack.ts`                   |
| Reusable constructs          | `infra/lib/constructs/`                                |
| Shared runtime package       | `packages/shared/` (including the feature flag client) |
| Event schemas and envelope   | `packages/events/`                                     |
| Feature flag decision record | `docs/decisions/` (the next free number)               |
| Template tests               | `infra/test/`                                          |
| Platform doc                 | `docs/platform.md`                                     |

## Platform stack

- [x] **Custom event bus** named per stage, with an archive enabled so events can be replayed during debugging (confirm retention settings and cost).
  - [x] Done: built in `PlatformStack` (7 days of archive in `dev`, 30 in `prod`), tested, and deployed to `dev` on 2026-11-18, where the bus name is in SSM.
- [ ] **API keys:** three `ApiKey` resources owned by the platform stack, one per kind of caller: `tests` (test suites and the library project), `services` (service-to-service calls), `admin` (the shipping simulation endpoint). Let CDK generate the values and publish only the key ids to SSM. Each service's usage plans attach the keys they accept.
  - [x] Done: the three keys with generated values, and their ids in SSM. No value is in the template, which a test checks. Deployed to `dev` on 2026-11-18.
  - [x] Done: the usage plans that attach the keys. `ServiceApi` makes one plan per kind of key and reads the key ids from those SSM parameters when its stack is deployed, so the platform stack deploys first and the service stacks are deployed again after it is.
  - [ ] Remaining: a deployed plan that accepts the `tests` key and rejects a missing or wrong one, which the hello service checks.
- [x] **Key retrieval script** (`scripts/get-api-keys`): reads the values with the API Gateway `get-api-key` call that includes the value, and writes them to Secrets Manager or an untracked local file. Never put key values in code, config, or the repo. The platform stack is destroyed after test runs, so new keys are generated on every deploy and the script runs after every deploy.
  - [x] Done: `npm run get-api-keys -- --stage <stage>` writes `.api-keys/<stage>.json` (ignored by git, readable only by the owner) and prints no value. It is tested against fake AWS clients, and it ran against the `dev` stack on 2026-11-18. The Secrets Manager copy is not built. It comes with the first service that calls another.
- [ ] **SSM parameters** (or stack outputs) for values other stacks and external tools need: event bus name, API key ids, and each service's base URL once deployed.
  - [x] Done: the event bus name and the three key ids, listed from the `dev` stack on 2026-11-18.
  - [x] Done: `ServiceApi` publishes the base URL of its service at `/storefront/<stage>/<service>/base-url`, with the stage and no trailing slash. The template test checks it.
  - [ ] Remaining: see the parameter in SSM after the first service is deployed to `dev`.
- [ ] **Secrets:** client secrets live in Secrets Manager or are retrieved at deploy time by an authorized process, never committed.
  - [x] Done: the LaunchDarkly SDK keys. The `Storefront-Secrets` stack creates one empty secret per stage, and the owner puts the value in (decision 0011).
  - [ ] Remaining: the key retrieval script writes the API key values to a local file only. The copy in Secrets Manager, and any other secret a service needs, is still open.
- [x] **Alarm topic:** an SNS topic that sends alarms to email.
  - [x] Done: the topic requires TLS and emails the addresses in `ALARM_RECIPIENTS` (`docs/aws-setup.md`). With none set it has no subscription. Deployed to `dev` with an address on 2026-11-18, and the subscription is confirmed. No alarm is attached to it yet.

## Reusable constructs

Each construct has sensible defaults and a small props interface.

### `ServiceFunction`

Wraps `NodejsFunction`.

- [x] arm64 architecture, a current Node.js runtime, esbuild bundling with source maps, a modest memory default.
- [x] Explicit log retention, X-Ray tracing on, structured logging environment variables.
- [x] Standard environment variables: stage, service name, event bus name, log level.
- [x] Reserved timeout defaults, and a convention that the timeout is set deliberately per function. There is no default: the timeout is a required prop, and the duration alarm follows it.
- [x] Least-privilege grants through CDK `grant*` methods, never wildcard policies. The function has its own role, which writes to its own log group only. The one wildcard is X-Ray's, which has no resource, and the construct acknowledges it in cdk-nag.

### `ServiceApi`

Wraps a REST API.

- [ ] `apiKeyRequired` on every method except `GET /v0/health` and `GET /v0/version`, with a usage plan per caller type (`tests`, `services`, `admin`) carrying throttle and quota limits.
  - [x] Done: `apiKeyRequired` on every method that `addRoute` adds, and a usage plan per caller type with the throttle and the daily quota of `api.usagePlans` in the stage config (the same in `dev` and `prod`), attached to the stage.
  - [ ] Remaining: the two built-in routes that need no key.
- [x] Access logging to a log group, throttling set low by default, and a stage per deployment stage. The log group keeps logs for the retention of the stage, a line holds the declared route and never the real path (so no id is logged), and the stage throttles every method at the `api.defaultThrottle` of the stage config. The endpoint is Regional, set explicitly (decision 0003). The role that API Gateway needs to write access logs is set once for the account, outside this construct, and an API with access logs does not deploy before it exists.
- [ ] A helper to add a route with a Lambda integration in one call, with an `adminOnly` flag and an API version option (default `v1`) that puts the route under `/v<N>`. One API serves several versions side by side, so `/v1` and `/v2` routes can coexist. Usage plans apply per stage, not per route, so admin-only routes are enforced in the handler by comparing the caller's key id from the request context with the admin key id.
  - [x] Done: `addRoute(method, path, handler, { version })`, which puts the route under `/v<N>`, gives the integration permission to invoke that function from this API only, and refuses `v0`, a version that the specs do not list, and a path that is malformed or already has a version.
  - [ ] Remaining: the `adminOnly` flag.
- [ ] Customized gateway responses so missing or invalid keys (403) and throttling (429) use the shared error shape (`Problem`).
- [ ] Built-in `GET /v0/health` (unauthenticated, no dependencies) and `GET /v0/version` (build id, stage, and `specVersions` listing every prefix the API serves). Their response shapes come from the shared spec components.
- [x] Publishes its base URL to SSM.
- [ ] 5xx, 4xx, and latency alarms attached to the alarm topic.

### `EventConsumer`

- [x] An EventBridge rule on the custom bus, an SQS queue as the target, a dead-letter queue with a redrive policy, and a Lambda event source with partial batch failure reporting. It takes a `ServiceFunction` and the source and detail types of the events (`infra/lib/constructs/event-consumer.ts`). A message is parked after 5 receives, which is what Lambda's documentation recommends at least, so a throttled function does not park a good message.
- [x] Queue visibility timeout set relative to the function timeout: 6 times it, the minimum that Lambda's documentation recommends (checked on 2026-11-19). The construct has no batching window, so nothing is added to it.
- [x] Alarms on DLQ depth (one message or more) and age of the oldest message (a day or more). A failed message stays 14 days in the dead-letter queue, the most SQS allows, and the age alarm is the second notice for one that nobody dealt with.

### Others

- [x] `TagAspect` (built in Phase 0) applied to every construct here, with a template test that the tags from the conventions doc are present.
  - [x] Done: `ServiceFunction`, with its log group, `EventConsumer`, with its two queues, and `ServiceApi`, with its API, stage, usage plans and access log group. An event rule cannot carry tags in CloudFormation.
- [x] A removal policy helper that reads from stage config (`removalPolicyFor` in `infra/lib/removal-policy.ts`).
- [x] A construct for Lambda alarms (errors, throttles, duration) used by `ServiceFunction`.
- [x] cdk-nag (AwsSolutions pack) added to the app. Each acknowledged finding needs a written reason, kept in `infra/lib/nag.ts`. cdk-nag 3 registers the pack as a validation plugin and not as an Aspect, and a finding that is not acknowledged fails `cdk synth`.

## Shared runtime packages

### `packages/shared`

- [x] **Logger:** structured JSON, with correlation id, service, stage, and request id on every line. Powertools for AWS Lambda, wrapped in this package (decision 0010).
- [x] **Correlation id:** read from `x-correlation-id` on requests (generate if absent), propagate it to downstream HTTP calls and into event envelopes, return it on responses.
  - [x] Read from the request or generate, and return it on responses (`getCorrelationId`, `correlationHeaders`).
  - [x] Into event envelopes: `buildEvent` takes it as `correlationId`.
  - [x] Downstream HTTP calls: `correlationHeaders` builds the header, and the HTTP client attaches it to every request.
- [x] **Error model:** one JSON error shape for every service (for example `type`, `title`, `status`, `detail`, `correlationId`, optional `errors[]` for field validation). Map domain errors to HTTP status codes in one place. The shared error schema is `Problem`, owned by the OpenAPI shared components (Phase 0.5), and this implementation must match it.
- [x] **Validation:** a small wrapper that validates input against schemas taken from the OpenAPI spec (as decided in record 0004) and returns the shared error shape.
- [x] **Idempotency helper:** conditional-write based dedupe keyed by event id or idempotency key, with TTL.
- [x] **HTTP client** for service-to-service calls: timeout, correlation id propagation, attaching the `services` API key (read from Secrets Manager once per execution environment), no automatic retry on non-idempotent methods.
- [x] **Feature flag client:** the LaunchDarkly server SDK, created once per execution environment at module level and never inside a handler, because a client created per invocation opens many unnecessary connections. A typed registry lists the flags the code knows (key, default, description), so an unknown key fails typecheck. Flags are plain booleans with no targeting rules. If LaunchDarkly is unreachable, or the account has gone read-only, every flag evaluates to its default in code. Unit tests use the SDK's test data source and never reach LaunchDarkly.

### `packages/events`

- [x] **Event envelope:** `eventId`, `eventType`, `schemaVersion`, `occurredAt`, `correlationId`, `producer`, and a typed `data` payload.
- [x] Schemas for every event, defined in one place, with exported TypeScript types and runtime validators.
- [x] Helpers to build an envelope and to parse and validate an incoming one, so consumers fail loudly on malformed events.
- [x] Versioning rule: additive changes keep the version, breaking changes bump `schemaVersion` and run alongside the old one for a transition period.

## Feature flags

LaunchDarkly, on its free Developer plan, instead of AWS AppConfig (it is the more widely used product). The services call LaunchDarkly directly through the flag client, and the backend exposes no endpoint that returns flag state, since that would show outside callers which flags are on.

- [x] **LaunchDarkly setup (manual):** an account, one project, and two environments: `dev`, shared by every pull request run, and `prod`. The SDK key of each environment is created in LaunchDarkly and stored outside the per-run stacks. Also create a personal API token with the built-in Reader role for the library project. The Developer plan has limits (at the time of writing: one project, three environments and five service connections a month), so check them again when signing up. The account was checked on 2026-11-16 (decision 0011): the plan card shows the Developer limits, and the Plan usage page shows higher ones because the account is in an intro period until about 2026-11-25. Neither shows the project or environment limits, so those two stay unverified.
  - [x] Done: the account, the project, the `dev` and `prod` environments, and the two flags the code knows (`shipment-simulation`, `customers-unavailable-simulation`), booleans that are off in both.
  - [x] Done on 2026-11-17: `Storefront-Secrets` is deployed and holds both SDK keys, a Reader token read a flag, and the project key is in `docs/spec-handoff.md`.
- [ ] **Decision record** covering why LaunchDarkly was chosen over AppConfig, the plan limits, the environment mapping, where the SDK keys are stored, the fallback to in-code defaults, and the decision that the backend exposes no flag state. LaunchDarkly counts Lambda against service connections by connection time (see decision 0011), but what our traffic uses is not measured, so deploy to `dev` with the client and read LaunchDarkly's usage page. If the count is too high, fall back to polling mode or fewer services reading flags directly.
  - [x] Done: the record is written (decision 0011). It covers the plan limits, the environment mapping, where the SDK keys live and the fallback to defaults. LaunchDarkly does document how Lambda counts against service connections: by connection time.
  - [ ] Remaining: deploy the client to `dev` with the hello service, read the service connections usage page by app id, and record the number in decision 0011.
- [x] Flag convention: a flag is on or off, nothing more, so its state is the environment's `on` value, which is what the library can read through the REST API.

## Quality gates

- [ ] CDK template tests with the assertions module, using a small sample stack for each construct: assert the important properties (tracing on, retention set, DLQ present, API key required on protected methods) rather than snapshotting everything.
  - [x] Done: `ServiceFunction`, the Lambda alarms, `EventConsumer` and the core of `ServiceApi`, including cdk-nag.
  - [ ] Remaining: the rest of `ServiceApi` (the built-in routes, the `adminOnly` flag, gateway responses and alarms), as it is built.
- [ ] Optionally a snapshot test per stack to make unintended infrastructure changes visible in review.
- [x] cdk-nag runs in the test suite and fails on unsuppressed findings (`infra/test/nag.test.ts`, and every `createApp` test synthesizes with the pack on).
- [ ] A test that error responses (including the customized gateway responses) and the health and version responses validate against the schemas in the shared spec components.
  - [x] Done: the error kinds of `packages/shared` are checked against the `Problem` schema and the response examples of the shared spec components.
  - [ ] Remaining: the customized gateway responses, and the health and version responses (with `ServiceApi`).
- [x] Unit tests for the shared packages, including the error mapping, the envelope validation, the idempotency helper, the HTTP client's key handling and timeout behavior, and the flag client's defaults.
- [x] A template test that `ServiceApi` can serve `/v1` and `/v2` routes side by side under one API.

## Dependency updates

- [ ] Dependabot version updates for npm and GitHub Actions, security alerts and security updates on, and the rules for its pull requests in `docs/conventions.md` (Dependencies).
  - [x] Done: `.github/dependabot.yml` (weekly, minor and patch grouped, TypeScript kept below 7), the conventions, and the lockfile updates that fix the alerts an update can fix.
  - [ ] Remaining: the first run opens a pull request for each ecosystem, one of them passes CI, no TypeScript 7 pull request appears, and every alert open on the first day is fixed or dismissed with a reason.

## Tasks summary

- [x] Build the platform stack and deploy it to `dev`.
- [ ] Build each construct with tests.
  - [x] Done: `ServiceFunction`, the Lambda alarms and `EventConsumer`, with template tests and cdk-nag.
  - [ ] Remaining: `ServiceApi`.
- [ ] Build `shared` and `events` packages with tests, including the feature flag client and its decision record.
  - [x] Done: both packages with their tests, the flag client, and the decision record.
  - [ ] Remaining: the service connections measurement on `dev` that the decision record waits for (see Feature flags above).
- [ ] Add a throwaway "hello" service using the constructs to prove they work, deploy it, call it with the `tests` API key, then delete it.
- [ ] Document the constructs in `docs/platform.md` with a short usage example each.

## Acceptance criteria

- The platform stack deploys to `dev` and `prod` and its outputs are readable from SSM.
- The throwaway service shows health and version (under `/v0`), a protected route (under `/v1`), and an alarm, all created from the constructs with under about thirty lines of stack code.
- `ServiceApi` serves `/v1` and `/v2` routes side by side under one API.
- The flag client returns a flag's value from LaunchDarkly, and falls back to the flag's default in code when LaunchDarkly is unreachable.
- Template tests and cdk-nag pass in CI.
- The throwaway service's health, version, and error responses validate against the shared spec components.
- Calling a protected route without an API key is rejected (with the shared error shape), and with a valid key succeeds. An admin-only route rejects the `tests` key.

## Risks and notes

- **Over-abstracting constructs.** If a construct needs more than a handful of props, it is doing too much. Prefer composition.
- **Event archive costs and retention.** Archives store events and replay can re-trigger consumers. Make replay a deliberate, documented action.
- **API key limits.** Keys are shared secrets with no identity or scopes, and gateway rejections use API Gateway's own format unless customized. Test missing, wrong, and throttled keys early.
- **Shared package coupling.** Services import `shared` and `events`, so breaking changes there ripple everywhere. Keep them small and well tested.
