# 0006: Aurora connectivity and migrations

Status: accepted on 2026-11-04. The one unverified price was checked later: see `docs/cost.md`.

## Context

The customers service uses one Aurora PostgreSQL Serverless v2 cluster (ADR 0007), in an isolated VPC with no NAT gateway, because a NAT gateway costs about $33 a month. The cluster is shared: `prod` uses the `main` schema, and each pull request run of `dev` gets a schema of its own (ADR 0002). Three things have to be settled: how the functions reach the database, how schema changes are applied, and how a pull request run is kept away from `main`.

## Options

**How the functions reach the database.**

- **RDS Data API.** The functions run outside the VPC and call an HTTPS endpoint, with no connections to manage. A request resumes a paused cluster. It costs an HTTP call per statement, a 1 MiB response limit, and no `schema` parameter (the API reference says it "isn't supported"), and local tests need an adapter.
- **Functions in the VPC with a connection pool.** Conventional and easy to run locally, but it needs private networking, and open connections stop the cluster from pausing. An RDS Proxy would keep it awake all the time.

**How migrations run.** Flyway connects over JDBC, which the Data API does not offer, and the database has no route to the internet.

- **Flyway in a container Lambda inside the VPC**, reaching Secrets Manager through one interface endpoint.
- **The same Lambda behind a NAT gateway.** Works, at about $33 a month.
- **A runner of our own over the Data API.** No VPC at all, but we would write the migration bookkeeping that Flyway already does.

## Decision

- **App:** the Data API. The functions stay outside the VPC and use a small `SqlExecutor` interface, with a Data API implementation for AWS and a `pg` implementation for tests.
- **Migrations:** Flyway in a container Lambda in the isolated VPC, in each customers stack. A CDK `Trigger` runs it after the cluster is ready, and an error fails the deploy. It has two actions, `migrate` and `clean`. The stack has one Secrets Manager interface endpoint in one availability zone, for the runner.
- **Database users.** The Database stack creates four through the Data API, using the cluster's master secret, which no other stack can read. Each has its own secret.

  | User            | Can do                                               | Used by          |
  | --------------- | ---------------------------------------------------- | ---------------- |
  | `main_migrator` | Owns `main`. No rights on pull request schemas       | `prod` runner    |
  | `pr_migrator`   | Creates schemas and owns them. No rights on `main`   | `dev` runner     |
  | `main_app`      | Reads and writes tables in `main` only               | `prod` functions |
  | `pr_app`        | Reads and writes tables in pull request schemas only | `dev` functions  |

  `dev` stacks are only given the two `pr_` secrets. The boundary that protects `main` is PostgreSQL ownership and grants, so even a runner that is told to clean `main` cannot do it. The runner also refuses `main` and any name outside the pattern.

- **Schemas.** The Database stack creates `main`, owned by `main_migrator`. For a pull request, Flyway creates the schema as `pr_migrator` (`createSchemas`, on by default), and an `afterMigrate` callback grants the app user usage and table rights on it. The callback is safe to run again.
- **Clean.** Flyway disables `clean` by default (`cleanDisabled`). Only the `dev` runner enables it. It runs after the tests and before the stacks are destroyed. Flyway's documentation says that "if Flyway automatically created them, then the schemas themselves will be dropped when cleaning", so a pull request schema is gone afterwards. The runner checks that, and drops the schema if it is still there.
- **Leaked schemas.** A run that is cancelled or crashes leaves its schema behind. A cleanup job drops stale pull request schemas with `DROP SCHEMA ... CASCADE` through the Data API as `pr_migrator`, when a pull request closes and on a weekly schedule. It needs no VPC.
- **Choosing the schema.** The `schema` parameter is not available, so each unit of work is a Data API transaction that starts with `SET LOCAL search_path`. The name comes from configuration and must be `main` or match the pull request pattern (lowercase, then `_` and digits, at most 63 bytes). It is quoted as an identifier and never built from request input. The `pg` adapter does the same.
- **Timeouts.** The first connection of a run may hit a paused cluster, which resumes in about 15 seconds, and 30 seconds or more after a pause of over 24 hours. The runner uses a 60 second connect timeout, retries a failed connection up to three times, and has a Lambda timeout of at least five minutes. In the app, `DatabaseResumingException` becomes a 503 with `Retry-After` (ADR 0007).

## Consequences

- The functions need no VPC networking, and the cluster can pause (ADR 0007).
- Each unit of work costs extra Data API calls (begin, set the path, commit). That is fine at demo volume. If latency matters, qualify table names with the schema instead.
- A response over 1 MiB ends the call, so lists stay paginated (at most 100 items).
- The endpoint costs money for as long as a runner exists: `prod` always, `dev` during a run. AWS's PrivateLink pricing example uses $0.01 per hour for each endpoint in each zone, about $7 a month, and $0.01 per GB processed. That example is for US East. **Unresolved:** the `us-west-2` rate is not on a page I could read, so `docs/cost.md` must check it.
- Two SQL code paths (Data API and `pg`) can drift, so a few deployed smoke tests stay as the backstop.
- Four users and four secrets have to be maintained, and password rotation is not set up.
- Runs that share `dev` must be serialized (ADR 0002). A GitHub concurrency group keeps one running run and at most one waiting run, and a newer waiting run cancels the older one. `queue: max` keeps up to 100 waiting runs, but cannot be combined with `cancel-in-progress` ([GitHub docs](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)). Phase 6 should use `queue: max` without `cancel-in-progress`, so a deploy is never cancelled halfway and leaks fewer schemas.
- Sources: [Data API `ExecuteStatement`](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html), [Data API limitations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.limitations.html), [Flyway clean](https://documentation.red-gate.com/fd/clean-277578871.html), [Flyway clean disabled](https://documentation.red-gate.com/fd/flyway-clean-disabled-setting-277578981.html), [Flyway create schemas](https://documentation.red-gate.com/fd/flyway-create-schemas-setting-277578984.html) and [Aurora auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html).
