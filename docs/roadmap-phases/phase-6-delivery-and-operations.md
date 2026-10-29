# Phase 6: Delivery and Operations

Make the system deployable by a pipeline instead of by hand, observable when it misbehaves, safe by default, and cheap to leave running. This is the phase that makes the project look like something a team could operate.

## Goals

- Pull request runs that deploy to `dev`, test and tear down, and an automated deployment of `prod` on merge to `main`, so a production-like stage is always up.
- Dashboards and alarms that answer "is it working?" without reading logs.
- A security and cost review with findings recorded.
- Runbooks for the failures you actually expect.

## Deliverables

| Deliverable | Location |
|---|---|
| CI workflow | `.github/workflows/ci.yaml` |
| Deploy workflow | `.github/workflows/deploy.yml` |
| OIDC role setup | `infra/lib/stacks/ci-access-stack.ts` or documented manual setup |
| Dashboards and alarms | `infra/lib/constructs/` and the service stacks |
| Security review | `docs/security.md` |
| Cost review and teardown | `docs/cost.md` |
| Runbooks | `docs/runbooks/` |

## Tasks

### 1. CI

Extend the Phase 0 workflow so every pull request runs:

- [ ] Install, lint, typecheck, unit tests for the whole repo.
- [ ] Repository tests that need containers (PostgreSQL, DynamoDB Local).
- [ ] CDK template tests with cdk-nag, and `cdk synth` for both stages.
- [ ] `cdk diff` against `dev`, posted as a pull request comment, so infrastructure changes are reviewed like code. This needs read-only AWS access through the OIDC role.
- [ ] OpenAPI lint and bundle (in CI since Phase 0), plus the spec-based response validation and conformance tests, so any drift between an `openapi.yaml` and its implementation fails the build (decision 0004).
- [ ] Event schema compatibility check.
- [ ] A dependency vulnerability scan.

### 2. AWS access from CI without long-lived keys

- [ ] A GitHub OIDC identity provider and IAM roles that trust only this repository (and specific branches or environments).
- [ ] One role for pull request `cdk diff` (read-only), one for deployment (scoped to deploying these stacks, not administrator).
- [ ] The schema cleanup job needs permission to run statements through the Data API on the cluster and to read its secret. Scope that to this cluster and secret only, and separate it from the deployment role if practical.
- [ ] Document the role boundaries and what each is allowed to do.

### 3. Deployment pipeline

- [ ] On a pull request: deploy the per-run stacks to `dev` against the shared database stack, run the tests, then tear down (see below). This is the gate before a merge.
- [ ] On merge to the main branch: deploy to `prod` with the stack order platform, customers, orders, shipping (use stack dependencies so CDK orders them). `prod` is never torn down by a pipeline.
- [ ] After deployment, run the deployed smoke checks and the end-to-end tests against `prod`. A failure marks the deployment as failed and is reported.
- [ ] Optional: make the `prod` deployment wait for a manual approval (a protected GitHub environment), to show the pattern. Decide whether the delay is worth it, because it keeps `prod` behind `main` until someone approves.
- [ ] The key retrieval script runs after deployment and updates the secrets the tests read.
- [ ] Publish the specs and the stage manifest as artifacts after a successful `dev` deploy (Phase 5).
- [ ] Concurrency control so two deployments to the same stage never run at once. This also protects the shared database, which every run uses, including `prod`. Use one concurrency group for all runs so pull requests on two branches queue and never collide on stack names. Only one run can wait in a group, so a newer waiting run replaces an older waiting one (check GitHub's current behavior).
- [ ] Two deploy modes. The fast mode deploys the `dev` per-run stacks against the shared database stack, runs the tests, and destroys the per-run stacks. The full mode also destroys and recreates the database stack (removing its termination protection first) and then redeploys `prod`. It runs on demand or occasionally to prove a from-scratch deploy still works, and it takes `prod` down for 10 to 15 minutes and wipes its data.
- [ ] Pull request runs use a database schema named from the Jira ticket key in the branch name. `prod` uses the `main` schema, which is never dropped.
- [ ] The teardown step runs even when the tests fail or the job is cancelled. It first cleans the PR's schema through the Flyway runner, because the runner is destroyed with its stack, then destroys an explicit list of the `dev` per-run stacks. It never touches the `prod` stage, the database stack or the `main` schema.
- [ ] A scheduled cleanup job that finds per-run stacks older than a few hours and destroys them, and drops stale PR schemas through the Data API, so a failed teardown does not keep costing money. The same schema cleanup runs when a pull request closes.
- [ ] The library project's tests run in the deploy-test-destroy flow. How the two repositories connect (this workflow checking out the library repository, or the library calling a reusable workflow here) is decided once the library repository exists.
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

- [ ] Compare actual spend against the budget after a week of use, by tag. Also measure the cost of one deploy-test-destroy run (database capacity while awake, the Secrets Manager endpoint, everything else) and the steady cost of the paused database.
- [ ] Verify that Aurora actually pauses when idle. Check the capacity metric over a quiet period, and find anything that holds it awake (probes, canaries, open connections, a proxy). The persistent cluster makes this checkable over days, and a run should be followed by a pause after the auto-pause delay.
- [ ] Check for forgotten resources: log groups without retention, unused snapshots, idle queues, orphaned secrets.
- [ ] Write and test the teardown procedure: the `cdk destroy` order, what survives destroy, and how to confirm the account is clean. Run it once for real on `dev` and redeploy. Cover both the per-run teardown that keeps the database and the full teardown that removes it.
- [ ] A short summary of what costs money when idle and what only costs money when used.

### 8. Runbooks

One page each, written for someone woken up by an alarm:

- [ ] **DLQ has messages:** find, inspect, fix, redrive (links to the shipping runbook).
- [ ] **API 5xx spike:** where to look, how to follow a correlation id, how to roll back.
- [ ] **Customers API slow or timing out:** Aurora resume, how to confirm, how to warm up, when to raise the minimum capacity.
- [ ] **Event not delivered:** check the Pipe, the stream age, the bus archive, and replay as a last resort.
- [ ] **Rotate an API key.**
- [ ] **Deploy failed or partially failed.**
- [ ] **Tear down and rebuild a stage,** including how to remove termination protection from the database stack and what happens to the persistent database.

## Acceptance criteria

- A merge to main deploys `prod` with no manual steps (or one approval, if the optional gate is on) and runs the end-to-end suite against it.
- A pull request run deploys to `dev`, passes the same checks and leaves nothing behind except the shared database stack.
- CI uses OIDC only, with no stored AWS access keys.
- Dashboards show the health of every service, and each alarm has been triggered at least once on purpose in `dev` to prove it works.
- The teardown procedure has been run and the redeploy from scratch succeeds.
- Security and cost docs list findings and the decisions taken.

## Risks and notes

- **Pipeline credentials are the real blast radius.** Scope the deployment role tightly, and restrict which branches can assume it.
- **Alarms that never fire are untested alarms.** Trigger each once.
- **Canaries and the database.** A health check that touches Aurora every minute defeats scale to zero.
- **Overbuilding operations for a demo.** Pick the dashboards and alarms that tell the story, and document the rest as what you would add at scale.
