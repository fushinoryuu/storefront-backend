# events

The event envelope, the event schemas and the functions that build and check them. Producers and consumers in different services import this package, so they agree on one format and a consumer fails loudly on a malformed event. The naming rules for `producer` and `eventType` are in [docs/conventions.md](../../docs/conventions.md).

## The envelope

Every event has the same outer shape, and a typed `data` payload:

| Field           | Meaning                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `eventId`       | A UUID, new for every event. Consumers use it to skip duplicates.                                                     |
| `eventType`     | `OrderPlaced`, `OrderCancelled`, `ShipmentCreated`, `ShipmentDispatched`, `ShipmentDelivered` or `ShipmentCancelled`. |
| `schemaVersion` | A whole number, 1 or more, for the shape of `data` (see the versioning rule).                                         |
| `occurredAt`    | When it happened, as a UTC time in ISO 8601 (`2026-11-09T12:00:00.000Z`).                                             |
| `correlationId` | The id of the request that caused it, carried from `x-correlation-id`.                                                |
| `producer`      | The service that owns the event: `storefront.orders` or `storefront.shipping`.                                        |
| `data`          | The payload of that event type.                                                                                       |

The payloads are first drafts. The service that owns an event may refine them, using the versioning rule below.

## Use

```ts
import { buildEvent, parseEventOfType } from '../../packages/events/src'; // relative to a file in services/<service>/src

// Producer: the envelope fields are filled in and the result is validated
const event = buildEvent('OrderCancelled', { orderId, customerId }, { correlationId });

// Consumer: throws an EventValidationError for anything it cannot use
const placed = parseEventOfType('OrderPlaced', JSON.parse(record.body).detail);
```

- `buildEvent(eventType, data, { correlationId })` sets `eventId`, `occurredAt`, `schemaVersion` and `producer`, and throws if the result is not valid.
- `parseEvent(input)` accepts any known event and returns it typed. `parseEventOfType(eventType, input)` is for a consumer of one type and rejects the others.
- Each event also has a schema (for example `OrderPlacedEventSchema`), a data schema (`OrderPlacedDataSchema`) and a type (`OrderPlacedEvent`).

An `EventValidationError` has a `code` and a list of `issues`, each written as `path message`:

| `code`                       | When                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `malformed_event`            | Not an object, a field is missing, or a field has the wrong type or format.       |
| `unknown_event_type`         | `eventType` is not one of the six (or is not the one `parseEventOfType` expects). |
| `unsupported_schema_version` | `schemaVersion` is newer than this package knows.                                 |

A consumer does not catch the error. The failed message goes back to the queue and, after the retries, to its dead-letter queue.

## Versioning rule

- **An additive change keeps the version.** A new optional field in `data` or in the envelope is not a new version. Consumers ignore fields they do not know: parsing drops them. A consumer must therefore never depend on a field being absent.
- **A breaking change bumps `schemaVersion`.** Removing or renaming a field, changing a type or making an optional field required is breaking. The producer then publishes both versions for a transition period, and each consumer moves to the new one before the old one stops.
- **A consumer rejects a version newer than it knows**, with `unsupported_schema_version`, instead of guessing. Upgrade consumers before producers.
- Every change to a schema is written in [CHANGELOG.md](CHANGELOG.md), with the date and the version it applies to.

Today every event is at version 1, and the package supports only that version. When the first breaking change comes, keep the schema of the old version next to the new one, and let `parseEvent` return a union of both for that event.
