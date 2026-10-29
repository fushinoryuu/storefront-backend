# Phase 3: Orders Service (DynamoDB)

The orders service is where DynamoDB design, idempotency, concurrency control, and event publishing come together. It also shows both communication styles: a synchronous call to the customers API, and asynchronous events to and from shipping.

## Goals

- A DynamoDB table design driven by access patterns, not by entities.
- Safe order placement: validated input, server-side pricing, idempotency, optimistic locking.
- Reliable event publishing using the DynamoDB Streams outbox pattern.
- An idempotent consumer that updates order status from shipment events, even when events arrive late or twice.

## Deliverables

| Deliverable | Location |
|---|---|
| Stack | `infra/lib/stacks/orders-stack.ts` |
| Service code | `services/orders/src/` |
| Product catalog seed | `services/orders/data/products.json` |
| OpenAPI spec | `services/orders/openapi.yaml` (draft from Phase 0.5, released as v1.0.0 here) |
| Tests | `services/orders/test/` |
| Table design doc | `docs/services/orders-table-design.md` |
| Service doc | `docs/services/orders.md` |

## Access patterns (design the table from these)

| # | Pattern | Served by |
|---|---|---|
| 1 | Get an order by id | Primary key |
| 2 | List a customer's orders, newest first | GSI1 (customer id, created time) |
| 3 | List orders by status, newest first (for operations views) | GSI2 (status, created time), optional |
| 4 | Look up a prior request by idempotency key | Idempotency item with TTL |
| 5 | Update status from a shipment event, guarding against stale updates | Conditional update on the order item |

Suggested design: one table, `PK` and `SK` strings, with the order stored as a single item (`PK = ORDER#<id>`, `SK = META`). Line items are a nested list on the order, which is fine while an order stays far below the 400 KB item limit. Cap items per order in validation. Idempotency records use `PK = IDEM#<key>` with a TTL attribute. On-demand capacity, point-in-time recovery enabled in `prod`, streams enabled with new and old images.

The order and line-item model comes from the draft spec (Phase 0.5), so the table follows the contract. If the table needs a different shape, change the spec first. Write the table design doc first, with the patterns above, key schemas, and what you deliberately did not support. Keep the doc short enough that a reviewer can check each pattern against the schema.

## Order lifecycle

```
PENDING --> CONFIRMED --> SHIPPED --> DELIVERED
   |            |
   +--> CANCELLED <--+
```

- `PENDING`: created, `OrderPlaced` event emitted.
- `CONFIRMED`: shipping has created a shipment (driven by `ShipmentCreated`).
- `SHIPPED` and `DELIVERED`: driven by `ShipmentDispatched` and `ShipmentDelivered`.
- `CANCELLED`: allowed from `PENDING` and `CONFIRMED` only.
- Transitions are enforced by a small state machine in the domain layer and by conditional writes. Unit test every allowed and disallowed transition in a table-driven test.

## API

The draft spec from Phase 0.5 is authoritative. This table summarizes it.

| Operation | Method and path | Notes |
|---|---|---|
| `listProducts` | `GET /products` | Read-only catalog loaded from seed data |
| `createOrder` | `POST /orders` | Requires `Idempotency-Key` header, validates customer, prices from catalog |
| `getOrder` | `GET /orders/{orderId}` | |
| `listOrders` | `GET /orders` | Filters: `customerId` (required unless admin), `status`, cursor pagination |
| `cancelOrder` | `POST /orders/{orderId}/cancel` | 409 if the state does not allow it |

Tags: `orders`, `products`, and the shared `version` tag. Keep `operationId` values stable.

## Tasks

### 1. Catalog and pricing

- [ ] A small static catalog (a dozen fake products with id, name, price in minor units, currency).
- [ ] Prices are always taken from the catalog on the server. A client-supplied price is ignored or rejected. This is a deliberate test target.
- [ ] Totals computed in integer minor units to avoid floating-point issues.
- [ ] Unknown product ids and invalid quantities return 400 with the shared error shape.

### 2. Table and infrastructure

- [ ] DynamoDB table and the indexes from the access patterns, TTL attribute for idempotency records, streams enabled.
- [ ] Lambda functions from the `ServiceFunction` construct, with only the table permissions each needs.
- [ ] `ServiceApi` (REST API) routes with `apiKeyRequired` and the shared usage plans.
- [ ] Stage-specific removal policy and point-in-time recovery setting.
- [ ] Alarms: Lambda errors, API 5xx, DynamoDB throttles and system errors, Pipes failures.

### 3. Order placement

`POST /orders` should do, in order:

- [ ] Validate the body and the `Idempotency-Key` header (required, length and charset limits).
- [ ] Return the stored response for a repeated key with the same body, and a 409 for a repeated key with a different body.
- [ ] Validate that the customer exists by calling the customers API with the `services` API key and the correlation id. Use a short timeout, no retry on this path beyond a single attempt, and map failures clearly: unknown customer is a 422 or 400, customers unavailable is a 503 (not a 500).
- [ ] Price the items from the catalog.
- [ ] Write the order item and the idempotency record in one `TransactWriteItems` call.
- [ ] Return 201 with the order and a `Location` header.
- [ ] Do not publish the event here. The outbox (below) does it from the table change.

Record the decision to call customers synchronously (decision 0009), and what you would do at larger scale (keep a local customer projection updated by `CustomerCreated` and `CustomerUpdated` events, accepting eventual consistency).

### 4. Concurrency

- [ ] Every order has a `version` attribute. Updates use conditional expressions on the version (and on the allowed previous status). A failed condition returns 409 or retries, depending on the case.
- [ ] A test that runs two cancellations, and a cancellation racing a shipment update, and asserts exactly one wins and the final state is valid.

### 5. Outbox: DynamoDB Streams to EventBridge Pipes

The change in the table is the source of truth, and events are derived from it, so an event cannot be lost between a write and a publish.

- [ ] Pipe from the table stream to the custom event bus, with a filter that passes only the changes that should produce events: new order items (`OrderPlaced`) and transitions to `CANCELLED` (`OrderCancelled`).
- [ ] A transformation (input template, or a small enrichment function if the template is not enough) that builds the shared event envelope with `eventId`, `occurredAt`, `correlationId` (stored on the order item), and a typed payload.
- [ ] A dead-letter queue on the pipe, an alarm on it, and a short runbook for redrive.
- [ ] Remember the delivery guarantees: records stay in the stream for up to 24 hours, and delivery should be treated as at least once. Consumers must tolerate duplicates, and this service's own consumer must too.
- [ ] Fallback if Pipes proves awkward: publish with `PutEvents` from the handler after the write, and record the small failure window in the decision record.

### 6. Consumer for shipment events

- [ ] An `EventConsumer` construct subscribing to `ShipmentCreated`, `ShipmentDispatched`, and `ShipmentDelivered` from the shipping service.
- [ ] Idempotent handling: record the `eventId` with a conditional put (with TTL), and skip repeats.
- [ ] Out-of-order protection: a `DELIVERED` event arriving before `SHIPPED` should still produce a valid result, or be parked and retried. Decide and document. A simple rule is that status only moves forward in the lifecycle, so late older events are ignored.
- [ ] Unknown order ids and malformed events go to the DLQ with enough context to debug.
- [ ] Partial batch failure reporting, so one bad record does not block the rest.

### 7. OpenAPI spec

- [ ] Start from the Phase 0.5 draft. If the implementation needs a change, edit the spec first and bump the version, and tell the library project while the spec is still 0.x.
- [ ] Keep what the draft already has: the shared error schema on all error responses, an `apiKey` security scheme (header `x-api-key`), the `Idempotency-Key` header parameter, enums for status, examples.
- [ ] Request validation uses the spec's schemas, and handler tests check responses against the spec (decision 0004).
- [ ] Release the spec as v1.0.0 once the implementation matches it. Lint and bundle it in CI.

### 8. Tests

- [ ] **Unit:** pricing, state machine (table-driven), validation, idempotency decisions, event envelope building.
- [ ] **Repository tests** against DynamoDB Local (a container started by the test run): access patterns, conditional writes, the transaction, TTL attribute shape.
- [ ] **Handler tests** with fake events, with the customers API client replaced by a fake that can return success, 404, timeout, and 5xx. Every response is validated against the spec.
- [ ] **Consumer tests:** duplicate delivery, out-of-order events, unknown order, malformed payload.
- [ ] **CDK tests:** stream enabled, pipe filter pattern present, DLQ present, API key required on protected methods, least-privilege table grants.
- [ ] **Deployed checks:** place an order in `dev` and see the `OrderPlaced` event arrive (for example by a temporary rule that logs it, or the shipping service in Phase 4).

## Acceptance criteria

- `POST /orders` is idempotent: the same key and body twice produces one order.
- A client-supplied price cannot change the total.
- Customer lookup failures produce clear 4xx or 503 responses, never a generic 500.
- A placed order results in exactly one `OrderPlaced` event, and a replayed shipment event does not change an order twice.
- Concurrency tests show a valid final state under races.

## Risks and notes

- **Hot or oversized items.** Nested line items are simple, but cap them. If orders could be large, split items into separate records.
- **Pipes transformation limits.** Keep the input template simple. If you need logic, add an enrichment Lambda and note the added moving part.
- **Eventual consistency in the story.** An order can be `PENDING` for a moment after placement. Tests and clients must poll, not assume immediate `CONFIRMED`.
- **Replaying events.** Archive replay can re-deliver old events. The idempotent consumer is what makes replay safe.
