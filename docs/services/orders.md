# Orders service

What exists after the first slice ([slice A in the roadmap](../ROADMAP.md)), and what the check on `dev` showed. The table is in [orders-table-design.md](orders-table-design.md), and the tasks that are left are in the [Phase 3 doc](../roadmap-phases/phase-3-orders-service.md).

## What exists

Three routes of the `v1` spec (`services/orders/openapi.yaml`), behind the `Storefront-<stage>-Orders` stack (`infra/lib/stacks/orders-stack.ts`):

| Route                      | Function       | Table access         |
| -------------------------- | -------------- | -------------------- |
| `GET /v1/products`         | `ListProducts` | none                 |
| `POST /v1/orders`          | `CreateOrder`  | `GetItem`, `PutItem` |
| `GET /v1/orders/{orderId}` | `GetOrder`     | `GetItem`            |

- **Prices** come from the catalog (`services/orders/data/products.json`, 12 products). A body has no price: a `unitPrice` or any other field the spec does not list is a 400. Totals are integers in minor units.
- **Idempotency.** `Idempotency-Key` is required. The same key and body again return the first order, another body is a 409, and the key is remembered for 24 hours (`services/orders/src/place-order.ts`).
- **The API** accepts the `tests` and `services` keys. `GET /v0/health` and `GET /v0/version` need no key, and `/v0/version` reports the spec versions (0.2.0 and 0.3.0 now).
- **The table** has the keys, both indexes, TTL on `expiresAt` and a stream with new and old images. Nothing reads the stream yet. It has point-in-time recovery in `prod` and not in `dev`.
- **Alarms:** the three of every function, the three of the API, and two on the table (throttled requests and system errors). All notify the alarm topic of the `Platform` stack.

Not built yet: the customer check (slice B), the events and the pipe (slice C), `listOrders`, `cancelOrder` and optimistic locking (slice D). Until slice B, an order is accepted for any customer id.

## Deploy and destroy

`Platform` comes first, because `Orders` reads its alarm topic and API keys from SSM.

```sh
npm run deploy:platform -- -c stage=dev
npm run deploy:orders -- -c stage=dev
npm run destroy:orders -- -c stage=dev
```

`deploy:orders` deploys that stack alone, so it never changes `Platform`. A destroy of `Orders` deletes its table and every order in it (seen on `dev`, below).

## The check on `dev`

By hand on 2026-11-25, one request at a time, with the `tests` key (`npm run get-api-keys -- --stage dev`), against a stack that was deployed from the branch before it was merged.

Seen:

- `GET /v0/health` is 200 and `GET /v0/version` reports `v0` 0.2.0 and `v1` 0.3.0, both without a key. A call to `/v1/products` or `/v1/orders` without a key is the shared 403.
- `listProducts` returns the 12 products of the catalog.
- `createOrder` returns a 201 with a `Location` header (`/v1/orders/<orderId>`) and a total from the catalog (2 × 2499 + 1 × 1299 = 6297). `getOrder` returns the same order and total.
- The same key and body again return the same order, with the same `createdAt`. The same key with another body is a 409.
- A `unitPrice` on a line is a 400 that names `items[0]`, so a client-supplied price cannot change a total. An unknown product (`items[0].productId`), a quantity of 0, a missing `Idempotency-Key` and an unknown order are the 400s and the 404 that the spec says, in the shared error shape with a `correlationId`.
- The log line of a refused request has the level, the `service`, the `stage`, the `correlationId`, the `requestId` and the X-Ray trace id, and the status and type of the error. It has no body and no customer id. The access log has one JSON line per request with the declared route (`/v1/orders`), not the real path.
- The stack has 17 alarms (12 of the four functions, 3 of the API, 2 of the table), all `OK` after the check. The table is on demand with the stream and both indexes, TTL is on `expiresAt`, and point-in-time recovery is off, as `dev` says. The log groups keep logs for 7 days.
- `cdk diff` against the deployed stack showed no difference after the check.
- `npm run destroy:orders` removed the stack (`DELETE_COMPLETE`). No table, no log group and no `base-url` parameter of `Orders` was left.
- `Storefront-dev-Platform` was not made for this check: it had been deployed since 2026-11-19 (updated on 2026-11-23), and the check used its alarm topic and its `tests` key. `deploy:orders` leaves it alone. After the check the maintainer destroyed it too with `npm run destroy:platform -- -c stage=dev`, and it ended `DELETE_COMPLETE` on 2026-11-26. No event bus, archive, alarm topic, `dev` parameter or API key of it was left, so no stack of the `dev` stage is left. That was the first run of `destroy:platform` against AWS. `Storefront-prod-Platform`, `Storefront-Secrets` and `Storefront-ApiGatewayAccount` were not touched. The next deploy of `Platform` in `dev` makes new API keys, so run `npm run get-api-keys -- --stage dev` again.

Not seen:

- The `services` key (only `tests` was used), the quotas and the throttles of the usage plans, and what happens above the account's limit of 10 concurrent executions.
- A cold start: the time of the first request after the functions were created was not measured.
- Any alarm firing, and the email of an alarm (the `dev` alarm topic has no subscriber unless `ALARM_RECIPIENTS` was set).
- The `prod` stack, and point-in-time recovery on a deployed table.
- Two requests with the same key at the same moment. The repository tests run that case against DynamoDB Local, and `place-order.test.ts` covers the answers after it.

One finding, not changed here: the 400 for a missing `Idempotency-Key` says "Invalid input: expected string, received undefined", which is the validator's text and does not tell a caller that the header is required.
