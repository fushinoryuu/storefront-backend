# 0009: Service-to-service calls

Status: accepted on 2026-11-04.

## Context

Placing an order needs a customer to exist. Orders and customers use different stores (DynamoDB and Aurora) and are separate services, so orders cannot check with a query of its own. The services already talk through events, and the `services` API key exists for calls between them (ADR 0005).

## Options

- **Orders calls the customers API when an order is placed.** The answer is current, and there is nothing to keep in sync. Orders cannot place an order while customers is down or its database is resuming (ADR 0007).
- **Orders keeps a local copy of customers, updated from `CustomerCreated` and `CustomerUpdated` events.** Placing an order has no runtime dependency on customers. The copy is eventually consistent, so an order can race a new customer's event, and we would need a backfill and a way to repair the copy. It also makes the optional customer events in Phase 2 required.

## Decision

Orders call customers synchronously from `POST /v1/orders`, through the HTTP client in `packages/shared`.

- The call carries the `services` API key (read from Secrets Manager once per execution environment) and the correlation id.
- It has a short timeout and one attempt, with no retry.
- An unknown customer is a client error. Customers being unavailable is a 503 with the shared error shape, never a generic 500.
- The customers base URL comes from SSM.

## Consequences

- Placing an order depends on customers. When the customers database is paused, the first order after an idle hour can fail with a 503 until the cluster resumes (ADR 0007). Tests warm customers up first.
- Orders tests replace the client with a fake that returns success, not found, a timeout and a 5xx.
- There is nothing to repair if events are lost, which suits a demo.
- At a larger scale, move to the local copy: it removes the dependency from the order path, at the price of eventual consistency. That change needs a new record that supersedes this one.
- A call per order adds latency and load on customers. Nothing caches the answer.
