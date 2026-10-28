# Phase 0.5: Draft OpenAPI Specs

Write the OpenAPI specs for all three services before any of them is built. The library project depends on these specs, and the phase docs already describe the paths, operations, tags, and status codes, so the drafts can exist long before anything is deployed.

## Goals

- Draft specs (v0.1.0) for customers, orders, and shipping that the library project can generate clients from.
- One set of shared components (error schema, security scheme, pagination, health and version) used by all three.
- Spec-first becomes the project's rule: the spec is the source of truth, and the implementation in Phases 2 to 4 is built to match it.
- A way to lint and bundle the specs from the start.

## Deliverables

| Deliverable | Location |
|---|---|
| Shared components | `specs/shared/components.yaml` |
| Customers draft | `services/customers/openapi.yaml` |
| Orders draft | `services/orders/openapi.yaml` |
| Shipping draft | `services/shipping/openapi.yaml` |
| Bundled standalone copies | `specs/` (produced by a script) |
| Lint and bundle tooling | `scripts/` and lint config at the repo root |
| Decision record 0004 | `docs/decisions/0004-api-definition.md` |
| Hand-off draft | `docs/spec-handoff.md` |

## Versioning rule

- Drafts are `0.x.y`. They may change freely, and the library project is told when they do.
- A spec becomes `1.0.0` when its service is implemented and matches it (Phases 2 to 4).
- The planned v1.1.0 and v2.0.0 demo changes stay out of the drafts. They are written in Phase 5.

## Tasks

### S.1 Spec conventions and shared components

- [ ] Write decision record 0004: spec-first, with the hand-written `openapi.yaml` as the source of truth. Routes stay defined in CDK, and API Gateway integration extensions stay out of the specs.
- [ ] Decide how the implementation stays tied to the spec, and record the choice in 0004. Options: (a) runtime validation uses JSON schemas taken from the spec, with tests checking every response against it; (b) types are generated from the spec and runtime validation is kept separate; (c) hand-written Zod schemas for validation, with a test that converts each one to JSON Schema and compares it with the spec; (d) Zod schemas generated from the spec. Zod is a wanted skill for this project, so weigh (c) and (d) seriously. Spec-first stays either way, and a later move to code-first would make Zod generate the spec.
- [ ] Use OpenAPI 3.0.3 and record it in 0004. It was chosen as the version with the most documentation that Zod 4 (through `z.toJSONSchema` with its `openapi-3.0` target) and the common TypeScript generators support. Moving to 3.1 later is mostly mechanical (for example `nullable` becomes a type array) but touches every spec.
- [ ] Shared error schema (`type`, `title`, `status`, `detail`, `correlationId`, optional `errors[]`).
- [ ] `apiKey` security scheme using the `x-api-key` header.
- [ ] Cursor pagination parameters and a page envelope.
- [ ] Common responses: 400, 403, 404, 409, 429, 503, all using the shared error schema.
- [ ] Schemas for `GET /health` and `GET /version` (build id, spec version, stage).
- [ ] Naming rules for `operationId` (verb plus noun, camelCase) and tags (one per endpoint group, plus the shared `version` tag).

### S.2 Lint and bundle tooling

- [ ] A linter (Spectral or Redocly) with a ruleset that enforces `operationId`, tags, examples, and the shared error schema on every 4xx.
- [ ] A script that bundles each service spec with its references to the shared file into a standalone file in `specs/`.
- [ ] Run both locally and in the Phase 0 CI.

### S.3 Customers draft

- [ ] Every operation in the Phase 2 API table, including `getReadiness`.
- [ ] `Customer`, `Address`, and their create and update shapes, the `status` enum, and optimistic concurrency (`If-Match` or a `version` field).
- [ ] Examples, documented status codes, and the API key requirement on every route except `GET /health` and `GET /version`.

### S.4 Shipping draft

- [ ] `getShipment`, `listShipments` (filters `orderId`, `status`), and `advanceShipment`, plus health and version.
- [ ] `Shipment` and the status enum (`CREATED`, `PICKED`, `SHIPPED`, `DELIVERED`, `CANCELLED`).
- [ ] Note in the description of `advanceShipment` that it is admin-only and returns 409 when the shipment cannot advance.

### S.5 Orders draft

- [ ] Design the `Order` and line-item model here. Phase 3 follows it: prices come from the catalog, totals are integer minor units, and the number of items per order is capped.
- [ ] `listProducts`, `createOrder`, `getOrder`, `listOrders`, `cancelOrder`, plus health and version.
- [ ] The `Idempotency-Key` header parameter, the `Location` header on 201, the status enum, and the 409 cases (cancel not allowed, key reuse with a different body).
- [ ] Examples for each operation.

### S.6 Hand-off draft and library check

- [ ] Start `docs/spec-handoff.md`: where the specs live, that they are drafts, how to bump the version, how to run a mock server from a spec until real endpoints exist, and what is not available yet (base URLs, API keys).
- [ ] Generate typed clients from the drafts in the library project, and record any spec problems it finds. Fix the specs.

## Acceptance criteria

- All three specs declare `openapi: 3.0.3`, lint cleanly, and bundle to standalone files in `specs/`.
- Every operation has a stable `operationId`, a tag, an example, and the shared error schema on its 4xx responses.
- Decision record 0004 exists and says how the implementation stays tied to the spec.
- The library project can generate clients from the bundled drafts.
- `docs/spec-handoff.md` is enough for the library project to pick up the drafts without help.

## Risks and notes

- **Drafts treated as final.** Keep the `0.x` version until the implementation matches, and tell the library project when a draft changes.
- **Orders model churn.** The order model is the least specified today. Settle it in S.5 before Phase 3 designs the table, so the table follows the contract and not the reverse.
- **Spec and implementation drift.** With spec-first, drift is caught by validating requests and responses against the spec and by the Phase 5 conformance tests. Do not rely on memory.
- **Shared file complexity.** Keep the shared components file small. If bundling gets awkward, copy the few shared schemas into each spec and add a lint check that they match.
