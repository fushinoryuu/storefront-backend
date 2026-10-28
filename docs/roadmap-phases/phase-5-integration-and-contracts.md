# Phase 5: Integration and Contracts

Each service is tested on its own. This phase proves they work together, proves each one honors its published contract, and prepares the handoff to the library project, whose generated clients are only as good as the specs published here.

## Goals

- End-to-end flows across all three services, including failure cases.
- API conformance: the deployed services behave as their OpenAPI specs say.
- Event contract tests for producers and consumers.
- Specs, base URLs, and keys published in a form the library project can consume.
- Planned spec changes ready for the library demo.

## Deliverables

| Deliverable | Location |
|---|---|
| End-to-end tests | `tests/e2e/` |
| API conformance setup | `tests/contract/api/` |
| Event contract tests | `tests/contract/events/` |
| Seed and reset scripts | `scripts/seed.ts`, `scripts/reset.ts` |
| Published specs | `specs/` (bundled from `services/*/openapi.yaml` by the Phase 0.5 script) |
| Spec publishing doc | `docs/spec-handoff.md` (started in Phase 0.5, extended here) |
| Planned spec changes | `docs/spec-changes/` |

## Tasks

### 1. Test harness for deployed environments

- [ ] A small helper that reads base URLs from SSM and the API keys from Secrets Manager (or a local untracked file produced by the key retrieval script) for a chosen stage. Per-run stacks are destroyed after tests, so URLs and keys change on every deploy and nothing should cache them between runs.
- [ ] Plain `fetch` calls in this repo's own end-to-end tests. The library project can later replace them with generated clients, but this project should not depend on it.
- [ ] A warm-up step that calls the customers `GET /health/ready` endpoint with the `tests` key and a generous timeout, before the first test, so an Aurora resume does not look like a failure.
- [ ] Polling helper for eventual consistency (poll a condition with a timeout and interval, never a fixed sleep).
- [ ] Every test creates uniquely named data and removes what it created, where a delete operation exists. For data with no delete (orders, shipments), tag it with a run id and rely on a reset script and TTLs.

### 2. End-to-end flows

- [ ] **Happy path:** create customer, add an address, place an order, wait for `CONFIRMED`, advance the shipment through the admin key, see `SHIPPED`, then `DELIVERED` on the order.
- [ ] **Idempotent order:** repeat `POST /orders` with the same key twice and assert one order.
- [ ] **Unknown customer:** order placement fails cleanly with the expected status and error shape.
- [ ] **Cancel before shipment:** the order and shipment both end `CANCELLED`.
- [ ] **Cancel after shipment:** rejected with a 409.
- [ ] **Customers unavailable:** simulate by pointing the orders service at a failing target in a test stage, or by using a feature flag, and assert a 503 with the shared error shape. (If this cannot be done safely in a deployed stage, cover it in the orders handler tests instead and say so.)
- [ ] **Duplicate and poison events:** publish a duplicate `OrderPlaced` and a malformed one directly to the bus in `dev`, and assert one shipment and one DLQ message.
- [ ] **Cold database:** after the cluster has paused, the first customer request succeeds within the documented timeout. The database persists between test runs, so this happens naturally whenever the gap between runs is longer than the auto-pause delay. Also keep an on-demand version that waits for the pause.
- [ ] Mark long or destructive tests so they run only on demand.

### 3. API conformance tests

Check that what is deployed matches what the spec promises.

- [ ] Choose a spec-driven conformance approach and record it. Options: a property-based API tester driven from the OpenAPI file (Schemathesis is one example), or generated assertions that validate each response against its schema in your own tests.
- [ ] Run it against `dev` for each service.
- [ ] Check at least: response bodies match their schemas, documented status codes are returned for documented failures, undocumented status codes are flagged, required fields are present, and the shared error shape is used for every error.
- [ ] Include the gateway-generated responses (missing key, throttling) in the checks, since they are part of what clients see.
- [ ] Treat a conformance failure as either an implementation bug or a spec bug, and fix whichever is wrong.

### 4. Event contract tests

- [ ] **Producer side:** capture events from real runs (or from handler tests) and validate them against the JSON Schemas for each event type.
- [ ] **Consumer side:** a library of sample events (valid, with optional fields missing, with extra fields, with a newer `schemaVersion`) fed to each consumer's handler, asserting the documented behavior.
- [ ] A check that every event type used in code has a schema, and every schema is used.
- [ ] A compatibility check between schema versions: additive changes pass, removing or retyping a field fails.

### 5. Seed and reset

- [ ] `seed` creates fake customers through the API (and catalog data is already static), so a fresh stage has something to look at.
- [ ] `reset` removes test data: delete customers created by tests, and clear orders and shipments tagged with test run ids using an admin-only code path that exists only in non-protected stages. If this requires extra infrastructure, keep it small and document it.
- [ ] All data is fake. Run ids and test markers make it easy to find and remove.

### 6. Publish specs for the library project

- [ ] The specs were drafted in Phase 0.5 and released as v1.0.0 in Phases 2 to 4. Confirm each one still has: stable `operationId` for every operation, a `tag` per endpoint group (the library turns tags into `service.group.operation` calls), `info.version` bumped on every change, the shared error schema, an `apiKey` security scheme using the `x-api-key` header, and examples. The lint rules from Phase 0.5 enforce this.
- [ ] Keep API Gateway integration extensions out of the published specs (see decision 0004), so the library consumes a clean contract.
- [ ] Extend the Phase 0.5 bundle script to record the source commit in a small `sources.json`. CI uploads the bundled specs as a build artifact or release asset, so the library project can pull a specific version.
- [ ] Publish a stage manifest (a JSON file or SSM parameter set): service names, base URLs per stage, the name of the secret holding each caller key, and the spec version deployed. The library's global setup reads this and can compare the deployed `GET /version` with the spec version it was generated from.
- [ ] Extend `docs/spec-handoff.md` (started in Phase 0.5) with the final handoff: where specs live, how versions are bumped, how a consumer gets keys, the stage manifest, and the Aurora warm-up note.

### 7. Plan the demo spec changes

These feed the library demo (non-breaking then breaking). Write each as a short change note with the exact edits, the implementation change needed, and the expected effect on a generated client.

- [ ] **v1.1.0, non-breaking:**
  - customers: add an optional `preferredLanguage` field.
  - orders: add `GET /orders/{orderId}/timeline` (status history) and an optional `notes` field on order creation.
  - shipping: add an optional `carrier` filter on `GET /shipments`.
- [ ] **v2.0.0, breaking:**
  - orders: `POST /orders` now requires `shippingAddressId` (a new required request field).
  - shipping: rename the status value `PICKED` to `PACKED` (an enum change that breaks clients that switch on it).
- [ ] For each change, list which end-to-end or library example tests should break, so the demo shows exactly what a typed client catches at compile time.
- [ ] Keep the changes on branches or in documented patches so they can be applied on demand and reverted.

## Acceptance criteria

- The happy-path flow passes against `dev` end to end, repeatedly, with no leftover data beyond what the reset script clears.
- Conformance checks pass for all three services, and any spec corrections they forced are committed.
- Event contract tests pass for all event types, and an incompatible schema change is caught by the compatibility check.
- The stage manifest and specs can be consumed by someone who has never seen this repo, using only `docs/spec-handoff.md`.
- v1.1.0 and v2.0.0 change notes exist for all three services.

## Risks and notes

- **Flaky end-to-end tests.** Eventual consistency and the Aurora resume are the main causes. Polling helpers and the warm-up step address both. Do not use fixed sleeps.
- **Conformance noise.** Property-based tools can produce many findings on a first run. Triage them into real bugs, spec gaps, and tool configuration issues rather than silencing the tool.
- **Spec drift.** The spec is the product the library consumes. Keep the response validation and conformance checks in CI (Phase 6), or the library will generate clients for an API that no longer exists.
- **Test data in shared stages.** PR runs use their own database schema, dropped after the run, so a PR's customers disappear with it, and orders and shipments disappear when their stacks are destroyed. The `main` schema persists, so customers created there by main-branch runs or ad hoc testing still need cleanup. Run ids and cleanup keep `dev` usable. Never run reset against a stage you care about.
