# Storefront Backend: Roadmap

A small, deliberately realistic backend for a fake online store, built on AWS with CDK in TypeScript. Three microservices, each using a different data store and communication style, so the project shows range without becoming large.

`storefront` is a placeholder name. Rename it freely.

This project is the demo target for the spec-driven test client library, [`spec-driven-test-client`](https://github.com/fushinoryuu/spec-driven-test-client) (see the library roadmap). Each service publishes OpenAPI specs, and the library generates a typed client from each one. Build this project first, starting with the draft specs (Phase 0.5) so the library project can begin before anything is deployed.

## Architecture at a glance

| Service       | Data store                      | Style                           | What it does                                                                      |
| ------------- | ------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| **customers** | Aurora PostgreSQL Serverless v2 | Synchronous REST API            | Customer profiles and addresses (relational data, constraints, transactions)      |
| **orders**    | DynamoDB                        | REST API plus events in and out | Places and tracks orders, with a small read-only product catalog                  |
| **shipping**  | DynamoDB (its own table)        | Event driven                    | Reacts to placed orders, runs a simulated shipment lifecycle, reports status back |

Shared platform: a custom EventBridge bus, API Gateway API keys with usage plans for access control, reusable CDK constructs, shared libraries for logging, errors, event envelopes and feature flags (LaunchDarkly).

```
Client --> customers API --> Lambda --> Aurora (Serverless v2)
Client --> orders API    --> Lambda --> DynamoDB (orders)
                                          |  DynamoDB Streams
                                          v
                                   EventBridge Pipes --> custom event bus
                                                          |      ^
                                  OrderPlaced / Cancelled |      | ShipmentDispatched / Delivered
                                                          v      |
                          SQS (+DLQ) --> shipping Lambda --> DynamoDB (shipments) + Step Functions (carrier simulation)
```

The orders service calls the customers API to validate a customer when an order is placed (a deliberate mix of synchronous and event-driven communication).

## Decisions already taken

- **Infrastructure:** CDK in TypeScript, one CDK app, one stack per service plus a platform stack, a secrets stack and one persistent database stack, deployed per stage. `dev` is where pull request runs deploy, test and tear down. `prod` is a production-like stage deployed from `main` that stays up for ad hoc testing, and it owns the database stack that `dev` shares.
- **Test runs:** deploy to `dev`, run the tests, then destroy every `dev` stack. The `prod` stage is never destroyed by a test run. It owns the one Aurora cluster, which `dev` shares: creating it takes 10 to 15 minutes, and while paused it costs storage only. Termination protection keeps it from being destroyed by accident. Each pull request run uses its own database schema in that cluster, named from the Jira ticket key in the branch name and dropped after the run with Flyway clean. `prod` uses the `main` schema, which is never dropped, and a PR run's database user cannot touch it. Runs are serialized with a concurrency limit so two branches never collide.
- **Runtime:** Lambda on Node.js, TypeScript, bundled with esbuild through CDK's `NodejsFunction`. Use a Lambda Node.js runtime that is current when you build this.
- **Testing:** vitest, matching the library project. The integration tests live in this repo and will use the typed clients that the library generates, once the library is ready to be used. Until then they call the API with plain `fetch`, and Phase 5 moves them over.
- **Account and region:** a personal AWS account in `us-west-2`, with a dedicated profile so experiments stay isolated.
- **Data stores:** Aurora PostgreSQL Serverless v2 with scale to zero for customers, DynamoDB for orders and shipping. Cost is the priority, and Aurora is the cheapest relational option that keeps foreign keys, constraints and triggers. Aurora DSQL was considered and ruled out because it gives up foreign keys, triggers and the Data API.
- **Database migrations:** Flyway. Because Flyway connects over JDBC and the database sits in an isolated VPC with no NAT, it runs in a container Lambda inside the VPC, invoked on deploy, with one Secrets Manager interface endpoint for the credentials (about $7 a month while deployed, see `docs/cost.md`). A NAT gateway would be about $33 a month. The app functions still use the Data API from outside the VPC.
- **API definition:** spec-first, written as OpenAPI 3.0.3 (the version with the most documentation and the widest Zod and generator support). The hand-written specs of each service are the source of truth, drafted in Phase 0.5 before any implementation. Routes are still defined in CDK, and the published specs have no API Gateway extensions and no `servers` entry. Drift is caught by validating runtime requests and responses against the spec and by the conformance tests, not by comparing generated files. The shared error schema is `Problem`. Decision record 0004 has the details.
- **API versions side by side:** every path starts with a version prefix. Business routes are under `/v1`, and a later major is served next to it under `/v2` (Phase 5 does this for real). The operational routes (`/v0/health`, `/v0/health/ready` and `/v0/version`) live under a reserved `/v0` prefix, in their own small spec per service, so they are defined once. Each prefix is its own spec and its own bundle, `specs/<service>-service-v<N>.yaml`, and `GET /v0/version` reports every prefix a service serves (`specVersions`).
- **Feature flags:** LaunchDarkly on its free Developer plan, chosen over AWS AppConfig because it is the more common product. Flags are plain booleans, read through a small flag client with in-code defaults, so the code never depends on LaunchDarkly being reachable. There are two LaunchDarkly environments, `dev` (shared by every pull request run) and `prod`. The backend exposes no flag state through its API. The first uses are the shipping simulation endpoint (Phase 4) and the "customers unavailable" test (Phase 5). A decision record in Phase 1 covers the details.
- **Auth:** API Gateway API keys with usage plans, so there is no separate identity system to build. API keys work only on REST APIs, not HTTP APIs, so all three services use REST APIs. See the next section for what that does and does not give you.

## Decisions to make early (Phase 0 records them)

- Aurora connectivity: the RDS Data API for the app (no VPC for Lambda, works with scale to zero) plus Flyway in an in-VPC Lambda for migrations. The alternative is Lambda in a VPC with RDS Proxy (conventional, costlier, and RDS Proxy prevents auto-pause). Decision record 0006 confirms this, and 0007 covers scaling and persistence.
- Event publishing from orders: DynamoDB Streams plus EventBridge Pipes (reliable outbox), decided in record 0008. Direct `PutEvents` from the handler (simpler, small failure window) is the fallback, and shipping and customers use it.

## API key auth: what to know

- API keys identify and throttle callers. They are shared secrets with no per-user identity and no scopes. That is fine for a demo and for machine callers such as test suites.
- Use separate keys per kind of caller: `tests` (test suites and the library project), `services` (service-to-service calls), and `admin` (the shipping simulation endpoint). The platform stack owns the three keys, and each service's usage plan accepts the ones it should. Usage plans carry the throttle and quota limits.
- Routes set `apiKeyRequired`. `GET /v0/health` and `GET /v0/version` stay open so probes and test setup work without a key.
- Usage plans apply per API stage, not per route, so admin-only routes are enforced in the handler by comparing the caller's key id (API Gateway passes it in the request context) with the admin key id.
- A key's value is not available as a CloudFormation output. Let CDK generate the keys, then retrieve the values after deploy with a small script and store them in Secrets Manager or an untracked local file. Never hard-code a key value, because it would end up in the template and the repo.
- API Gateway rejects a missing or invalid key with its own 403 response, and throttling returns 429, both outside the shared error shape. `ServiceApi` customizes these gateway responses so clients see the shared error shape (`docs/platform.md`).
- Rotation: create a new key, attach it to the usage plans, move callers over, delete the old one.
- Say plainly in the README that API keys are not a full authentication system, and name what you would use in production (for example Cognito or IAM authorization).
- REST APIs cost more per request than HTTP APIs. This is minor at demo volumes.

## Facts checked while planning

- Aurora Serverless v2 can scale to zero by setting minimum capacity to 0 ACUs. The idle timeout (`SecondsUntilAutoPause`) ranges from 300 seconds (the default) to 86,400 seconds. Resume typically takes about 15 seconds, and 30 seconds or more if the database was paused for over 24 hours. Supported on Aurora PostgreSQL 13.15, 14.12, 15.7, 16.3 and higher.
- Things that prevent pausing: an associated RDS Proxy, open connections (even idle ones), logical replication, reader instances in failover tiers 0 and 1, and frequent requests that keep it busy. RDS Data API requests resume a paused writer.
- DynamoDB Streams retain records for up to 24 hours, and EventBridge Pipes can deliver them to an event bus with retries and a dead-letter queue. Treat delivery as at least once and make consumers idempotent.
- RDS Data API is supported for Aurora PostgreSQL (serverless and provisioned) in `us-west-2` on 13.11+, 14.8+, 15.3+, 16.1+ and 17.4+, per the AWS documentation. Every engine version that supports scale to zero is therefore covered. Recheck when picking the exact engine version.
- A NAT gateway costs about $0.045 per hour (about $33 a month) plus $0.045 per GB processed, per the AWS pricing page for US East (Ohio). Oregon was not listed.
- The Data API `ExecuteStatement` reference says of the `schema` parameter: "Currently, the `schema` parameter isn't supported." The app therefore sets the schema itself (ADR 0006). A paused cluster makes the Data API return `DatabaseResumingException` and resume, and a response over 1 MiB ends the call.
- Flyway's `clean` is disabled by default (`cleanDisabled`, since Flyway 9). It drops all objects in the configured schemas, and drops the schemas themselves when Flyway created them (`createSchemas`, on by default).
- EventBridge Pipes is available in `us-west-2`: the AWS General Reference lists `pipes.us-west-2.amazonaws.com`, with a limit of 3000 concurrent pipe executions there. A Pipes source for a DynamoDB stream delivers at least once, and AWS suggests a retry maximum age shorter than the stream's retention.
- The API Gateway integration timeout for REST APIs is 29 seconds by default (ADR 0003).
- A GitHub Actions concurrency group runs one run at a time and by default keeps at most one waiting run, replacing an older waiting run with a newer one. `queue: max` keeps up to 100 waiting runs and cannot be combined with `cancel-in-progress`.
- The AWS PrivateLink pricing example for US East uses $0.01 per hour for each interface endpoint in each availability zone (about $7 a month) and $0.01 per GB processed. The AWS Aurora pricing page gives $0.12 per ACU-hour for Aurora Serverless v2 Standard in US East (N. Virginia) as an example.
- The `us-west-2` rates, from AWS's public price list files (read on 2026-11-06): an interface endpoint is $0.01 per hour and $0.01 per GB, a public IPv4 address is $0.005 per hour, Aurora PostgreSQL Serverless v2 (Standard) is $0.12 per ACU-hour, Aurora storage is $0.10 per GB-month, the Data API is $0.35 per million requests at the first tier, and a Secrets Manager secret is $0.40 a month. EventBridge Pipes is $0.40 per million requests after filtering, but its pricing page does not name a region. `docs/cost.md` has the detail.
- Checked against the account on 2026-11-06: every Aurora PostgreSQL engine version in `us-west-2` (13.23 to 18.6) reports a minimum capacity of 0, and Pipes answers in the region (`docs/aws-setup.md`).
- Checked on 2026-11-23: Powertools for AWS Lambda (TypeScript) 2.37.0 runs its unit tests on Node.js 22, 24 and 26 (decision 0010).
- Still to confirm: the Oregon rate of a NAT gateway (the figure is from the US East page).

## Phases

| Phase | Doc                                                                              | Outcome                                                              |
| ----- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 0     | [Foundations and decisions](roadmap-phases/phase-0-foundations.md)               | Repo, AWS setup, stages, cost guardrails, decision records           |
| 0.5   | [Draft OpenAPI specs](roadmap-phases/phase-0-5-draft-specs.md)                   | Spec-first drafts (v0.1.0) of all three APIs for the library project |
| 1     | [Shared platform](roadmap-phases/phase-1-shared-platform.md)                     | Event bus, auth, reusable constructs, shared libraries               |
| 2     | [Customers service](roadmap-phases/phase-2-customers-service.md)                 | Aurora-backed REST API                                               |
| 3     | [Orders service](roadmap-phases/phase-3-orders-service.md)                       | DynamoDB-backed REST API that publishes and consumes events          |
| 4     | [Shipping service](roadmap-phases/phase-4-shipping-service.md)                   | Event-driven shipment lifecycle                                      |
| 5     | [Integration and contracts](roadmap-phases/phase-5-integration-and-contracts.md) | Conformance and contract tests, published specs, v1.1.0 and `/v2`    |
| 6     | [Delivery and operations](roadmap-phases/phase-6-delivery-and-operations.md)     | CI/CD, observability, security, cost, runbooks                       |
| 7     | [Polish](roadmap-phases/phase-7-polish.md)                                       | README, diagrams, demo, resume material                              |

## Slices

The work is built in vertical slices, not one phase at a time. A slice ends with something deployed to `dev` and a test that calls it. Until slice E, a person runs the test by hand: deploy the stacks to `dev`, run the suite, destroy them. The phase docs stay the detailed list of what each service needs. A slice takes the tasks it needs from them and ticks each box when that part is finished and true, with sub-bullets for a task that is only partly done.

| Slice | Ends with, in `dev`                                                                                                                                              | Test it allows                                                                                                                                     | Tasks it takes                                                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | **Orders skeleton.** `POST /v1/orders` (idempotency key, prices from the catalog) and `GET /v1/orders/{orderId}`, with no customer check yet                     | Place an order, read it back, and repeat the key to get the same order. The first test in `tests/e2e/`, with plain `fetch` and the `tests` key     | Phase 3 tasks 1, 2 (without the pipe alarm) and 3 (without the customer check), and their tests (task 8). Phase 5 task 1 (the helper for base URLs and keys, the polling helper, run ids)                    |
| B     | **Customers on Aurora.** The Database stack and the customers API. Orders checks the customer through the shared HTTP client                                     | Create a customer and an address, then place an order for it. An unknown customer (404). Customers unavailable (503). The first call after a pause | Phase 2 tasks 1 to 5, 7 and 8. The customer check of Phase 3 task 3. The warm-up step of Phase 5 task 1, and the end-to-end flows for an unknown customer, customers unavailable and a cold database         |
| C     | **Order events and shipments.** `OrderPlaced` reaches the bus through the table stream and Pipes. Shipping consumes it and creates one shipment, with a read API | Place an order and a shipment appears. A duplicate and a malformed event on the bus                                                                | Phase 3 task 5. Phase 4 tasks 1, 2 (the `OrderPlaced` consumer only) and the read endpoints of 5. The end-to-end flow for duplicate and poison events                                                        |
| D     | **The loop back.** The simulated carrier, the simulation endpoint, shipment events consumed by orders, and cancellation with optimistic locking                  | An order through `SHIPPED` and `DELIVERED`. Cancel before and after a shipment. Late and duplicate shipment events                                 | Phase 3 tasks 4, 6 and 7. Phase 4 tasks 2 (`OrderCancelled`), 3, 4, the rest of 5, and 6 to 9. The happy path and the cancel flows of Phase 5 task 2                                                         |
| E     | **CI runs the suite.** Every pull request deploys the per-run stacks to `dev`, runs the suite, and destroys them, even when a test fails                         | The same tests, with no one running them                                                                                                           | Phase 6 task 2 (the deployment role) and the pull request parts of task 3 (deploy and tear down, one concurrency group, the schema from the branch name, a teardown that always runs, the scheduled cleanup) |

What is left after slice E stays in its phase: the conformance and event contract tests, the seed and reset scripts, publishing the specs, v1.1.0 and `/v2` (Phase 5), the deploy of `prod` on merge, drift checks, observability, the reviews and the runbooks (Phase 6), and Phase 7.

- **Why this order.** Orders has no VPC and no database stack, so it gives the first deployed test soonest. Customers comes next so that Aurora surprises (the resume wait, Flyway in the VPC, the Data API) show up after one slice and not after three. Shipping follows because it needs orders to publish events.
- **A temporary gap.** Until slice B, orders accepts any customer id. That is acceptable in `dev` only. The customer check box of Phase 3 stays unticked, and a spec is released as v1.0.0 only when its service is complete (slice B for customers, slice D for orders and shipping).
- **Before slice B.** The open choices about the Database stack are settled in decision records first, so slice B does not start blocked.
- **Concurrency limit.** The account allows 10 concurrent Lambda executions (`docs/platform.md`), so the suite sends one request at a time until the limit is raised.
- **A slice is not one pull request.** Each ticket is still one pull request, and a slice is as many tickets as it needs.

## Checklist

The boxes are ticked slice by slice (see [Slices](#slices)): a box is ticked when its work is finished, whichever slice finishes it.

### Phase 0: Foundations and decisions

- [x] Monorepo skeleton with CDK app, services, shared packages
- [x] AWS account setup, CDK bootstrap, budget alarm
- [x] Stage configuration for `dev` and `prod`, with `dev` stacks per-run and every `prod` stack persistent
- [x] Decision records for the open choices above
- [x] Minimal CI: lint, typecheck, unit tests, `cdk synth`

### Phase 0.5: Draft OpenAPI specs

- [x] Spec conventions, shared components, and the spec-first decision record
- [x] Lint and bundle tooling
- [x] Draft v0.1.0 specs for customers, shipping and orders
- [x] Hand-off draft and a check with the library project
  - [x] Hand-off draft (`docs/spec-handoff.md`) and the spec change notes (`docs/spec-change-notes.md`)
  - [x] The library project generates clients from the drafts, and what it finds is fixed

### Phase 1: Shared platform

- [x] Platform stack: custom event bus, API keys for `tests`, `services`, `admin`, shared parameters, alarm topic
  - [x] Built, tested and deployed to `dev` on 2026-11-18, with the SSM values listed and the alarm email confirmed. Deployed to `prod` on 2026-11-22, with its SSM values read.
- [x] Script to retrieve key values after deploy
- [x] Constructs: `ServiceFunction`, `ServiceApi`, `EventConsumer`, alarms, tagging
  - [x] Done: `ServiceFunction`, the Lambda alarms, `EventConsumer`, and `ServiceApi` (routes under `/v<N>` with an API key, usage plans, access logs, base URL, built-in health and version routes, 5xx, 4xx and latency alarms), with tests and cdk-nag. `ServiceFunction`, `EventConsumer` and `ServiceApi` require the alarm topic
  - [x] Done: the rest of `ServiceApi`: the `adminOnly` flag, and gateway responses that answer with the shared error shape, with tests
  - [x] Done: the gateway responses and an admin-only route seen on a deployed API in `dev` on 2026-11-22 (`docs/platform.md`)
- [x] API Gateway logging role: the account-wide role that access logs need, in its own stack that belongs to no stage (`Storefront-ApiGatewayAccount`). Deployed on 2026-11-20, and `aws apigateway get-account` shows its role
- [x] Shared packages: logger, correlation id, error shape, event envelope, idempotency
- [x] Feature flag client (LaunchDarkly) with in-code defaults, and its decision record
  - [x] Done: the client with its in-code defaults, and the decision record (decision 0011)
  - [x] Done: the bundle size and cold start with and without the SDK, measured on `dev` on 2026-11-22 and recorded in the decision record
  - [x] Done: the service connections read from LaunchDarkly's usage page on 2026-11-22 (0.001 after about 9 flag reads) and recorded in the decision record
- [x] Every API exposes `GET /v0/health` and `GET /v0/version`, and `ServiceApi` serves several versions under one API
  - [x] Done: `ServiceApi` serves `/v1` and `/v2` routes side by side under one API, and refuses `v0` and a version that its specs do not list
  - [x] Done: `ServiceApi` adds `GET /v0/health` and `GET /v0/version` with no API key, answered by one shared function, and tests check their responses against the `/v0` specs
  - [x] Done: both routes answered in `dev` with no key on 2026-11-22, from a throwaway service (`docs/platform.md`)
- [x] CDK template tests and cdk-nag in the build
  - [x] Done: cdk-nag runs on every stack, and the platform stack, `ServiceFunction`, the Lambda alarms, `EventConsumer` and `ServiceApi` with its built-in routes and alarms have template tests
  - [x] Done: tests for the `adminOnly` flag and the gateway responses of `ServiceApi`
- [x] A throwaway "hello" service built from the constructs, deployed to `dev`, called with the `tests` key and destroyed
  - [x] Done: deployed twice to `dev` on 2026-11-22, once without and once with the gateway responses and an admin-only route, and destroyed both times. Neither was ever on `main`.
- [x] The constructs documented in `docs/platform.md`, with a usage example each and the results of the checks in `dev`
- [ ] Dependabot version updates and security alerts
  - [x] Done: the configuration for npm and GitHub Actions, the conventions for its pull requests, and the lockfile updates an update can fix
  - [ ] Remaining: the first run and its CI check, and the alerts open on the first day, each fixed or dismissed with a reason

### Phase 2: Customers (Aurora)

- [ ] Schema and Flyway migrations, run on deploy by an in-VPC Lambda
- [ ] Aurora Serverless v2 cluster with scale to zero, in a persistent database stack
- [ ] CRUD API for customers and addresses, validation, pagination
- [ ] Tests against a real PostgreSQL
- [ ] Implement against the draft spec and release it as v1.0.0

### Phase 3: Orders (DynamoDB)

- [ ] Access patterns, table design, indexes
- [ ] Order API with idempotency key and optimistic locking
- [ ] Customer validation through the customers API
- [ ] Outbox: Streams to Pipes to EventBridge
- [ ] Consumer for shipment events
- [ ] Implement against the draft spec and release it as v1.0.0

### Phase 4: Shipping (event driven)

- [ ] Event rule, SQS queue with DLQ, idempotent consumer
- [ ] Shipment lifecycle with a configurable simulated carrier
- [ ] Read API and a protected simulation endpoint, gated by a feature flag
- [ ] Event contracts and versioning
- [ ] Implement against the draft spec and release it as v1.0.0

### Phase 5: Integration and contracts

- [ ] End-to-end flows, including failure cases (built slice by slice, from slice A)
- [ ] API conformance tests against the specs
- [ ] Event contract tests for producers and consumers
- [ ] Stage manifest, spec versioning process and CI artifact for the library project, the planned v1.1.0 change, and a real `/v2` served next to `/v1`

### Phase 6: Delivery and operations

- [ ] CI/CD with OIDC, PR runs deploy to `dev` and tear down, a merge to `main` deploys `prod` (optionally behind an approval), and a deploy-test-destroy mode that leaves `prod` and its database alone (the pull request run comes first, in slice E)
- [ ] Dashboards, alarms, tracing
- [ ] Security and cost review, teardown tested
- [ ] Runbooks

### Phase 7: Polish

- [ ] README, diagrams, demo, measured results
- [ ] Repo hygiene
- [ ] Resume bullets and interview answers

## Hand-off to the library project

The library project needs from this one:

- OpenAPI specs for the three services (customers, orders, shipping), bundled as `specs/<service>-service-v<N>.yaml`: a `/v1` business spec and a `/v0` operational spec for each, and later a `/v2` one. They have stable `operationId` and `tag` values and the shared `Problem` error schema. Draft v0.1.0 versions are available from Phase 0.5, before anything is deployed, and a mock server driven by the specs can stand in for live endpoints until then. Each business spec reaches v1.0.0 when its service ships (Phases 2 to 4). The bundles are on `main` until the CI artifact exists.
- Base URLs for `dev` and `prod` for each service, published as stack outputs or SSM parameters. Because the `dev` stacks are destroyed after test runs, their URLs and keys change on every deploy, so the library reads them from the stage manifest each run instead of using fixed values.
- An API key for the `tests` caller type, and a documented way to retrieve it after deploy. The library sends it in the `x-api-key` header.
- `GET /v0/version` on every service, so test setup can confirm which build it is testing. It reports `specVersions`, keyed by prefix (`v0`, `v1`, `v2`), and the library compares each entry with the `info.version` of the spec whose file suffix matches.
- A warm-up step or generous timeouts for the first call after Aurora has paused (`GET /v0/health/ready` on customers).
- The LaunchDarkly project, environment keys and flag keys, but not flag state. The backend exposes no flag state, so the library reads flags from LaunchDarkly itself with a personal API token that has the built-in Reader role.
- The planned v1.1.0 (non-breaking) spec change and the real `/v2` (breaking changes) served next to `/v1`, so the library demo can be rehearsed. `docs/spec-change-notes.md` has the exact edits.

The library repository exists. It generates its clients with hey-api `openapi-ts`, names each spec's version after the bundle file, and raises spec problems as bug tickets in this project's Jira project (BEP). The library client check in Phase 0.5 can run as soon as the drafts exist. This repo's integration tests will use the library's published package, as a dev dependency, once it is ready.

The library roadmap's Phase 1 describes one demo API with an optional second service. With three services available here, you can update that doc to use all three as the multi-service example.
