# Phase 4: Shipping Service (Event Driven)

The shipping service has almost no request-driven behavior. It reacts to orders, runs a simulated shipment lifecycle on its own, and reports progress back through events. This is where reliable messaging practices matter: idempotency, dead-letter queues, ordering, and observability.

## Goals

- A consumer that turns `OrderPlaced` events into shipments, safely, even with duplicate or poisoned messages.
- A shipment lifecycle driven by a simulated carrier, with timings that are fast in `dev` and realistic-looking elsewhere.
- Events published for every meaningful state change.
- A small read API, plus a protected endpoint that lets tests drive the lifecycle deterministically.

## Deliverables

| Deliverable | Location |
|---|---|
| Stack | `infra/lib/stacks/shipping-stack.ts` |
| Service code | `services/shipping/src/` |
| State machine definition | `services/shipping/workflow/` or in the stack |
| Event contracts | `packages/events/src/shipping/` |
| OpenAPI spec | `services/shipping/openapi.yaml` (draft from Phase 0.5, released as v1.0.0 here) |
| Tests | `services/shipping/test/` |
| Runbooks | `docs/runbooks/shipping-dlq.md` |
| Service doc | `docs/services/shipping.md` |

## Flow

```
OrderPlaced (event bus)
   -> rule -> SQS queue (+ DLQ)
   -> create-shipment Lambda -> shipments table -> ShipmentCreated event
   -> start lifecycle (Step Functions)
        wait -> PICKED -> wait -> SHIPPED (ShipmentDispatched) -> wait -> DELIVERED (ShipmentDelivered)

OrderCancelled (event bus)
   -> rule -> SQS queue -> cancel-shipment Lambda (allowed until SHIPPED)
```

## Shipment lifecycle

States: `CREATED`, `PICKED`, `SHIPPED`, `DELIVERED`, `CANCELLED`. Stretch: `DELIVERY_FAILED` and `RETURNED`.

- Transitions only move forward, except cancellation, which is allowed before `SHIPPED`.
- Each transition is a conditional update on the shipment item, so repeated or racing transitions are harmless.
- Each transition publishes an event with the shared envelope.

## Events

| Event | Direction | Notes |
|---|---|---|
| `OrderPlaced` | in | Creates the shipment |
| `OrderCancelled` | in | Cancels the shipment if not yet shipped |
| `ShipmentCreated` | out | Orders moves to `CONFIRMED` |
| `ShipmentDispatched` | out | Orders moves to `SHIPPED`, includes carrier name and tracking number (fake) |
| `ShipmentDelivered` | out | Orders moves to `DELIVERED` |
| `ShipmentCancelled` | out | Informational |

Event schemas live in `packages/events`. Every event carries `eventId`, `schemaVersion`, `occurredAt`, `correlationId`, and `producer`.

## API

The draft spec from Phase 0.5 is authoritative. This table summarizes it.

| Operation | Method and path | Notes |
|---|---|---|
| `getShipment` | `GET /shipments/{shipmentId}` | |
| `listShipments` | `GET /shipments` | Filters: `orderId`, `status`, cursor pagination |
| `advanceShipment` | `POST /shipments/{shipmentId}/simulate/advance` | Admin only. Moves the shipment to its next state immediately. Used by tests |

Tags: `shipments`, `simulation`, and the shared `version` tag. The simulation route is enforced in the handler by comparing the caller's API key id with the `admin` key id. Consider disabling the route by configuration in `staging` if you want it to look production-like.

## Tasks

### 1. Data

- [ ] A `shipments` table: `PK = SHIPMENT#<id>`, plus a GSI on `orderId` (so one order maps to at most one shipment, enforced by a conditional write or a unique-key item).
- [ ] A dedupe record per processed event id, with TTL.
- [ ] On-demand capacity, stage-specific removal policy and recovery settings.

### 2. Consumers

- [ ] Use the `EventConsumer` construct for `OrderPlaced` and for `OrderCancelled`, each with its own queue and DLQ.
- [ ] Queue visibility timeout comfortably above the function timeout, with a sensible `maxReceiveCount` before a message goes to the DLQ.
- [ ] Report partial batch failures so good messages are not retried because of one bad one.
- [ ] **Idempotency:** dedupe on `eventId` with a conditional put, and also guard the business rule (one shipment per order) so even a missed dedupe cannot create a second shipment.
- [ ] **Validation:** parse and validate each event with the shared schema. Malformed events fail fast into the DLQ with context in the logs.
- [ ] **Ordering:** `OrderCancelled` can arrive before the shipment exists. Decide and document: for example, record a cancellation marker so a late `OrderPlaced` creates the shipment already cancelled, or ignore and let the order service reconcile. Test it.

### 3. Lifecycle workflow

- [ ] A Step Functions state machine drives the simulated carrier: wait, mark `PICKED`, wait, mark `SHIPPED`, wait, mark `DELIVERED`. Durations come from stage configuration (seconds in `dev` so end-to-end tests are quick, longer in `staging`).
- [ ] Each task updates the shipment with a conditional write and publishes the event.
- [ ] The workflow stops cleanly if the shipment is cancelled, by checking status before each transition.
- [ ] Execution name derived from the shipment id, so starting the workflow twice does not run it twice.
- [ ] Alarm on failed executions.
- [ ] Alternative if Step Functions feels heavy: one-off EventBridge Scheduler schedules per transition. Record the choice.

### 4. Publishing

- [ ] A small publisher in `packages/shared` that builds the envelope and calls `PutEvents`, checking the response for failed entries and retrying them a bounded number of times.
- [ ] Be explicit about the limit of publish-after-write inside this service, or use the same Streams and Pipes outbox as orders for consistency. If you take the same approach, reuse the construct. Decide and record.

### 5. API and simulation endpoint

- [ ] Read endpoints with the shared error shape and cursor pagination.
- [ ] `advanceShipment` runs the next transition through the same code path as the workflow, so tests exercise real logic. Returns 409 if the shipment cannot advance.
- [ ] Admin-only enforcement and a test proving the `tests` key is rejected.

### 6. Observability

- [ ] Structured logs with correlation id taken from the incoming event, so one order can be followed across all services.
- [ ] Custom metrics: shipments created, transitions per state, end-to-end lag from `OrderPlaced` to `ShipmentCreated`.
- [ ] Alarms: DLQ depth above zero, age of the oldest message, workflow failures, consumer errors.
- [ ] X-Ray tracing enabled on the functions and the state machine.

### 7. Runbook

Write `docs/runbooks/shipping-dlq.md`:

- [ ] How to find a poisoned message and read it.
- [ ] How to decide between fixing the data, fixing the code, and discarding.
- [ ] How to redrive messages from the DLQ back to the source queue safely (after the fix is deployed).
- [ ] How to confirm no duplicates were created (the idempotency guards make redrive safe).

### 8. OpenAPI spec and event contracts

- [ ] Start from the Phase 0.5 draft, which already has the shared error schema, `apiKey` security scheme, and enums for status. If the implementation needs a change, edit the spec first and bump the version, and tell the library project while the spec is still 0.x.
- [ ] Request validation uses the spec's schemas, and handler tests check responses against the spec (decision 0004).
- [ ] Release the spec as v1.0.0 once the implementation matches it. Lint and bundle it in CI.
- [ ] Event schemas published as JSON Schema files generated from the shared definitions, and a changelog file for events.

### 9. Tests

- [ ] **Unit:** lifecycle state machine, transition guards, envelope building.
- [ ] **Consumer tests** with fake SQS events: success, duplicate delivery, malformed event, unknown order, cancellation before creation.
- [ ] **Repository tests** against DynamoDB Local, including the one-shipment-per-order rule under concurrent creates.
- [ ] **Workflow tests:** unit test each task function, and validate the state machine definition. Run the full workflow in `dev` with short waits as a deployed check.
- [ ] **CDK tests:** queues and DLQs with redrive policy, visibility timeout relation, alarms, the admin key id passed to the handler.
- [ ] **Poison message test in `dev`:** send a malformed event and confirm it lands in the DLQ and triggers the alarm.

## Acceptance criteria

- Placing an order in `dev` produces a shipment and `ShipmentCreated` within seconds, and the lifecycle completes with the short stage timings.
- Delivering the same `OrderPlaced` twice produces one shipment.
- A malformed event ends up in the DLQ with an alarm, and the rest of the batch is processed.
- Cancelling an order before shipment cancels the shipment, and cancelling after shipment does not.
- The `tests` API key cannot call the simulation endpoint.

## Risks and notes

- **Retries create duplicates.** At-least-once delivery is the default everywhere. The tests for duplicates are the most important tests in this phase.
- **Visibility timeout mistakes** cause messages to be processed twice while still in flight. Verify the relationship between timeout values in the CDK tests.
- **Workflow cost and complexity.** Step Functions is a good fit for a visible lifecycle, but keep the state machine small.
- **Simulation endpoints in real systems.** It is a test affordance. Note in the docs that production would not expose it.
