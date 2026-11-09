# Phase 5: Integration and Contracts

Each service is tested on its own. This phase proves they work together, proves each one honors its published contract, and prepares the handoff to the library project, whose generated clients are only as good as the specs published here.

## Goals

- End-to-end flows across all three services, including failure cases.
- API conformance: the deployed services behave as their OpenAPI specs say.
- Event contract tests for producers and consumers.
- Specs, base URLs, and keys published in a form the library project can consume.
- A real `/v2` served next to `/v1`, and a non-breaking v1.1.0, ready for the library demo.

## Deliverables

| Deliverable            | Location                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| End-to-end tests       | `tests/e2e/`                                                               |
| API conformance setup  | `tests/contract/api/`                                                      |
| Event contract tests   | `tests/contract/events/`                                                   |
| Seed and reset scripts | `scripts/seed.ts`, `scripts/reset.ts`                                      |
| Published specs        | `specs/` (bundled from `services/*/openapi*.yaml` by the Phase 0.5 script) |
| Spec publishing doc    | `docs/spec-handoff.md` (started in Phase 0.5, extended here)               |
| Spec change notes      | `docs/spec-change-notes.md` (written in Phase 0.5, implemented here)       |
| Second API version     | `services/orders/openapi-v2.yaml`, `services/shipping/openapi-v2.yaml`     |

## Tasks

### 1. Test harness for deployed environments

- [ ] A small helper that reads base URLs from SSM and the API keys from Secrets Manager (or a local untracked file produced by the key retrieval script) for a chosen stage. Per-run stacks are destroyed after tests, so URLs and keys change on every deploy and nothing should cache them between runs.
- [ ] The end-to-end and integration tests live in this repo and are meant to use the typed clients that the library project (`spec-driven-test-client`) generates, installed from its published package. The library is not ready to use yet, so until it has a usable published version these tests call the API with plain `fetch`.
- [ ] Move the end-to-end and integration tests from `fetch` to the library's generated clients once the library publishes a usable version. Check the version with the library project first, and keep the tests passing at every step of the move.
- [ ] A warm-up step that calls the customers `GET /v0/health/ready` endpoint with the `tests` key and a generous timeout, before the first test, so an Aurora resume does not look like a failure.
- [ ] Polling helper for eventual consistency (poll a condition with a timeout and interval, never a fixed sleep).
- [ ] Every test creates uniquely named data and removes what it created, where a delete operation exists. For data with no delete (orders, shipments), tag it with a run id and rely on a reset script and TTLs.

### 2. End-to-end flows

- [ ] **Happy path:** create customer, add an address, place an order, wait for `CONFIRMED`, advance the shipment through the admin key, see `SHIPPED`, then `DELIVERED` on the order.
- [ ] **Idempotent order:** repeat `POST /v1/orders` with the same key twice and assert one order.
- [ ] **Unknown customer:** order placement fails cleanly with the expected status and error shape.
- [ ] **Cancel before shipment:** the order and shipment both end `CANCELLED`.
- [ ] **Cancel after shipment:** rejected with a 409.
- [ ] **Customers unavailable:** simulate it with a feature flag that makes the orders service treat the customers call as failing, and assert a 503 with the shared error shape. The `dev` flag environment is shared by every run, so the test restores the flag afterwards. How a test sets the flag (LaunchDarkly's REST API with a token, or reading the state and skipping when it is off) is settled in the feature flag decision record. (If this cannot be done safely in a deployed stage, cover it in the orders handler tests instead and say so.)
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

- [ ] The specs were drafted in Phase 0.5 and released as v1.0.0 in Phases 2 to 4. Confirm each one still has: stable `operationId` for every operation, a `tag` per endpoint group (the library turns tags into `service.version.group.operation` calls), `info.version` bumped on every change, the `Problem` schema, an `apiKey` security scheme using the `x-api-key` header, and examples. The lint rules from Phase 0.5 enforce this.
- [ ] Keep API Gateway integration extensions out of the published specs (see decision 0004), so the library consumes a clean contract.
- [ ] Extend the Phase 0.5 bundle script to record the source commit in a small `sources.json`. CI uploads the bundled specs as a build artifact or release asset, so the library project can pull a specific version.
- [ ] Publish a stage manifest (a JSON file or SSM parameter set): service names, base URLs per stage, the name of the secret holding each caller key, the spec versions deployed (the `specVersions` that `GET /v0/version` reports), and the LaunchDarkly project, environment keys and flag keys (keys only, never flag state). The library's global setup reads this and can compare the deployed `GET /v0/version` with the `info.version` of each spec it was generated from.
- [ ] Extend `docs/spec-handoff.md` (started in Phase 0.5) with the final handoff: where specs live, how versions are bumped, how a consumer gets keys, the stage manifest, the feature flag note, and the Aurora warm-up note.

### 7. Add the demo spec changes

These feed the library demo (non-breaking then breaking). The exact spec edits are already in `docs/spec-change-notes.md` (written in Phase 0.5). This phase adds the implementation change each one needs and the expected effect on a generated client.

- [ ] **v1.1.0, non-breaking, in the `/v1` specs:**
    - customers: add an optional `preferredLanguage` field.
    - orders: add `GET /v1/orders/{orderId}/timeline` (status history) and an optional `notes` field on order creation.
    - shipping: add an optional `carrier` filter on `GET /v1/shipments`.
- [ ] **v2.0.0, breaking, a real `/v2` served next to `/v1`** by the same API, with its own spec (`openapi-v2.yaml`) and bundle (`specs/<service>-service-v2.yaml`), and listed in `specVersions`:
    - orders: `POST /v2/orders` requires `shippingAddressId` (a new required request field).
    - shipping: the status value `PICKED` is renamed `PACKED` (an enum change that breaks clients that switch on it). The data is stored once, and the `/v1` handlers map the new value back to `PICKED`.
    - The `/v1` handlers are mapped onto the same data, so v1 clients keep working. Optionally, `/v1` responses carry `Deprecation` and `Sunset` headers.
- [ ] For each change, list which end-to-end or library example tests should break, so the demo shows exactly what a typed client catches at compile time.

## Acceptance criteria

- The happy-path flow passes against `dev` end to end, repeatedly, with no leftover data beyond what the reset script clears.
- Conformance checks pass for all three services, and any spec corrections they forced are committed.
- Event contract tests pass for all event types, and an incompatible schema change is caught by the compatibility check.
- The stage manifest and specs can be consumed by someone who has never seen this repo, using only `docs/spec-handoff.md`.
- v1.1.0 is released for all three services, and `/v2` is served next to `/v1` for orders and shipping, with `/v1` clients still working and both versions listed in `specVersions`.

## Risks and notes

- **Flaky end-to-end tests.** Eventual consistency and the Aurora resume are the main causes. Polling helpers and the warm-up step address both. Do not use fixed sleeps.
- **Conformance noise.** Property-based tools can produce many findings on a first run. Triage them into real bugs, spec gaps, and tool configuration issues rather than silencing the tool.
- **Spec drift.** The spec is the product the library consumes. Keep the response validation and conformance checks in CI (Phase 6), or the library will generate clients for an API that no longer exists.
- **Test data in shared stages.** PR runs use their own database schema, dropped after the run, so a PR's customers disappear with it, and orders and shipments disappear when their stacks are destroyed. The `main` schema belongs to the always-on `prod` stage and persists, so customers created there by main-branch runs or ad hoc testing still need cleanup. Run ids and cleanup keep `dev` usable. Never run reset against a stage you care about.
