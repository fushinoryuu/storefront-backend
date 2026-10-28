# Phase 2: Customers Service (Aurora)

A relational service: customer profiles with addresses, backed by Aurora PostgreSQL Serverless v2. Relational data is the point. Unique emails, foreign keys, and transactions are reasons to use a relational database here, and the service should show them.

## Goals

- A well-designed schema with migrations that run automatically on deploy.
- Aurora Serverless v2 configured for low cost, with the consequences of scale to zero handled deliberately.
- A clean REST API with validation, pagination, and the shared error shape.
- Tests that run SQL against a real PostgreSQL.

## Deliverables

| Deliverable | Location |
|---|---|
| Stack | `infra/lib/stacks/customers-stack.ts` |
| Service code | `services/customers/src/` |
| Migrations | `services/customers/migrations/` |
| OpenAPI spec | `services/customers/openapi.yaml` (draft from Phase 0.5, released as v1.0.0 here) |
| Tests | `services/customers/test/` |
| Service doc | `docs/services/customers.md` |

## Data model

| Table | Columns (suggested) | Notes |
|---|---|---|
| `customers` | `id` (uuid), `email` (unique, case-insensitive), `first_name`, `last_name`, `phone`, `status` (`active`, `suspended`, `deleted`), `created_at`, `updated_at`, `version` | Soft delete through `status`. Unique index on lowercased email. |
| `addresses` | `id` (uuid), `customer_id` (foreign key), `type` (`billing`, `shipping`), `line1`, `line2`, `city`, `region`, `postal_code`, `country`, `is_default` | At most one default per customer and type, enforced by a partial unique index. |

Business rules to enforce in the database where possible: unique email, foreign key integrity, one default address per type, `updated_at` maintained consistently.

## API

The draft spec from Phase 0.5 is authoritative. This table summarizes it.

| Operation | Method and path | Notes |
|---|---|---|
| `createCustomer` | `POST /customers` | 409 on duplicate email, 400 on invalid input |
| `getCustomer` | `GET /customers/{customerId}` | 404 if missing or deleted |
| `listCustomers` | `GET /customers` | Cursor pagination, optional `email` and `status` filters |
| `updateCustomer` | `PATCH /customers/{customerId}` | Optimistic concurrency with `If-Match` or a `version` field |
| `deleteCustomer` | `DELETE /customers/{customerId}` | Soft delete, idempotent |
| `addAddress` | `POST /customers/{customerId}/addresses` | |
| `listAddresses` | `GET /customers/{customerId}/addresses` | |
| `updateAddress`, `deleteAddress` | `PATCH` and `DELETE /customers/{customerId}/addresses/{addressId}` | |
| `getReadiness` | `GET /health/ready` | API key required. Runs `SELECT 1`, 503 with retry hint if the database is resuming. The warm-up call |

Tags: `customers`, `addresses`, plus the `version` tag from the shared construct. `getReadiness` goes under the same tag as the shared health routes. Stable `operationId` values matter because the library project turns them into method names.

## Tasks

### 1. Connectivity decision and adapter

Follow decision 0006 from Phase 0.

- [ ] **If using the RDS Data API:** Lambda functions call the Data API with the cluster and secret ARNs, outside a VPC. Write a small `SqlExecutor` interface (`query`, `transaction`) with a Data API implementation for AWS and a `pg` implementation for local and CI tests, so repository code is the same in both. Parameter styles differ (named versus positional), so the adapters translate.
- [ ] **If using a VPC Lambda:** place functions in isolated or private subnets, add the required endpoints (for example Secrets Manager) without a NAT gateway if possible, and use a connection pool that is created once per execution environment. An RDS Proxy would prevent auto-pause, so accept the cost or give up scale to zero.
- [ ] Record the outcome in the decision record, including what it means for local testing.

### 2. Database infrastructure

- [ ] Aurora PostgreSQL cluster, Serverless v2, one writer and no readers (readers in failover tiers 0 and 1 keep the cluster from pausing, and a demo does not need them).
- [ ] Use an engine version that supports scale to zero (PostgreSQL 13.15, 14.12, 15.7, 16.3 or higher at the time of writing). The Data API is available in `us-west-2` for all of these.
- [ ] Capacity: minimum 0 ACUs with an auto-pause delay chosen per stage (the allowed range is 300 to 86,400 seconds), and a low maximum, so a runaway test cannot scale the cluster up.
- [ ] Storage encrypted, credentials generated into Secrets Manager, backup retention minimal in `dev`, deletion protection off in `dev` and on in `staging`.
- [ ] Network: an isolated VPC with no NAT. If using the Data API the functions stay outside it.
- [ ] Alarms on ACU utilization and database connections.

### 3. Handle pauses and resume deliberately

Scale to zero means the first request after idle waits for the database to resume, typically about 15 seconds, and 30 seconds or more after a pause longer than 24 hours.

- [ ] Set Lambda timeouts above the resume time, and note the API integration timeout limit. A limit of roughly 29 seconds (the commonly cited default for REST API integrations) is tight after a long pause, so confirm the current limit and design around it.
- [ ] Return a clear `503` with a retry hint if the database is not ready, rather than an opaque timeout. Map connection errors in one place.
- [ ] Provide `GET /health/ready` as the one warm-up and readiness endpoint. It requires an API key, runs `SELECT 1`, and returns 503 with a retry hint if the database is not ready. Test setup and demos use it as the documented warm-up call. Requiring a key keeps anonymous traffic from waking the cluster.
- [ ] Remember that anything that keeps a connection open, or constant traffic from health checks, prevents pausing. Keep `GET /health` free of database access so alarms and probes do not hold the cluster awake. Only `GET /health/ready` touches the database, and nothing should call it on a schedule more often than rarely.
- [ ] Add a note in the cost doc on how to verify that the cluster actually pauses when idle.

### 4. Migrations

- [ ] Plain, ordered SQL migration files with a migrations table that records applied versions. Choose a migration tool or write a small runner, and record the choice.
- [ ] Run migrations as part of deployment, for example with a CDK `Trigger` or custom resource that invokes a migration function after the cluster is ready. It must be safe to run repeatedly and must fail the deployment on error.
- [ ] Migrations are forward-only. Write each so the previous application version still works against the new schema (expand, then contract), because the old Lambda version runs briefly during a deploy.
- [ ] A test that applies all migrations to an empty database and checks the resulting schema.

### 5. API implementation

- [ ] One handler per operation (or a small router per resource), thin handlers calling a domain layer, repositories behind interfaces.
- [ ] Input validation with schemas, mapped to the shared error shape.
- [ ] Cursor-based pagination with an opaque cursor, a maximum page size, and stable ordering.
- [ ] Email normalization, and a deliberate response on duplicates (409 with the shared error shape).
- [ ] Optimistic concurrency on update.
- [ ] Access control: API key required on every method except `GET /health` and `GET /version`. `GET /health/ready` requires a key. Both the `tests` and `services` keys may read and write customers. Any admin-only behavior is checked in the handler against the caller's key id.
- [ ] Correlation id on logs and responses.

### 6. Events (optional but useful)

- [ ] Publish `CustomerCreated`, `CustomerUpdated`, `CustomerDeleted` to the event bus after a successful commit, using the envelope from Phase 1.
- [ ] Note the limitation: publishing after commit can lose an event if the function fails in between. Record it in the decision record, and keep it as a known tradeoff for a demo (a transactional outbox table with a poller is the robust alternative).
- [ ] No other service has to consume these in the baseline. They exist so the event bus carries data from more than one producer.

### 7. OpenAPI spec

- [ ] Start from the Phase 0.5 draft. If the implementation needs a change, edit the spec first and bump the version, and tell the library project while the spec is still 0.x.
- [ ] Keep what the draft already has: stable `operationId` and `tag` values, the shared error schema on every 4xx response, an `apiKey` security scheme (header `x-api-key`), pagination parameters, examples.
- [ ] Request validation uses the spec's schemas, and handler tests check responses against the spec (decision 0004).
- [ ] Release the spec as v1.0.0 once the implementation matches it. Lint and bundle it in CI.

### 8. Tests

- [ ] **Unit:** domain rules, validation, cursor encoding, error mapping.
- [ ] **Repository tests against a real PostgreSQL** (a container started by the test run), covering uniqueness, foreign keys, the default-address rule, concurrency, and pagination.
- [ ] **Migration test** from an empty database.
- [ ] **Handler tests** with fake events, asserting status codes and response bodies, and validating every response against the spec.
- [ ] **CDK tests:** cluster has scale to zero configured, encryption on, no readers, API key required on every method except health and version.
- [ ] **Deployed smoke test** against `dev`, including the cold resume path.

## Acceptance criteria

- `POST` then `GET` of a customer works in `dev`, including after the database has paused.
- Duplicate email returns 409 with the shared error shape.
- Migrations run on deploy and on an empty test database.
- Repository tests run against real PostgreSQL in CI.
- The spec validates, and conformance checks (Phase 5) pass.

## Risks and notes

- **Aurora cost and idle behavior.** An idle cluster that never pauses costs money. Verify pausing actually happens, and check that nothing (probes, schedulers, connection pools) is holding it awake.
- **Two code paths for SQL.** If the Data API and `pg` adapters diverge, tests stop reflecting production. Keep the adapter thin and run a few deployed smoke tests as a backstop.
- **Schema changes during deploy.** Always expand before contract.
- **PII.** Use fake data only. Do not log email addresses or addresses in full.
