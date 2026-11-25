# Orders table design

The DynamoDB table of the orders service, designed from the five access patterns of [Phase 3](../roadmap-phases/phase-3-orders-service.md). The shape is in `services/orders/src/table.ts`, which the stack and the tests both build the table from.

## The table

One table, on-demand capacity, with the keys `PK` and `SK` (strings). It has a stream with new and old images (nothing reads it yet), TTL on `expiresAt`, and point-in-time recovery in `prod` only (the stage setting `pointInTimeRecovery`: a `dev` table lives for the minutes of a run, so there is nothing to restore). Like every stack, it is destroyed with its stack in every stage (decision 0002).

| Item        | `PK`         | `SK`   | Other attributes that the keys and indexes read                                                     |
| ----------- | ------------ | ------ | --------------------------------------------------------------------------------------------------- |
| Order       | `ORDER#<id>` | `META` | `GSI1PK` = `CUSTOMER#<customerId>`, `GSI2PK` = `STATUS#<status>`, both sorted by `<createdAt>#<id>` |
| Idempotency | `IDEM#<key>` | `META` | `expiresAt` (epoch seconds, the TTL attribute)                                                      |

The order is one item. Its lines are a list inside it, which is fine while an order has at most 20 lines (the spec's limit) and stays far below the 400 KB of an item. The order item also keeps the correlation id of the request that placed it, which the outbox reads later, and it is never part of a response.

The two indexes project every attribute, because a list answers with whole orders and a second read per order would cost more than the copy.

| Index  | Partition key | Sort key                      |
| ------ | ------------- | ----------------------------- |
| `GSI1` | `GSI1PK`      | `GSI1SK` (`<createdAt>#<id>`) |
| `GSI2` | `GSI2PK`      | `GSI2SK` (`<createdAt>#<id>`) |

The sort key is the creation time in ISO 8601 and then the id, so it sorts by time and two orders created in the same millisecond cannot collide. A query with `ScanIndexForward: false` gives newest first.

## The access patterns

| #   | Pattern                                 | How it is served                                                                                                                                                                                                               |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Get an order by id                      | `GetItem` on `ORDER#<id>`, `META`, with a consistent read, so an order that was just placed is found                                                                                                                           |
| 2   | List a customer's orders, newest first  | `Query` on `GSI1` with `GSI1PK = CUSTOMER#<customerId>`, newest first. The customer id is stored in lower case                                                                                                                 |
| 3   | List orders by status, newest first     | `Query` on `GSI2` with `GSI2PK = STATUS#<status>`, newest first                                                                                                                                                                |
| 4   | Look up a prior request by its key      | `GetItem` on `IDEM#<key>`, `META`. The item holds a hash of the request and the order that it placed. It expires after 24 hours, and a reader ignores an expired item, because DynamoDB removes it some time after `expiresAt` |
| 5   | Update the status from a shipment event | A conditional `UpdateItem` on the order item, guarded by `version` and the previous status. It also moves `GSI2PK`, which is why the status is in a key of its own                                                             |

An order is written with all its index keys from the start, so no order has to be rewritten when the list routes are built. Only patterns 1 and 4 are read so far. Patterns 2, 3 and 5 belong to later slices.

## Placing an order

One `TransactWriteItems` call writes the order item (condition: it does not exist) and the idempotency item (condition: it does not exist, or it has expired). Both are written or neither. When the call is refused because of the idempotency item, a request with the same key was placed first or is being placed, and the service reads the item again and answers from it:

- the same hash: the order that is stored, answered like the first time (201 and `Location`);
- another hash: a 409;
- no item yet (the other request has not finished): a 409 that asks the caller to send it again.

## What it does not support

- **Listing every order of every customer with no filter.** The admin call of `listOrders` with neither `customerId` nor `status` has no index. It is built with the list routes, as one query per status that is merged by time, or with an index of its own, and this page changes then.
- **A search by anything but the patterns above**, such as by product or by date range across customers. Add a pattern first, and then the index.
- **An order of more than 20 lines.** The spec's limit keeps an order far below the item limit. Raising it means splitting the lines into items of their own.
- **A key that two customers share.** The key is not scoped to a customer. Another customer who sends the same key has another body, so the answer is a 409 and never somebody else's order.
