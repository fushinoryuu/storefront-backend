# Phase 6: Delivery and Operations

Make the system deployable by a pipeline instead of by hand, observable when it misbehaves, safe by default, and cheap to leave running. This is the phase that makes the project look like something a team could operate.

## Goals

- Automated deployment to `dev` on merge, and gated promotion to `staging`.
- Dashboards and alarms that answer "is it working?" without reading logs.
- A security and cost review with findings recorded.
- Runbooks for the failures you actually expect.

## Deliverables

| Deliverable | Location |
|---|---|
| CI workflow | `.github/workflows/ci.yml` |
| Deploy workflow | `.github/workflows/deploy.yml` |
| OIDC role setup | `infra/lib/stacks/ci-access-stack.ts` or documented manual setup |
| Dashboards and alarms | `infra/lib/constructs/` and the service stacks |
| Security review | `docs/security.md` |
| Cost review and teardown | `docs/cost.md` |
| Runbooks | `docs/runbooks/` |

## Tasks

### 1. CI

Extend the Phase 0 workflow so every pull request runs:

- [ ] Install, lint, typecheck, unit tests for every workspace.
- [ ] Repository tests that need containers (PostgreSQL, DynamoDB Local).
- [ ] CDK template tests with cdk-nag, and `cdk synth` for both stages.
- [ ] `cdk diff` against `dev`, posted as a pull request comment, so infrastructure changes are reviewed like code. This needs read-only AWS access through the OIDC role.
- [ ] OpenAPI lint and bundle (in CI since Phase 0), plus the spec-based response validation and conformance tests, so any drift between an `openapi.yaml` and its implementation fails the build (decision 0004).
- [ ] Event schema compatibility check.
- [ ] A dependency vulnerability scan.

### 2. AWS access from CI without long-lived keys

- [ ] A GitHub OIDC identity provider and IAM roles that trust only this repository (and specific branches or environments).
- [ ] One role for pull request `cdk diff` (read-only), one for deployment (scoped to deploying these stacks, not administrator).
- [ ] Document the role boundaries and what each is allowed to do.

### 3. Deployment pipeline

- [ ] On merge to the main branch: deploy to `dev` with the stack order platform, customers, orders, shipping (use stack dependencies so CDK orders them).
- [ ] After deployment, run the deployed smoke checks and the end-to-end tests against `dev`. A failure marks the deployment as failed and blocks promotion.
- [ ] Promotion to `staging` behind a manual approval (a protected GitHub environment), running the same checks afterward.
- [ ] The key retrieval script runs after deployment and updates the secrets the tests read.
- [ ] Publish the specs and the stage manifest as artifacts after a successful `dev` deploy (Phase 5).
- [ ] Concurrency control so two deployments to the same stage never run at once.
- [ ] Rollback approach documented: CloudFormation rolls back failed deployments automatically, and for a bad but successful deployment you redeploy the previous commit. Note Lambda versions and aliases as a stretch for traffic shifting.
- [ ] Alternative: CDK Pipelines instead of GitHub Actions. Record which you chose and why.

### 4. Drift and consistency

- [ ] A scheduled job that runs CloudFormation drift detection (or `cdk diff` against the deployed stack) and reports differences.
- [ ] A rule in the docs: no console changes to deployed resources.

### 5. Observability

- [ ] **Dashboards** (CDK `Dashboard`): one per service plus an overview. Include API request count, 4xx and 5xx, latency (p50 and p95), Lambda errors, throttles, duration, concurrent executions, DynamoDB throttles and consumed capacity, queue depth and age of oldest message, DLQ depth, workflow failures, Aurora ACU and connections and whether the cluster is paused.
- [ ] **Alarms** to the SNS topic, with thresholds chosen and written down: API 5xx rate, p95 latency, Lambda error rate, any message in a DLQ, oldest message age, Pipes failures, workflow failures, database connection saturation.
- [ ] **Tracing:** X-Ray enabled on APIs, functions, and the state machine, with correlation ids searchable in logs.
- [ ] **Log queries:** saved CloudWatch Logs Insights queries for "follow one correlation id across services" and "errors in the last hour".
- [ ] **Synthetic check:** a scheduled canary or a scheduled workflow that calls `GET /version` and one authenticated read on each service, and alarms on failure. Keep it from holding the database awake (use the version and health endpoints that do not touch it, plus a rare readiness check).
- [ ] **Custom business metrics** emitted in the embedded metric format: orders placed, orders cancelled, shipment lag.

### 6. Security review

Write `docs/security.md` with findings and fixes.

- [ ] **cdk-nag findings** reviewed. Every suppression has a reason and an owner.
- [ ] **IAM:** each function has only the permissions it needs. No wildcard resource policies without a documented reason.
- [ ] **Secrets:** API keys and database credentials live in Secrets Manager, not in code, environment variables in plain text, or logs. Verify redaction in logs.
- [ ] **API keys:** separate keys per caller type, usage plans with throttle and quota, a rotation procedure that has been rehearsed once, and the documented limitation that keys are shared secrets. Describe what production would use (for example Cognito or IAM authorization).
- [ ] **Data:** encryption at rest for Aurora and DynamoDB, TLS everywhere, no personal data beyond fake test data.
- [ ] **Input handling:** request validation at the edge (API Gateway request validators) and in handlers, body size limits, no SQL string concatenation (parameterized queries only), a test that tries injection strings against the customers API.
- [ ] **Network:** the database is not publicly accessible, and there is no NAT gateway unless a documented need appears.
- [ ] **WAF** as an optional stretch, noting its cost.
- [ ] **Dependencies:** a vulnerability scan in CI and a routine for updating dependencies.

### 7. Cost review

- [ ] Compare actual spend against the budget after a week of use, by tag.
- [ ] Verify that Aurora actually pauses when idle. Check the capacity metric over a quiet period, and find anything that holds it awake (probes, canaries, open connections, a proxy).
- [ ] Check for forgotten resources: log groups without retention, unused snapshots, idle queues, orphaned secrets.
- [ ] Write and test the teardown procedure: the `cdk destroy` order, what survives destroy, and how to confirm the account is clean. Run it once for real on `dev` and redeploy.
- [ ] A short summary of what costs money when idle and what only costs money when used.

### 8. Runbooks

One page each, written for someone woken up by an alarm:

- [ ] **DLQ has messages:** find, inspect, fix, redrive (links to the shipping runbook).
- [ ] **API 5xx spike:** where to look, how to follow a correlation id, how to roll back.
- [ ] **Customers API slow or timing out:** Aurora resume, how to confirm, how to warm up, when to raise the minimum capacity.
- [ ] **Event not delivered:** check the Pipe, the stream age, the bus archive, and replay as a last resort.
- [ ] **Rotate an API key.**
- [ ] **Deploy failed or partially failed.**
- [ ] **Tear down and rebuild a stage.**

## Acceptance criteria

- A merge to main deploys `dev` with no manual steps and runs the end-to-end suite against it.
- Promotion to `staging` requires approval and passes the same checks.
- CI uses OIDC only, with no stored AWS access keys.
- Dashboards show the health of every service, and each alarm has been triggered at least once on purpose in `dev` to prove it works.
- The teardown procedure has been run and the redeploy from scratch succeeds.
- Security and cost docs list findings and the decisions taken.

## Risks and notes

- **Pipeline credentials are the real blast radius.** Scope the deployment role tightly, and restrict which branches can assume it.
- **Alarms that never fire are untested alarms.** Trigger each once.
- **Canaries and the database.** A health check that touches Aurora every minute defeats scale to zero.
- **Overbuilding operations for a demo.** Pick the dashboards and alarms that tell the story, and document the rest as what you would add at scale.
