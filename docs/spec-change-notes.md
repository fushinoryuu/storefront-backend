# Spec change notes

The spec edits planned for the library demo: a non-breaking v1.1.0 and a breaking v2.0.0 served at `/v2` next to `/v1`. This page lists the exact edits to the specs and nothing else. The implementation, the tests and the effect on a generated client are part of the Phase 5 work.

None of these edits is in the drafts. They apply to the released specs (`info.version` 1.0.0), after the services are built. How the specs are written is in [spec-conventions.md](spec-conventions.md), and how changes reach the library project is in [spec-handoff.md](spec-handoff.md).

## For every edit

1. Change the source under `services/<service>/`, never a bundle.
2. Set `info.version` as the heading of each section says.
3. Run `npm run bundle:specs`, then `npm run lint:specs`, and commit the bundle with the source.
4. Tell the library project the file name and the new `info.version`.

Every new body and response needs an example, and every new 4xx response needs the `Problem` schema, as everywhere else.

## v1.1.0: non-breaking, in the `/v1` specs

A client generated from 1.0.0 keeps working: nothing is removed, renamed or made required. New request fields are optional, new response fields are not in `required`, and the new route is an addition.

### Customers: `services/customers/openapi.yaml`, 1.0.0 to 1.1.0

An optional `preferredLanguage` field.

1. Add a schema under `components.schemas`:

   ```yaml
   LanguageTag:
     type: string
     description: >-
       A language tag such as `en` or `pt-BR`: a two or three letter language in lowercase, and
       optionally a two-letter region in capitals.
     pattern: '^[a-z]{2,3}(-[A-Z]{2})?$'
     maxLength: 10
   ```

2. Add this property to `Customer`, `CreateCustomer` and `UpdateCustomer`, and leave it out of every `required` list:

   ```yaml
   preferredLanguage:
     $ref: '#/components/schemas/LanguageTag'
   ```

3. Add `preferredLanguage: en` to the `createCustomer` request example and to every `Customer` example in a response (`createCustomer`, `listCustomers`, `getCustomer`, `updateCustomer`), so the mock servers show it. Examples that leave it out stay valid.

### Orders: `services/orders/openapi.yaml`, 1.0.0 to 1.1.0

A status history route and an optional `notes` field.

1. Add the route under `paths`, after `/v1/orders/{orderId}`:

   ```yaml
   /v1/orders/{orderId}/timeline:
     get:
       operationId: getOrderTimeline
       summary: Get the status history of an order
       description: >-
         The statuses the order has been in, oldest first. The last entry is the current status.
       tags: [orders]
       parameters:
         - $ref: '#/components/parameters/OrderId'
       responses:
         '200':
           description: The status history.
           content:
             application/json:
               schema:
                 $ref: '#/components/schemas/OrderTimeline'
               example:
                 orderId: ord_5b8a2e1c
                 entries:
                   - status: PENDING
                     occurredAt: '2026-11-02T17:48:58Z'
                   - status: CONFIRMED
                     occurredAt: '2026-11-02T17:49:10Z'
         '403':
           $ref: '../../specs/shared/components.yaml#/components/responses/Forbidden'
         '404':
           $ref: '../../specs/shared/components.yaml#/components/responses/NotFound'
         '429':
           $ref: '../../specs/shared/components.yaml#/components/responses/TooManyRequests'
   ```

2. Add two schemas under `components.schemas`:

   ```yaml
   OrderTimeline:
     type: object
     required: [orderId, entries]
     properties:
       orderId:
         type: string
       entries:
         type: array
         items:
           $ref: '#/components/schemas/OrderTimelineEntry'
   OrderTimelineEntry:
     type: object
     required: [status, occurredAt]
     properties:
       status:
         $ref: '#/components/schemas/OrderStatus'
       occurredAt:
         type: string
         format: date-time
         description: When the order entered this status.
   ```

3. Add this property to `CreateOrder` and to `Order`, and leave it out of every `required` list:

   ```yaml
   notes:
     type: string
     minLength: 1
     maxLength: 500
     description: A note from the customer. Free text.
   ```

4. Add `notes: Leave with the neighbor.` to the `createOrder` request example and to the `201` example.
5. In the `createOrder` description, under **Idempotency**, add the sentence: "`notes` is part of the body, so the same key with a different note answers 409."

### Shipping: `services/shipping/openapi.yaml`, 1.0.0 to 1.1.0

An optional `carrier` filter on `listShipments`.

1. Add this to the `parameters` of `listShipments`, after `status`:

   ```yaml
   - name: carrier
     in: query
     required: false
     description: >-
       Only shipments with this carrier, compared exactly. A shipment that has no carrier yet never
       matches.
     schema:
       type: string
     example: Fakeship
   ```

## v2.0.0: breaking, served at `/v2` next to `/v1`

Orders and shipping each get a second business spec, `services/<service>/openapi-v2.yaml`, and a bundle `specs/<service>-service-v2.yaml`. The `/v1` specs stay as they are, at 1.1.0. Customers has no v2.

Start each `openapi-v2.yaml` as a copy of the `/v1` source at 1.1.0, so a v2 client has the whole service, then make these edits.

For both services:

1. Set `info.version` to `2.0.0`.
2. Change the prefix of every path from `/v1` to `/v2`, and the same in every `Location` header example.
3. Leave the shared references, the `operationId`s and the tags as they are, so a call reads `ordersService.v2.orders.createOrder` next to `ordersService.v1.orders.createOrder`.
4. Add the edits for the service below.

Nothing changes in the `/v0` specs. `GET /v0/version` lists the new prefix in `specVersions` once the service serves it, and its schema already allows any key.

### Orders: `services/orders/openapi-v2.yaml`

`POST /v2/orders` requires a new field, `shippingAddressId`, and the order carries it.

1. In `CreateOrder`, add the property and require it. The `required` list becomes `[customerId, shippingAddressId, items]`:

   ```yaml
   shippingAddressId:
     type: string
     format: uuid
     description: >-
       An address of the customer. It is where the order ships to.
   ```

2. In `Order`, add the same property with the description "The address the order ships to." and add it to `required`: `[orderId, customerId, shippingAddressId, status, items, currency, total, version, createdAt, updatedAt]`.
3. Add `shippingAddressId: a41d9e07-52c3-4f0b-8f5e-6b1c0d9e2f33` to the `createOrder` request example and to every `Order` example in a response.
4. In the `createOrder` description, change the last paragraph to say the answer is 422 when the customer does not exist or is deleted, or when `shippingAddressId` is not an address of that customer. Change the description of the `UnknownCustomer` response in the same way. The status stays 422, so the response does not change shape.

### Shipping: `services/shipping/openapi-v2.yaml`

The status `PICKED` is renamed `PACKED`. A client that switches on the status breaks.

1. In the `ShipmentStatus` enum, replace `PICKED` with `PACKED`: `[CREATED, PACKED, SHIPPED, DELIVERED, CANCELLED]`. Change its description to match ("It moves forward through `CREATED`, `PACKED`, `SHIPPED` and `DELIVERED`.").
2. In the `advanceShipment` description, write the steps as `CREATED` to `PACKED`, `PACKED` to `SHIPPED`, `SHIPPED` to `DELIVERED`.
3. Change `status: PICKED` to `status: PACKED` in the `advanceShipment` `200` example. Check the other examples for the value as well.

The `status` filter of `listShipments` uses the schema, so it follows the rename.

## Optional: deprecation headers on `/v1`

Once `/v2` is served, the orders and shipping `/v1` responses can carry `Deprecation` and `Sunset` headers. If so, define both headers in the `components.headers` of each of those two `/v1` specs, add them to every response, and raise `info.version` to 1.1.1. Customers has no `/v2`, so it does not get them.
