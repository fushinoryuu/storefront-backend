# 0007: Aurora scaling and persistence

Status: accepted on 2026-11-04.

## Context

One Aurora cluster serves both stages (ADR 0002). Creating it takes 10 to 15 minutes, so it cannot be rebuilt for every run. `prod` is meant for ad hoc testing, and pull request runs of `dev` use the same cluster. The cluster can scale to zero capacity and pause, which leaves only storage to pay for, but the first request after a pause has to wait for it to resume. REST APIs wait 29 seconds for an integration by default (ADR 0003), so the wait matters.

## Options

- **Minimum 0 ACUs, with auto-pause.** An idle cluster costs storage and nothing else. The cost is a wait of about 15 seconds after a pause, and 30 seconds or more after a pause of over 24 hours.
- **A small nonzero minimum on `prod`.** No resume wait, but the cluster never pauses. At 0.5 ACUs and AWS's example rate of $0.12 per ACU-hour (US East), that is about $44 a month. The `us-west-2` rate was not confirmed.
- **A second cluster for `dev`.** Rejected in ADR 0002.

## Decision

- **Scale to zero.** The cluster has a minimum of 0 ACUs and a maximum of 4, as in `stages.ts`. The maximum is low so a runaway test cannot scale it up. `prod` may pause.
- **Auto-pause delay:** one hour (3600 seconds). The allowed range is 300 seconds (the default) to 86,400. A longer delay keeps the cluster awake between runs, and an idle hour costs little.
- **One writer, no readers.** Readers in failover tiers 0 and 1 pause and resume with the writer, and a reader makes the writer resume. A demo does not need them.
- **Nothing that holds it awake.** No RDS Proxy, no logical replication, no open connections from tools, and no probe that touches the database. `GET /v0/health` has no database access. Only `GET /v0/health/ready` uses it, and nothing calls that on a schedule.
- **Warm-up.** Tests and demos call `GET /v0/health/ready` first (it needs an API key, so anonymous callers cannot wake the cluster).
- **A paused cluster is a 503, not a timeout.** The Data API reports a paused cluster with `DatabaseResumingException` ("wait a few seconds and try again") and resumes it. The customers service turns that into a 503 with `Retry-After`, in one place, instead of waiting past the integration timeout. The Flyway runner waits instead, with the timeouts in ADR 0006.
- **Persistence.** The cluster, its VPC and its secrets are in `Storefront-prod-Database`, with termination protection, deletion protection and `RETAIN`. It is encrypted and keeps minimal backups. `dev` has no database stack.
- **Full deploy.** The full deploy mode (Phase 6) removes termination protection, destroys the stack and creates the cluster again. `prod` is then down for 10 to 15 minutes and its data is lost. It runs on demand, and the fast mode never touches the cluster.
- **Checking that it pauses.** The `ServerlessDatabaseCapacity` metric drops to 0 while the cluster is paused, and RDS events 0370 to 0374 report pausing and resuming. `docs/cost.md` records how to look, and Phase 6 checks it over several days.

## Consequences

- Idle cost is storage only. AWS says the instance charge is zero while paused and storage is still charged.
- The first call after an idle hour waits or gets a 503, and the wait is longer after a day. Callers must retry on 503 and honour `Retry-After`. Test setup and the library must warm up first.
- A paused cluster is not guaranteed. Maintenance resumes it, and after an administrative operation AWS waits at least 20 minutes before pausing again. The cleanup job from ADR 0006 and every run also wake it.
- Jobs inside the database, such as `pg_cron`, do not wake a paused cluster and are cancelled when it pauses. Nothing here uses them.
- If the wait is too painful for ad hoc testing, setting the `prod` minimum to 0.5 is a one-line change in `stages.ts`, at the cost above.
- One cluster is a shared failure point. A bad run can use up connections or capacity that `prod` needs, and the maximum of 4 ACUs is the limit.
- Sources: [Aurora auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html), [Data API `ExecuteStatement` errors](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html) and [Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/).
