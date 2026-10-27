# Phase 0: Foundations and Decisions

Set up the repo and the AWS environment, put cost guardrails in place before anything is deployed, and record the decisions that shape every later phase.

## Goals

- A monorepo that builds, tests, and synthesizes a (nearly empty) CDK app from day one.
- An AWS setup that is safe to experiment in and cheap to leave running.
- Two stages (`dev`, `staging`) driven by configuration, not by copy-pasted code.
- Decisions recorded as short decision records.

## Deliverables

| Deliverable | Location |
|---|---|
| Repo skeleton | repo root |
| CDK app skeleton and stage config | `infra/` |
| Decision records | `docs/decisions/NNNN-title.md` |
| Naming and tagging conventions | `docs/conventions.md` |
| Cost guardrails | AWS Budgets plus `docs/cost.md` |
| Minimal CI | `.github/workflows/ci.yml` |

## Target repo layout

```
.
├── README.md
├── package.json                  # npm workspaces
├── cdk.json
├── infra/
│   ├── bin/storefront.ts         # app entry, builds stacks per stage
│   ├── lib/
│   │   ├── config/stages.ts      # per-stage settings
│   │   ├── constructs/           # reusable constructs (Phase 1)
│   │   └── stacks/               # platform, customers, orders, shipping
│   └── test/                     # CDK template tests
├── services/
│   ├── customers/                # handlers, domain, migrations, openapi.yaml, tests
│   ├── orders/
│   └── shipping/
├── packages/
│   ├── shared/                   # logger, errors, correlation, idempotency
│   └── events/                   # event schemas and types
├── docs/
└── .github/workflows/
```

## Tasks

### 1. Repo and tooling

- [ ] npm workspaces (or your preferred workspace tool) with one lockfile.
- [ ] TypeScript strict mode, a shared base `tsconfig`, project references or path aliases kept simple.
- [ ] A Node LTS version pinned in `.nvmrc` and `engines`.
- [ ] ESLint and a formatter, vitest for unit tests, one trivial passing test per workspace.
- [ ] `aws-cdk-lib` and `constructs` pinned, the CDK CLI as a dev dependency so everyone uses the same version.

### 2. AWS account and bootstrap

- [ ] Use the personal AWS account with a dedicated profile, so experiments cannot touch anything else.
- [ ] The region is `us-west-2`, and everything stays in it. Aurora Serverless v2 with scale to zero and the Data API are confirmed there. Still check that EventBridge Pipes is available.
- [ ] Bootstrap CDK for the account and region.
- [ ] Prefer short-lived credentials (SSO or an assumed role) for local work. CI will use OIDC (Phase 6).
- [ ] Create the AWS Budget with an email alert at low thresholds before deploying anything.

### 3. Stages

- [ ] A `stages.ts` file holds a typed config per stage: stack name prefix, removal policy, log retention, Aurora capacity settings, simulated carrier timings, alarm recipients, deletion protection.
- [ ] `dev`: everything destroyable (`RemovalPolicy.DESTROY`, no deletion protection), short log retention, Aurora minimum capacity 0.
- [ ] `staging`: closer to production habits (point-in-time recovery on DynamoDB, deletion protection on the database, longer retention), still easy to tear down on purpose.
- [ ] Both stages in the same account and region as separate stacks named `Storefront-<stage>-<Service>`. Document how to move a stage into its own account later.

### 4. Conventions

Write `docs/conventions.md` once and apply it everywhere:

- [ ] Resource naming: stage and service in every name, no hard-coded physical names where CloudFormation can generate them.
- [ ] Tags applied by an Aspect: `project`, `stage`, `service`, `owner`.
- [ ] Log group retention set explicitly on every Lambda.
- [ ] Event naming: `source` is `storefront.<service>`, `detail-type` is PascalCase past tense (`OrderPlaced`).
- [ ] Error responses use one shared shape across services (Phase 1).
- [ ] Commit and branch conventions, and how decision records are numbered.

### 5. Decision records

Each record: context, options, decision, consequences. One page.

| # | Decision | Options and default |
|---|---|---|
| 0001 | Repo layout | Monorepo with workspaces (default) or one repo per service |
| 0002 | Stack boundaries | One stack per service plus platform (default); platform deployed first |
| 0003 | API type | REST API (decided). Required for API keys and usage plans, which HTTP APIs do not support |
| 0004 | API definition | Code-first with schemas generating OpenAPI, or spec-first (see below) |
| 0005 | Auth | API Gateway API keys with usage plans (decided). Separate keys for `tests`, `services`, `admin`. Record the limits and what production would use instead |
| 0006 | Aurora connectivity | RDS Data API (default) or VPC Lambda with RDS Proxy |
| 0007 | Aurora scaling | Minimum capacity 0 with auto-pause in `dev`, decide for `staging` |
| 0008 | Event publishing from orders | DynamoDB Streams plus EventBridge Pipes (default) or direct `PutEvents` |
| 0009 | Service-to-service calls | Orders calls customers synchronously (default) or keeps a customer projection from events |
| 0010 | Observability toolkit | Powertools for AWS Lambda (TypeScript) or a small in-house layer |

Notes for the harder ones:

- **0004:** Spec-first (write `openapi.yaml`, then implement) makes the contract the starting point, which suits the library project. Code-first (define schemas, for example with Zod, and generate the spec) keeps validation, types, and spec in one place and removes drift. Pick one, and either way commit the spec file and check in CI that it matches. A spec-first design with REST API routes defined in CDK also works, with contract tests catching drift. REST APIs can import an OpenAPI document directly, but that needs API Gateway integration extensions inside the spec, which clutters the contract the library consumes. Prefer defining routes in CDK and keeping the published spec clean.
- **0006:** Data API removes VPC networking from the Lambda functions and works with auto-pause, but each request is a new HTTP call and local testing needs an adapter. A VPC Lambda with a connection pool is conventional and easy to test locally, but needs private networking, and an associated RDS Proxy prevents the cluster from pausing. Data API support for Aurora PostgreSQL in `us-west-2` is confirmed for every engine version that supports scale to zero, so it is not a blocker.
- **0007:** After a long pause, resume can take 30 seconds or more, which approaches typical API timeouts. Decide how clients and tests cope (warm-up call, generous timeouts) or keep a small nonzero minimum on `staging`.

### 6. Cost guardrails

- [ ] Budget alarm in place (see above), with a monthly limit you are comfortable with.
- [ ] Avoid NAT gateways. They are a common source of surprise cost, and the default design does not need one.
- [ ] DynamoDB in on-demand mode, short log retention, API throttling set low.
- [ ] A documented `cdk destroy` order and a list of resources that survive destroy (log groups with retention, snapshots, secrets pending deletion).
- [ ] `docs/cost.md` records expected idle and active cost behavior in words, with a note to check current AWS pricing when you build, since prices change.

### 7. Minimal CI

- [ ] On every push and pull request: install, lint, typecheck, unit tests, `cdk synth` for both stages.
- [ ] No AWS credentials needed yet. Deployment automation arrives in Phase 6.

## Acceptance criteria

- `npm test` and `cdk synth` pass on a fresh clone for both stages.
- Budget alarm exists and sends a test notification.
- All ten decision records exist, even if some are short.
- Conventions are written and an Aspect applies the tags.

## Risks and notes

- **Decision paralysis.** Every record has a default. Use it unless you have a reason not to, and write the reason down.
- **Region mismatch.** Features available in one region may be missing in another. Check before bootstrapping.
- **Cost drift.** Many small things (logs, idle databases, NAT) add up. The budget alarm is the safety net, not a plan.
