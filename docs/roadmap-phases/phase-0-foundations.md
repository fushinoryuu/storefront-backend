# Phase 0: Foundations and Decisions

Set up the repo and the AWS environment, put cost guardrails in place before anything is deployed, and record the decisions that shape every later phase.

## Goals

- A monorepo that builds, tests, and synthesizes a (nearly empty) CDK app from day one.
- An AWS setup that is safe to experiment in and cheap to leave running.
- Two stages driven by configuration, not by copy-pasted code: `dev` for pull request runs and `prod`, a production-like stage that stays deployed from `main`.
- Decisions recorded as short decision records.

## Deliverables

| Deliverable                       | Location                                                      |
| --------------------------------- | ------------------------------------------------------------- |
| Repo skeleton                     | repo root                                                     |
| CDK app skeleton and stage config | `infra/`                                                      |
| Decision records                  | `docs/decisions/NNNN-title.md` (0004 is written in Phase 0.5) |
| Naming and tagging conventions    | `docs/conventions.md`                                         |
| Cost guardrails                   | AWS Budgets plus `docs/cost.md`                               |
| Minimal CI                        | `.github/workflows/ci.yaml`                                   |

## Target repo layout

```
.
├── README.md
├── package.json                  # single package for the whole repo
├── cdk.json
├── infra/
│   ├── bin/storefront.ts         # app entry, builds stacks per stage
│   ├── lib/
│   │   ├── config/stages.ts      # per-stage settings
│   │   ├── constructs/           # reusable constructs (Phase 1)
│   │   └── stacks/               # platform, secrets, database, customers, orders, shipping
│   └── test/                     # CDK template tests
├── services/
│   ├── customers/                # handlers, domain, migrations, openapi.yaml, tests
│   ├── orders/
│   └── shipping/
├── packages/
│   ├── shared/                   # logger, errors, correlation, idempotency
│   └── events/                   # event schemas and types
├── specs/                        # shared OpenAPI components and bundled specs (Phase 0.5)
├── docs/
└── .github/workflows/
```

## Tasks

### 1. Repo and tooling

- [x] One `package.json` and one lockfile for the whole repo. The services and packages are plain folders, not separate npm packages.
- [x] TypeScript strict mode with one root `tsconfig.json`, kept simple (no project references).
- [x] A Node LTS version pinned in `.nvmrc` and `engines`.
- [x] ESLint and a formatter, vitest for unit tests, one trivial passing test in each service and package folder.
- [x] `aws-cdk-lib` and `constructs` fixed by the lockfile, the CDK CLI as a dev dependency so everyone uses the same version.

### 2. AWS account and bootstrap

- [x] Use a dedicated AWS account (a member account of an AWS Organization) with its own profile, so experiments cannot touch anything else.
- [x] The region is `us-west-2`, and everything stays in it. Aurora Serverless v2 with scale to zero, the Data API and EventBridge Pipes are confirmed there (see `docs/aws-setup.md`).
- [x] Bootstrap CDK for the account and region.
- [x] Prefer short-lived credentials (SSO or an assumed role) for local work. CI will use OIDC (Phase 6).
- [x] Create the AWS Budget with an email alert at low thresholds before deploying anything.

### 3. Stages

- [x] A `stages.ts` file holds a typed config per stage: stack name prefix, removal policy, log retention, Aurora capacity settings, simulated carrier timings and alarm recipients.
- [ ] `dev`: where pull request runs deploy, test and tear down. Everything is destroyable (`RemovalPolicy.DESTROY`) with short log retention. It has no database stack of its own: it uses the Aurora cluster owned by `prod`, with one schema per pull request.
  - [x] `stages.ts` sets the `dev` values: `DESTROY`, one week of log retention, `Database` marked `external` and `databaseStage` set to `prod`.
  - [ ] The per-run stacks that `dev` deploys (Phases 1 to 4), and the schema per pull request in the shared cluster.
- [ ] `prod`: a production-like stage deployed from `main` and kept up at all times, so there is always something to test against. Every stack is persistent, which means a test run does not destroy it. Like `dev`, every resource is `RemovalPolicy.DESTROY` and every stack deploys and destroys with one command, except the database stack. The stage also has point-in-time recovery on DynamoDB and longer log retention. It owns the single Aurora cluster (minimum capacity 0, so it can pause, see ADR 0007) in a database stack with CloudFormation termination protection on, so `cdk destroy --all` cannot remove it by accident. The cluster holds the `main` schema and the PR schemas.
  - [x] `stages.ts` sets the `prod` values: `DESTROY`, one month of log retention, Aurora capacity 0 to 4 ACU, and every stack marked `persistent`.
  - [x] A test (`infra/test/destroyable-stacks.test.ts`) synthesizes every stack of both stages. None has a resource with a retain policy, and only `ApiGatewayAccount` has termination protection. The database stack adds itself to that list when it is built.
  - [ ] The database stack with the Aurora cluster and CloudFormation termination protection.
  - [ ] Point-in-time recovery on the DynamoDB table, with the orders stack.
- [ ] Both stages in the same account and region as separate stacks named `Storefront-<stage>-<Service>`. The one database stack is `Storefront-prod-Database`, and `dev` reads its connection details.
  - [x] Both stages share the one member account and region (`docs/aws-setup.md`), and `infra/lib/naming.ts` builds the stack names, including `Storefront-prod-Database`. The `Platform` stack already uses it. The stacks that belong to no stage, `Storefront-Secrets` and `Storefront-ApiGatewayAccount`, are the exception (decision 0002).
  - [ ] The database stack, and `dev` reading its connection details.
- [ ] Mark each stack in `stages.ts` as persistent, per-run or external (owned by another stage). In `dev` every stack except the database is per-run, and in `prod` every stack is persistent. A teardown script lists the per-run stacks explicitly instead of destroying everything.
  - [x] `stages.ts` marks every stack as `persistent`, `per-run` or `external`: in `dev` every stack except `Database` is `per-run`, and in `prod` every stack is `persistent`.
  - [ ] The teardown script that lists the per-run stacks explicitly (Phase 6).

### 4. Conventions

Write `docs/conventions.md` once and apply it everywhere:

- [x] Resource naming: stage and service in every name, no hard-coded physical names where CloudFormation can generate them.
- [x] Tags applied by an Aspect: `project`, `stage`, `service`, `owner`.
- [ ] Log group retention set explicitly on every Lambda.
  - [x] Done: the rule is in `docs/conventions.md` (Logs), and `ServiceFunction` creates the log group with the retention of the stage.
  - [ ] Remaining: every function of the services uses `ServiceFunction` (Phases 2 to 4).
- [x] Event naming: `source` is `storefront.<service>`, `detail-type` is PascalCase past tense (`OrderPlaced`).
- [ ] Error responses use one shared shape across services (Phase 1).
  - [x] Done: the shape is the `Problem` schema of the shared spec components, and `packages/shared` maps errors to it, checked against the spec examples.
  - [ ] Remaining: the responses API Gateway produces itself (`ServiceApi`, Phase 1), and each service using the shared error model (Phases 2 to 4).
- [x] Commit and branch conventions, and how decision records are numbered. Every branch name starts with the Jira ticket key (for example `BEP-123-add-address-api`). Pipelines derive the PR's database schema name from that key: lowercase, hyphen replaced by underscore (`bep_123`), at most 63 bytes. The main branch uses the fixed schema name `main`.

### 5. Decision records

Each record: context, options, decision, consequences. One page.

| #    | Decision                           | Options and default                                                                                                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | Repo layout                        | One repo with a single package (default) or one repo per service                                                                                                                                                                                                                                                                                         |
| 0002 | Stack boundaries and stages        | One stack per service plus platform and one persistent database stack (default); platform and database deployed first. Two stages: `dev` for PR runs, whose stacks are destroyed after each run, and `prod`, a production-like stage deployed from `main` that stays up and owns the database stack, shared with `dev` through per-schema database users |
| 0003 | API type                           | REST API (decided). Required for API keys and usage plans, which HTTP APIs do not support                                                                                                                                                                                                                                                                |
| 0004 | API definition                     | Spec-first, OpenAPI 3.0.3 (decided, written in Phase 0.5). The hand-written `openapi.yaml` is the source of truth                                                                                                                                                                                                                                        |
| 0005 | Auth                               | API Gateway API keys with usage plans (decided). Separate keys for `tests`, `services`, `admin`. Record the limits and what production would use instead                                                                                                                                                                                                 |
| 0006 | Aurora connectivity and migrations | RDS Data API for the app, and Flyway in an in-VPC container Lambda with a Secrets Manager interface endpoint for migrations (decided). Alternatives: VPC Lambda with RDS Proxy, a NAT gateway, or a non-Flyway runner over the Data API                                                                                                                  |
| 0007 | Aurora scaling and persistence     | One shared cluster owned by `prod`, minimum capacity 0 with auto-pause after one hour (decided: `prod` may pause). The cluster persists between test runs in its own stack                                                                                                                                                                               |
| 0008 | Event publishing from orders       | DynamoDB Streams plus EventBridge Pipes (default) or direct `PutEvents`                                                                                                                                                                                                                                                                                  |
| 0009 | Service-to-service calls           | Orders calls customers synchronously (default) or keeps a customer projection from events                                                                                                                                                                                                                                                                |
| 0010 | Observability toolkit              | Powertools for AWS Lambda (TypeScript) or a small in-house layer                                                                                                                                                                                                                                                                                         |

The harder ones are settled in their records:

- **0004:** spec-first, and how the code stays tied to the spec (`docs/decisions/0004-api-definition.md`).
- **0006:** how the functions reach the database, how migrations run, and how a pull request run is kept away from the `main` schema (`docs/decisions/0006-aurora-connectivity-and-migrations.md`).
- **0007:** scale to zero, the wait after a pause, and what a full deploy does to `prod` (`docs/decisions/0007-aurora-scaling-and-persistence.md`).

### 6. Cost guardrails

- [x] Budget alarm in place (see above), with a monthly limit you are comfortable with.
- [ ] Avoid NAT gateways. They are a common source of surprise cost, and the default design does not need one.
- [ ] DynamoDB in on-demand mode, short log retention, API throttling set low.
  - [x] Done: log retention is short and set by the stage (`ServiceFunction`, `ServiceApi`), and `ServiceApi` throttles every method at the `api.defaultThrottle` of the stage config.
  - [ ] Remaining: DynamoDB in on-demand mode, with the orders and shipping tables (Phases 3 and 4).
- [x] A documented `cdk destroy` order and a list of resources that survive destroy (log groups with retention, snapshots, secrets pending deletion). It is in `docs/cost.md`, and Phase 6 builds and rehearses it.
- [ ] Test runs deploy to `dev`, test, then destroy every per-run stack. The `prod` stage stays up, including the shared database stack, because creating the cluster takes 10 to 15 minutes and a paused cluster costs storage only. `prod` also keeps its own Flyway runner and Secrets Manager interface endpoint (about $7 a month, see `docs/cost.md`) for as long as it is deployed. Pull request runs also drop their own database schema before the stacks are destroyed. Document the full teardown too, which first removes termination protection from the database stack.
- [x] `docs/cost.md` records expected idle and active cost behavior in words, with a note to check current AWS pricing when you build, since prices change.

### 7. Minimal CI

- [x] On every pull request and every push to `main`: install, lint, typecheck, unit tests, `cdk synth` for both stages.
- [x] Once Phase 0.5 adds the spec tooling: OpenAPI lint and the bundle step.
- [x] No AWS credentials needed yet. Deployment automation arrives in Phase 6.

## Acceptance criteria

- `npm test` and `cdk synth` pass on a fresh clone for both stages.
- Budget alarm exists, with email alerts at low thresholds.
- All ten decision records exist, even if some are short. Record 0004 is written in Phase 0.5.
- Conventions are written and an Aspect applies the tags.

## Risks and notes

- **Decision paralysis.** Every record has a default. Use it unless you have a reason not to, and write the reason down.
- **Region mismatch.** Features available in one region may be missing in another. Check before bootstrapping.
- **Cost drift.** Many small things (logs, idle databases, NAT) add up. The budget alarm is the safety net, not a plan.
