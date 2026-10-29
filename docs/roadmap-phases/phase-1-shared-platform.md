# Phase 1: Shared Platform

Everything the three services have in common, built once: the event bus, authentication, reusable CDK constructs, and shared runtime libraries. Doing this well makes each service stack short and consistent.

## Goals

- One platform stack that owns the cross-service resources.
- Reusable constructs so a service stack reads like a description, not a wall of configuration.
- Shared runtime libraries so every service logs, errors, and publishes events the same way.
- Quality gates (template tests, cdk-nag) established before the services exist.

## Deliverables

| Deliverable | Location |
|---|---|
| Platform stack | `infra/lib/stacks/platform-stack.ts` |
| Reusable constructs | `infra/lib/constructs/` |
| Shared runtime package | `packages/shared/` |
| Event schemas and envelope | `packages/events/` |
| Template tests | `infra/test/` |
| Platform doc | `docs/platform.md` |

## Platform stack

- [ ] **Custom event bus** named per stage, with an archive enabled so events can be replayed during debugging (confirm retention settings and cost).
- [ ] **API keys:** three `ApiKey` resources owned by the platform stack, one per kind of caller: `tests` (test suites and the library project), `services` (service-to-service calls), `admin` (the shipping simulation endpoint). Let CDK generate the values and publish only the key ids to SSM. Each service's usage plans attach the keys they accept.
- [ ] **Key retrieval script** (`scripts/get-api-keys`): reads the values with the API Gateway `get-api-key` call that includes the value, and writes them to Secrets Manager or an untracked local file. Never put key values in code, config, or the repo. The platform stack is destroyed after test runs, so new keys are generated on every deploy and the script runs after every deploy.
- [ ] **SSM parameters** (or stack outputs) for values other stacks and external tools need: event bus name, API key ids, and each service's base URL once deployed.
- [ ] **Secrets:** client secrets live in Secrets Manager or are retrieved at deploy time by an authorized process, never committed.
- [ ] **Alarm topic:** an SNS topic that sends alarms to email.

## Reusable constructs

Each construct has sensible defaults and a small props interface.

### `ServiceFunction`

Wraps `NodejsFunction`.

- [ ] arm64 architecture, a current Node.js runtime, esbuild bundling with source maps, a modest memory default.
- [ ] Explicit log retention, X-Ray tracing on, structured logging environment variables.
- [ ] Standard environment variables: stage, service name, event bus name, log level.
- [ ] Reserved timeout defaults, and a convention that the timeout is set deliberately per function.
- [ ] Least-privilege grants through CDK `grant*` methods, never wildcard policies.

### `ServiceApi`

Wraps a REST API.

- [ ] `apiKeyRequired` on every method except health and version, with a usage plan per caller type (`tests`, `services`, `admin`) carrying throttle and quota limits.
- [ ] Access logging to a log group, throttling set low by default, and a stage per deployment stage.
- [ ] A helper to add a route with a Lambda integration in one call, with an `adminOnly` flag. Usage plans apply per stage, not per route, so admin-only routes are enforced in the handler by comparing the caller's key id from the request context with the admin key id.
- [ ] Customized gateway responses so missing or invalid keys (403) and throttling (429) use the shared error shape.
- [ ] Built-in `GET /health` (unauthenticated, no dependencies) and `GET /version` (build id, spec version, stage). Their response shapes come from the shared spec components.
- [ ] Publishes its base URL to SSM.
- [ ] 5xx, 4xx, and latency alarms attached to the alarm topic.

### `EventConsumer`

- [ ] An EventBridge rule on the custom bus, an SQS queue as the target, a dead-letter queue with a redrive policy, and a Lambda event source with partial batch failure reporting.
- [ ] Queue visibility timeout set relative to the function timeout (AWS guidance is a multiple of it; check the current recommendation).
- [ ] Alarms on DLQ depth and age of the oldest message.

### Others

- [ ] `TagAspect` (built in Phase 0) applied to every construct here, with a template test that the tags from the conventions doc are present.
- [ ] A removal policy helper that reads from stage config.
- [ ] A construct for Lambda alarms (errors, throttles, duration) used by `ServiceFunction`.
- [ ] cdk-nag (AwsSolutions pack) added as an Aspect. Each suppression needs a written reason, kept in one place.

## Shared runtime packages

### `packages/shared`

- [ ] **Logger:** structured JSON, with correlation id, service, stage, and request id on every line. Powertools for AWS Lambda is a candidate (decision 0010).
- [ ] **Correlation id:** read from `x-correlation-id` on requests (generate if absent), propagate it to downstream HTTP calls and into event envelopes, return it on responses.
- [ ] **Error model:** one JSON error shape for every service (for example `type`, `title`, `status`, `detail`, `correlationId`, optional `errors[]` for field validation). Map domain errors to HTTP status codes in one place. The shared error schema is owned by the OpenAPI shared components (Phase 0.5), and this implementation must match it.
- [ ] **Validation:** a small wrapper that validates input against schemas taken from the OpenAPI spec (as decided in record 0004) and returns the shared error shape.
- [ ] **Idempotency helper:** conditional-write based dedupe keyed by event id or idempotency key, with TTL.
- [ ] **HTTP client** for service-to-service calls: timeout, correlation id propagation, attaching the `services` API key (read from Secrets Manager once per execution environment), no automatic retry on non-idempotent methods.

### `packages/events`

- [ ] **Event envelope:** `eventId`, `eventType`, `schemaVersion`, `occurredAt`, `correlationId`, `producer`, and a typed `data` payload.
- [ ] Schemas for every event, defined in one place, with exported TypeScript types and runtime validators.
- [ ] Helpers to build an envelope and to parse and validate an incoming one, so consumers fail loudly on malformed events.
- [ ] Versioning rule: additive changes keep the version, breaking changes bump `schemaVersion` and run alongside the old one for a transition period.

## Quality gates

- [ ] CDK template tests with the assertions module, using a small sample stack for each construct: assert the important properties (tracing on, retention set, DLQ present, API key required on protected methods) rather than snapshotting everything.
- [ ] Optionally a snapshot test per stack to make unintended infrastructure changes visible in review.
- [ ] cdk-nag runs in the test suite and fails on unsuppressed findings.
- [ ] A test that error responses (including the customized gateway responses) and the health and version responses validate against the schemas in the shared spec components.
- [ ] Unit tests for the shared packages, including the error mapping, the envelope validation, the idempotency helper, and the HTTP client's key handling and timeout behavior.

## Tasks summary

- [ ] Build the platform stack and deploy it to `dev`.
- [ ] Build each construct with tests.
- [ ] Build `shared` and `events` packages with tests.
- [ ] Add a throwaway "hello" service using the constructs to prove they work, deploy it, call it with the `tests` API key, then delete it.
- [ ] Document the constructs in `docs/platform.md` with a short usage example each.

## Acceptance criteria

- The platform stack deploys to `dev` and `prod` and its outputs are readable from SSM.
- The throwaway service shows health, version, a protected route, and an alarm, all created from the constructs with under about thirty lines of stack code.
- Template tests and cdk-nag pass in CI.
- The throwaway service's health, version, and error responses validate against the shared spec components.
- Calling a protected route without an API key is rejected (with the shared error shape), and with a valid key succeeds. An admin-only route rejects the `tests` key.

## Risks and notes

- **Over-abstracting constructs.** If a construct needs more than a handful of props, it is doing too much. Prefer composition.
- **Event archive costs and retention.** Archives store events and replay can re-trigger consumers. Make replay a deliberate, documented action.
- **API key limits.** Keys are shared secrets with no identity or scopes, and gateway rejections use API Gateway's own format unless customized. Test missing, wrong, and throttled keys early.
- **Shared package coupling.** Services import `shared` and `events`, so breaking changes there ripple everywhere. Keep them small and well tested.
