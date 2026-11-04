# 0008: Event publishing from orders

Status: accepted on 2026-11-04.

## Context

Orders must publish `OrderPlaced` and `OrderCancelled` to the event bus (the envelope is in `packages/events`). A write to the table followed by a separate publish can lose the event if the function fails in between. Shipping consumes `OrderPlaced`, so a lost event leaves an order with no shipment. Any consumer has to cope with duplicates anyway.

## Options

- **DynamoDB Streams and EventBridge Pipes.** The change in the table is the source of truth, and the event is derived from it. The pipe filters the changes, builds the envelope and delivers to the bus, with retries and a dead-letter queue. It adds a stream, a pipe and a mapping to maintain.
- **`PutEvents` from the handler, after the write.** Simple, and easy to test. If the function fails after the write and before the publish, the event is lost, and nothing records that.
- **An outbox table and a poller.** Robust, but we would write and run the poller. Streams already do that job.

## Decision

Orders use DynamoDB Streams and EventBridge Pipes. Pipes is available in `us-west-2`: the AWS General Reference lists `pipes.us-west-2.amazonaws.com`.

- The table stream uses new and old images. One pipe sends to the custom bus, with a filter that passes only new order items (`OrderPlaced`) and transitions to `CANCELLED` (`OrderCancelled`).
- An input template builds the envelope: `eventId`, `occurredAt`, `correlationId` (stored on the order item) and a typed payload. If a template is not enough, an enrichment function does the rest, and that extra part is recorded in `docs/services/orders.md`.
- The starting position is `TRIM_HORIZON`, because a pipe can take minutes to start polling and `LATEST` could miss records written meanwhile.
- The retry policy has a maximum age shorter than the stream's retention. DynamoDB streams keep records for about 24 hours.
- A dead-letter queue with an alarm, and a short runbook for redrive.

Services that publish without a table change (shipping, and customers if it publishes) call `PutEvents` from `packages/shared`, check the response for failed entries and retry them a bounded number of times.

## Consequences

- An order and its event cannot drift apart. Delivery is at least once, so consumers record `eventId` and skip repeats.
- A pipe on a stream that gets disabled stops working for good: re-enabling the stream gives it a new ARN and the pipe must be created again. The table's stream is never switched off.
- Events from customers and shipping can still be lost between a commit and the publish. For a demo this is a known tradeoff, and an outbox with a poller is the robust fix.
- The fallback, if Pipes proves awkward, is `PutEvents` from the handler after the write. Its failure window must then be added to this record.
- Pipes is billed on its own. I did not look up the price, so check current pricing in the cost doc when the first pipe is deployed.
- Sources: [Pipes endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ev_pipes.html) and [DynamoDB stream as a Pipes source](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-dynamodb.html).
