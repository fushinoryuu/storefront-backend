# Phase 0.5: Draft OpenAPI Specs

Write the OpenAPI specs for all three services before any of them is built. The library project (`spec-driven-test-client`) depends on these specs, and the phase docs already describe the paths, operations, tags, and status codes, so the drafts can exist long before anything is deployed.

## Goals

- Draft specs (v0.1.0) for customers, orders, and shipping that the library project can generate clients from. Each service has a business spec under `/v1` and a small operational spec under `/v0`.
- One set of shared components (the `Problem` error schema, security scheme, pagination, and the health and version routes) used by all three.
- Spec-first becomes the project's rule: the spec is the source of truth, and the implementation in Phases 2 to 4 is built to match it.
- A way to lint and bundle the specs from the start.

## Deliverables

| Deliverable               | Location                                                                    |
| ------------------------- | --------------------------------------------------------------------------- |
| Shared components         | `specs/shared/components.yaml`                                              |
| Shared path items         | `specs/shared/paths/*.yaml` (health and version)                            |
| Customers drafts          | `services/customers/openapi.yaml` (`/v1`), `openapi-v0.yaml` (`/v0`)        |
| Orders drafts             | `services/orders/openapi.yaml` (`/v1`), `openapi-v0.yaml` (`/v0`)           |
| Shipping drafts           | `services/shipping/openapi.yaml` (`/v1`), `openapi-v0.yaml` (`/v0`)         |
| Bundled standalone copies | `specs/<service>-service-v<N>.yaml` (produced by a script, committed)       |
| Lint and bundle tooling   | `scripts/` and lint config at the repo root                                 |
| Spec conventions          | `docs/spec-conventions.md`                                                  |
| Decision record 0004      | `docs/decisions/0004-api-definition.md`                                     |
| Hand-off draft            | `docs/spec-handoff.md`                                                      |
| Spec change notes         | `docs/spec-change-notes.md` (exact edits for the planned v1.1.0 and v2.0.0) |

## Versioning rule

- Every path starts with a version prefix, and one spec uses one prefix. Business routes are under `/v1`, and a later major is served next to it under `/v2`. The operational routes (`/v0/health`, `/v0/health/ready` and `/v0/version`) live in a small `/v0` spec per service, defined once from shared path items. `v0` means operational, not pre-release.
- A spec's `info.version` major matches its prefix. The `0.x` drafts of the first business version use `/v1`, and the `/v0` spec stays `0.x`.
- Each prefix is its own bundle, named `specs/<service>-service-v<N>.yaml`, so the library sees every version as one more segment of the same service.
- Drafts are `0.x.y`. They may change freely, and the library project is told when they do, with the new `info.version`.
- A spec becomes `1.0.0` when its service is implemented and matches it (Phases 2 to 4).
- The planned v1.1.0 and v2.0.0 demo changes stay out of the drafts. Their exact edits are written up in `docs/spec-change-notes.md` in this phase, and implemented in Phase 5.

## Tasks

### S.1 Spec conventions and shared components

- [x] Write decision record 0004: spec-first, with the hand-written `openapi.yaml` as the source of truth. Routes stay defined in CDK, and API Gateway integration extensions and a `servers` entry stay out of the specs (base URLs come from the stage manifest).
- [x] Decide how the implementation stays tied to the spec, and record the choice in 0004. Options: (a) runtime validation uses JSON schemas taken from the spec, with tests checking every response against it; (b) types are generated from the spec and runtime validation is kept separate; (c) hand-written Zod schemas for validation, with a test that converts each one to JSON Schema and compares it with the spec; (d) Zod schemas generated from the spec. Zod is a wanted skill for this project, so weigh (c) and (d) seriously. Spec-first stays either way, and a later move to code-first would make Zod generate the spec.
- [x] Use OpenAPI 3.0.3 and record it in 0004. It was chosen as the version with the most documentation that Zod 4 (through `z.toJSONSchema` with its `openapi-3.0` target) and the common TypeScript generators support. Moving to 3.1 later is mostly mechanical (for example `nullable` becomes a type array) but touches every spec.
- [x] Write the rules down in `docs/spec-conventions.md`: the files, the `/v<N>` prefixes, no `servers` entry, `nullable: true` for nullable fields, a `discriminator` wherever `oneOf` or `anyOf` is used, an example on every request body and response, and the `apiKey` security rule.
- [x] Shared error schema named `Problem` (`type`, `title`, `status`, `detail`, `correlationId`, optional `errors[]`). It is not called `Error`, which collides with the JavaScript global in generated TypeScript.
- [x] `apiKey` security scheme using the `x-api-key` header.
- [x] Cursor pagination: the `cursor` and `limit` query parameters, and a page envelope with a nullable `nextCursor`.
- [x] Common responses: 400, 403, 404, 409, 429, 503, all using `Problem`. The 503 documents a `Retry-After` header in seconds.
- [x] Shared path items for `GET /v0/health` and `GET /v0/version`. The version response reports the build id, the stage and `specVersions`, an object keyed by prefix whose keys equal the bundle file suffixes (`v0`, `v1`, `v2`).
- [x] Naming rules for `operationId` (verb plus noun, camelCase) and tags (one per endpoint group, plus the shared `operations` tag for the `/v0` routes).

### S.2 Lint and bundle tooling

- [x] Redocly for the structural lint, example validation and bundling, plus project rules (TypeScript checks over the bundled document) that enforce `operationId`, one tag per operation, examples on every body, `Problem` on every 4xx and 503, the version prefix, and that health and version routes appear only in `/v0` specs. The rules are listed in `docs/spec-conventions.md`.
- [x] A script that bundles every spec a service has (`openapi.yaml`, `openapi-v0.yaml`, and later `openapi-v2.yaml`) with its references to the shared files into a standalone file `specs/<service>-service-v<N>.yaml`. A check mode fails when a bundle is stale.
- [x] Run both locally and in the Phase 0 CI.

### S.3 Customers draft

- [x] Every operation in the Phase 2 API table in `openapi.yaml`, under `/v1`. `openapi-v0.yaml` holds `getHealth`, `getVersion` and `getReadiness`.
- [x] `Customer`, `Address`, and their create and update shapes, the `status` enum, and optimistic concurrency (a `version` field in the update body, 409 on a mismatch).
- [x] `listCustomers` leaves out deleted customers unless `status=deleted` is asked for. A deleted customer keeps its email, so creating a customer with that email returns 409.
- [x] Examples, documented status codes, and the API key requirement on every route except `GET /v0/health` and `GET /v0/version`.

### S.4 Shipping draft

- [x] `getShipment`, `listShipments` (filters `orderId`, `status`), and `advanceShipment` in `openapi.yaml`, under `/v1`, plus `openapi-v0.yaml` with health and version.
- [x] `Shipment` and the status enum (`CREATED`, `PICKED`, `SHIPPED`, `DELIVERED`, `CANCELLED`).
- [x] Note in the description of `advanceShipment` that it is admin-only, returns 409 when the shipment cannot advance, and is gated by a feature flag. When the flag is off, it answers 404, the same as a route that does not exist.

### S.5 Orders draft

- [x] Design the `Order` and line-item model here. Phase 3 follows it: prices come from the catalog, totals are integer minor units, and the number of items per order is capped (20 lines).
- [x] `listProducts`, `createOrder`, `getOrder`, `listOrders`, `cancelOrder` in `openapi.yaml`, under `/v1`, plus `openapi-v0.yaml` with health and version.
- [x] The `Idempotency-Key` header parameter, the `Location` header on 201, the status enum, and the 409 cases (cancel not allowed, key reuse with a different body).
- [x] Examples for each operation.

### S.6 Hand-off draft and library check

- [x] Start `docs/spec-handoff.md`: where the specs live and how they are named, that they are drafts, how to bump the version and who announces a change, how to report a spec problem (a bug ticket in the Jira project BEP), how to run a mock server from a spec until real endpoints exist, and what is not available yet (base URLs, API keys). Add the feature flag note: flags are plain booleans, the backend exposes no flag state, and the library reads them from LaunchDarkly with a personal token that has the built-in Reader role.
- [x] Write `docs/spec-change-notes.md`: the exact spec edits for the planned v1.1.0 and v2.0.0 changes (see Phase 5), so the library demo can be rehearsed.
- [x] Generate typed clients from the drafts in the library project (it uses hey-api `openapi-ts`), and record any spec problems it finds. Fix the specs.
  - [x] A check on this side with the generator version the library pins (hey-api `openapi-ts` 0.99.0, the `@hey-api/typescript`, `@hey-api/sdk` and `@hey-api/client-fetch` plugins): all six bundles generate and the output typechecks. The edits in `docs/spec-change-notes.md` were applied to a scratch copy, and the result lints, bundles, generates and typechecks as well. It found no spec problem.
  - [x] The library project's own run against the drafts on `main` (the same generator version and plugins, all six bundles): every bundle generates with no warning and the output typechecks. It found no spec problem, so there was nothing to fix.

## Acceptance criteria

- Every spec source declares `openapi: 3.0.3`, lints cleanly, and bundles to a standalone file `specs/<service>-service-v<N>.yaml`: a `v0` and a `v1` bundle for each service.
- Every operation has a stable `operationId`, a tag, an example, and `Problem` on its 4xx responses.
- Decision record 0004 exists and says how the implementation stays tied to the spec.
- The library project can generate clients from the bundled drafts.
- `docs/spec-handoff.md` is enough for the library project to pick up the drafts without help.

## Risks and notes

- **Drafts treated as final.** Keep the `0.x` version until the implementation matches, and tell the library project when a draft changes.
- **Orders model churn.** The order model is the least specified today. Settle it in S.5 before Phase 3 designs the table, so the table follows the contract and not the reverse.
- **Spec and implementation drift.** With spec-first, drift is caught by validating requests and responses against the spec and by the Phase 5 conformance tests. Do not rely on memory.
- **Shared file complexity.** Keep the shared components file small. If bundling gets awkward, copy the few shared schemas into each spec and add a lint check that they match.
- **Generator quirks.** The library generates its clients with hey-api `openapi-ts`, which supports OpenAPI 3.0 and 3.1. In S.6, check that it handles 3.0.3 cleanly, in particular `nullable` fields and discriminators, and fix the spec or note the workaround for anything it rejects.
