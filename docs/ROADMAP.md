# Storefront Backend: Roadmap

A small, deliberately realistic backend for a fake online store, built on AWS with CDK in TypeScript. Three microservices, each using a different data store and communication style, so the project shows range without becoming large.

`storefront` is a placeholder name. Rename it freely.

This project is the demo target for the spec-driven test client library (see the library roadmap). Each service publishes an OpenAPI spec, and the library generates a typed client from each one. Build this project first.

## Architecture at a glance

| Service | Data store | Style | What it does |
|---|---|---|---|
| **customers** | Aurora PostgreSQL Serverless v2 | Synchronous REST API | Customer profiles and addresses (relational data, constraints, transactions) |
| **orders** | DynamoDB | REST API plus events in and out | Places and tracks orders, with a small read-only product catalog |
| **shipping** | DynamoDB (its own table) | Event driven | Reacts to placed orders, runs a simulated shipment lifecycle, reports status back |

Shared platform: a custom EventBridge bus, API Gateway API keys with usage plans for access control, reusable CDK constructs, shared libraries for logging, errors, and event envelopes.

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

- **Infrastructure:** CDK in TypeScript, one CDK app, one stack per service plus a platform stack, deployed per stage (`dev`, `staging`).
- **Runtime:** Lambda on Node.js, TypeScript, bundled with esbuild through CDK's `NodejsFunction`. Use a Lambda Node.js runtime that is current when you build this.
- **Testing:** vitest, matching the library project.
- **Account and region:** a personal AWS account in `us-west-2`, with a dedicated profile so experiments stay isolated.
- **Data stores:** Aurora for customers, DynamoDB for orders and shipping. Cost is the priority, and Aurora Serverless v2 with scale to zero is the cheapest relational option that keeps foreign keys, constraints and triggers, so it is the working choice. The open question about alternatives is tracked in `TODO.md`.
- **Auth:** API Gateway API keys with usage plans, so there is no separate identity system to build. API keys work only on REST APIs, not HTTP APIs, so all three services use REST APIs. See the next section for what that does and does not give you.

## Decisions to make early (Phase 0 records them)

- API definition approach: spec-first, or code-first with the OpenAPI spec generated from schemas.
- Aurora connectivity: RDS Data API (no VPC for Lambda, works with scale to zero) or Lambda in a VPC with RDS Proxy (conventional, costlier, and RDS Proxy prevents auto-pause).
- Event publishing from orders: DynamoDB Streams plus EventBridge Pipes (reliable outbox) or direct `PutEvents` from the handler (simpler, small failure window).

## API key auth: what to know

- API keys identify and throttle callers. They are shared secrets with no per-user identity and no scopes. That is fine for a demo and for machine callers such as test suites.
- Use separate keys per kind of caller: `tests` (test suites and the library project), `services` (service-to-service calls), and `admin` (the shipping simulation endpoint). The platform stack owns the three keys, and each service's usage plan accepts the ones it should. Usage plans carry the throttle and quota limits.
- Routes set `apiKeyRequired`. `GET /health` and `GET /version` stay open so probes and test setup work without a key.
- Usage plans apply per API stage, not per route, so admin-only routes are enforced in the handler by comparing the caller's key id (API Gateway passes it in the request context) with the admin key id.
- A key's value is not available as a CloudFormation output. Let CDK generate the keys, then retrieve the values after deploy with a small script and store them in Secrets Manager or an untracked local file. Never hard-code a key value, because it would end up in the template and the repo.
- API Gateway rejects a missing or invalid key with its own 403 response, and throttling returns 429, both outside your error shape. Customize the gateway responses so clients see the shared error shape.
- Rotation: create a new key, attach it to the usage plans, move callers over, delete the old one.
- Say plainly in the README that API keys are not a full authentication system, and name what you would use in production (for example Cognito or IAM authorization).
- REST APIs cost more per request than HTTP APIs. This is minor at demo volumes.

## Facts checked while planning

- Aurora Serverless v2 can scale to zero by setting minimum capacity to 0 ACUs. The idle timeout (`SecondsUntilAutoPause`) ranges from 300 seconds (the default) to 86,400 seconds. Resume typically takes about 15 seconds, and 30 seconds or more if the database was paused for over 24 hours. Supported on Aurora PostgreSQL 13.15, 14.12, 15.7, 16.3 and higher.
- Things that prevent pausing: an associated RDS Proxy, open connections (even idle ones), logical replication, reader instances in failover tiers 0 and 1, and frequent requests that keep it busy. RDS Data API requests resume a paused writer.
- DynamoDB Streams retain records for up to 24 hours, and EventBridge Pipes can deliver them to an event bus with retries and a dead-letter queue. Treat delivery as at least once and make consumers idempotent.
- RDS Data API is supported for Aurora PostgreSQL (serverless and provisioned) in `us-west-2` on 13.11+, 14.8+, 15.3+, 16.1+ and 17.4+, per the AWS documentation. Every engine version that supports scale to zero is therefore covered. Recheck when picking the exact engine version.
- Still to confirm during Phase 0 and Phase 2: the current API Gateway integration timeout for REST APIs (commonly cited as about 29 seconds by default, which a resume after a long pause can approach), and that EventBridge Pipes is available in `us-west-2`.

## Phases

| Phase | Doc | Outcome |
|---|---|---|
| 0 | [Foundations and decisions](roadmap-phases/phase-0-foundations.md) | Repo, AWS setup, stages, cost guardrails, decision records |
| 1 | [Shared platform](roadmap-phases/phase-1-shared-platform.md) | Event bus, auth, reusable constructs, shared libraries |
| 2 | [Customers service](roadmap-phases/phase-2-customers-service.md) | Aurora-backed REST API |
| 3 | [Orders service](roadmap-phases/phase-3-orders-service.md) | DynamoDB-backed REST API that publishes and consumes events |
| 4 | [Shipping service](roadmap-phases/phase-4-shipping-service.md) | Event-driven shipment lifecycle |
| 5 | [Integration and contracts](roadmap-phases/phase-5-integration-and-contracts.md) | End-to-end flows, contract tests, published specs |
| 6 | [Delivery and operations](roadmap-phases/phase-6-delivery-and-operations.md) | CI/CD, observability, security, cost, runbooks |
| 7 | [Polish](roadmap-phases/phase-7-polish.md) | README, diagrams, demo, resume material |

## Checklist

### Phase 0: Foundations and decisions
- [ ] Monorepo skeleton with CDK app, services, shared packages
- [ ] AWS account setup, CDK bootstrap, budget alarm
- [ ] Stage configuration for `dev` and `staging`
- [ ] Decision records for the open choices above
- [ ] Minimal CI: lint, typecheck, unit tests, `cdk synth`

### Phase 1: Shared platform
- [ ] Platform stack: custom event bus, API keys for `tests`, `services`, `admin`, shared parameters, alarm topic
- [ ] Script to retrieve key values after deploy
- [ ] Constructs: `ServiceFunction`, `ServiceApi`, `EventConsumer`, alarms, tagging
- [ ] Shared packages: logger, correlation id, error shape, event envelope, idempotency
- [ ] Every API exposes `GET /health` and `GET /version`
- [ ] CDK template tests and cdk-nag in the build

### Phase 2: Customers (Aurora)
- [ ] Schema and migrations
- [ ] Aurora Serverless v2 cluster with scale to zero
- [ ] CRUD API for customers and addresses, validation, pagination
- [ ] Tests against a real PostgreSQL
- [ ] OpenAPI spec v1.0.0

### Phase 3: Orders (DynamoDB)
- [ ] Access patterns, table design, indexes
- [ ] Order API with idempotency key and optimistic locking
- [ ] Customer validation through the customers API
- [ ] Outbox: Streams to Pipes to EventBridge
- [ ] Consumer for shipment events
- [ ] OpenAPI spec v1.0.0

### Phase 4: Shipping (event driven)
- [ ] Event rule, SQS queue with DLQ, idempotent consumer
- [ ] Shipment lifecycle with a configurable simulated carrier
- [ ] Read API and a protected simulation endpoint
- [ ] Event contracts and versioning
- [ ] OpenAPI spec v1.0.0

### Phase 5: Integration and contracts
- [ ] End-to-end flows, including failure cases
- [ ] API conformance tests against the specs
- [ ] Event contract tests for producers and consumers
- [ ] Specs published for the library project, planned v1.1.0 and v2.0.0 changes

### Phase 6: Delivery and operations
- [ ] CI/CD with OIDC, deploy to `dev`, approval to `staging`
- [ ] Dashboards, alarms, tracing
- [ ] Security and cost review, teardown tested
- [ ] Runbooks

### Phase 7: Polish
- [ ] README, diagrams, demo, measured results
- [ ] Repo hygiene
- [ ] Resume bullets and interview answers

## Hand-off to the library project

The library project needs from this one:

- Three OpenAPI specs (customers, orders, shipping), stable `operationId` and `tag` values, a shared error schema.
- Base URLs for `dev` and `staging` for each service, published as stack outputs or SSM parameters.
- An API key for the `tests` caller type, and a documented way to retrieve it after deploy. The library sends it in the `x-api-key` header.
- `GET /version` on every service, so test setup can confirm which build it is testing.
- A warm-up step or generous timeouts for the first call after Aurora has paused.
- The planned v1.1.0 (non-breaking) and v2.0.0 (breaking) spec changes, so the library demo can be rehearsed.

The library roadmap's Phase 1 describes one demo API with an optional second service. With three services available here, you can update that doc to use all three as the multi-service example.
