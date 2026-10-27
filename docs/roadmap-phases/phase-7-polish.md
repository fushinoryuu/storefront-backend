# Phase 7: Polish

Make the project easy to understand and trustworthy to a reader who has two minutes. The architecture, the decisions behind it, and the evidence that it works should all be easy to find.

## Goals

- A README that explains the system, shows it running, and says how to deploy it.
- Architecture diagrams that match what was actually built.
- Decision records and service docs that read as a coherent story.
- Measured results instead of adjectives.
- A repo that is clean, safe to share, and safe to leave running.

## Deliverables

| Deliverable | Location |
|---|---|
| Final README | `README.md` |
| Architecture and flow diagrams | `docs/architecture.md` (Mermaid) |
| Per-service docs | `docs/services/` |
| Finalized decision records | `docs/decisions/` |
| Demo recording or annotated trace | `docs/demo/` |
| Measured results | `docs/results.md` |
| Limitations and next steps | `docs/limitations.md` |
| Resume bullets and interview notes | kept outside the repo |

## Tasks

### 1. README

- [ ] One paragraph: what this is (a fake online store backend on AWS with CDK) and why it is shaped this way (three services, three styles).
- [ ] The architecture diagram near the top.
- [ ] A table of the services: data store, communication style, responsibilities, link to its doc.
- [ ] Quick start: prerequisites, AWS profile and region, bootstrap, `deploy dev`, retrieve API keys, run the smoke tests.
- [ ] Cost note: what it costs idle, what it costs in use, and how to tear it down. Link to `docs/cost.md`.
- [ ] Auth note: API keys, what they do and do not provide, and what production would use.
- [ ] Testing section: unit, repository, CDK, contract, end-to-end, and what each costs and needs.
- [ ] A short "design decisions" list linking to the records.
- [ ] CI badge and license.

### 2. Diagrams

Mermaid diagrams checked into the repo, kept in sync with the code.

- [ ] **System overview:** clients, three APIs, data stores, event bus, queues, workflow.
- [ ] **Place-an-order sequence:** API call, customer validation, write, stream, pipe, event bus, shipping consumer, workflow, events back, order status updates. Annotate where idempotency and retries matter.
- [ ] **Order and shipment state machines.**
- [ ] **Deployment pipeline:** pull request checks, deploy to `dev`, promotion to `staging`.
- [ ] **Failure path:** poison message to DLQ to alarm to runbook.

### 3. Service docs and decisions

- [ ] Each service doc covers: purpose, data model or table design, API summary, events in and out, failure behavior, how to run its tests.
- [ ] Review every decision record. Update the ones where reality differed from the plan, and say what changed and why.
- [ ] Add a "what I would change next" section to each service doc.

### 4. Demo

Pick one format.

- **Short recording**, under three minutes: deploy status, place an order, watch the order move through states, show the correlation id in logs across services, trigger a poison message and show the DLQ alarm.
- **Annotated trace:** the same sequence as a written walkthrough with real log lines, event payloads, and a dashboard screenshot.

- [ ] Script it so it is repeatable.
- [ ] Use only fake data.

### 5. Measured results

Only claim what you measured. Record the date, region, and settings.

- [ ] End-to-end latency from `POST /orders` to `CONFIRMED`, `SHIPPED`, `DELIVERED` with the dev timings.
- [ ] Cold start times for the Lambda functions, and the Aurora resume time after a pause (measured, not quoted).
- [ ] Test counts by type, and how long the CI pipeline takes.
- [ ] Idle versus active cost behavior, from the cost review.
- [ ] Failure handling evidence: duplicate event produced one shipment, poison message reached the DLQ, concurrency test passed.
- [ ] Include the commands to reproduce the numbers.

### 6. Limitations and next steps

- [ ] What the project does not do: real payments, inventory, authentication beyond API keys, multi-region, real carriers.
- [ ] Known tradeoffs taken for a demo: publish-after-commit in customers, API keys, a simulation endpoint, a small catalog.
- [ ] What would change at larger scale: per-service accounts, a proper identity provider, schema registry, contract testing between teams, a customer projection in orders, a separate catalog service.

### 7. Repo hygiene

- [ ] Secrets scan across files and history, and confirmation that no API key values, account ids, or personal data are committed.
- [ ] Confirm all data and names are fake.
- [ ] Remove dead code, stale TODOs, and unused constructs.
- [ ] License, repository description, and topics.
- [ ] Verify a fresh clone can follow the README to a deployed `dev` stage.
- [ ] Confirm the budget alarm and teardown instructions, and decide whether to leave the stack running or point readers to the demo recording instead. A public API with a key in the README is not acceptable. If you leave it running, keep keys private.

### 8. Resume and interview material

Draft bullets in this shape and adjust to what was built and measured:

- Designed and built a three-service event-driven backend on AWS with CDK in TypeScript: customers on Aurora Serverless v2, orders on DynamoDB, shipping driven by EventBridge, SQS, and Step Functions.
- Implemented reliable messaging: transactional outbox through DynamoDB Streams and EventBridge Pipes, idempotent consumers, dead-letter queues with alarms and runbooks.
- Built reusable CDK constructs and shared libraries, with template tests and cdk-nag enforced in CI, and deployment through GitHub Actions with OIDC and gated promotion.
- Published OpenAPI contracts for each service and verified deployed behavior with conformance and event contract tests.

Prepare short answers for:

- [ ] Why DynamoDB for orders and Aurora for customers?
- [ ] How do you design a DynamoDB table, and what did you get wrong first?
- [ ] How do you guarantee an event is published when data changes?
- [ ] What happens when a consumer receives the same event twice, or out of order?
- [ ] How did you keep cost down, and how do you know Aurora pauses?
- [ ] What are the limits of API key authentication, and what would you use instead?
- [ ] How do you test event-driven systems?
- [ ] What would you change to scale this to many teams?

## Acceptance criteria

- A stranger can read the README, understand the system, and deploy `dev` in under an hour.
- Every claim in the README and on the resume maps to a test, a measurement, or a runbook in the repo.
- No secrets, no personal data, and no running public endpoint exposing a key.
- The diagrams match the deployed system.

## Risks and notes

- **Stale diagrams.** Diagrams drift quickly. Review them in the same pull request as any architecture change.
- **Overclaiming.** Say what was measured and where. "Handles duplicate events" should link to the test that proves it.
- **Leaving it running.** An open API with a leaked key can cost money. Prefer a recording, a mock, or a stage you can switch off.
