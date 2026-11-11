# shared

Code that every service uses, so they log, trace a request and report errors the same way. Services import this package and never Powertools itself (decision [0010](../../docs/decisions/0010-observability-toolkit.md)). It also holds the validation wrapper, the idempotency helper and the HTTP client. The feature flag client is added by a later ticket.

## A handler, start to finish

```ts
import { createLogger, getCorrelationId, correlationHeaders, problemResponse, NotFoundError } from '../../packages/shared/src'; // relative to a file in services/<service>/src

const logger = createLogger({ service: 'shipping', stage: process.env.STAGE! }); // once per execution environment, outside the handler

export async function handler(event: APIGatewayProxyEvent, context: Context) {
  const correlationId = getCorrelationId(event.headers);
  const log = logger.forRequest({ correlationId, requestId: context.awsRequestId });
  try {
    log.info('getting a shipment', { shipmentId });
    const shipment = await find(shipmentId); // throws NotFoundError
    return { statusCode: 200, headers: { 'content-type': 'application/json', ...correlationHeaders(correlationId) }, body: JSON.stringify(shipment) };
  } catch (error) {
    log.error('request failed', { error });
    return problemResponse(error, correlationId);
  }
}
```

## Logger

`createLogger({ service, stage })` wraps the Powertools Logger. The only way to get a logger from it is `forRequest({ correlationId, requestId })`, so every line carries `correlationId`, `requestId`, `service` and `stage`, as well as the usual `level`, `message` and `timestamp`. Put an `Error` in a field to log its name, message and stack. The level comes from the `POWERTOOLS_LOG_LEVEL` environment variable.

These are never logged: the value of a field named like an email, a phone number or an address (`email`, `phone`, `address`, `addresses`, `shippingAddress`, `line1`, `line2`, `street`, `city`, `postalCode` and `zip`, in any case, with or without `_` and `-`), and an email address inside any text, such as a message or an error. They are replaced by `[REDACTED]`. A field named like `addressId` is kept. To cover another name, add it to `redactedKeys` in `src/logger.ts`.

## Correlation id

`getCorrelationId(headers)` returns the `x-correlation-id` header of a request, whatever its case, or a new UUID when the header is missing. A header that is empty, longer than 128 characters or has anything other than letters, digits, `.`, `_`, `:` and `-` is treated as missing, because the value goes into every log line and error body. Return `correlationHeaders(id)` on every response and send it on every downstream HTTP call. Pass the id as `correlationId` to `buildEvent` from `packages/events`.

## Errors

The error body is the `Problem` schema of `specs/shared/components.yaml`, and a test validates it against that file. Throw a `DomainError` from the domain code, and the handler calls `problemResponse(error, correlationId)`, the one place that maps an error to a status:

| Throw                                                 | Status | `type` ends with                           |
| ----------------------------------------------------- | ------ | ------------------------------------------ |
| `ValidationError(errors[])`                           | 400    | `invalid-request`                          |
| `ForbiddenError`                                      | 403    | `forbidden`                                |
| `NotFoundError`                                       | 404    | `not-found`                                |
| `ConflictError`                                       | 409    | `conflict`                                 |
| `ServiceUnavailableError(detail, retryAfterSeconds?)` | 503    | `service-unavailable` (with `Retry-After`) |
| anything else, including a plain `Error`              | 500    | `internal-error`                           |

A kind of problem that only one service has is a `DomainError` with its own `ProblemKind`, for example `new DomainError({ slug: 'unknown-customer', title: 'Unknown customer', status: 422 }, 'There is no customer with this id.')` in orders. The 429 for a throttled key is produced by API Gateway, so there is no class for it here. An error that is not a `DomainError` is answered with a 500 and no detail, so its message does not reach the caller, and it should be logged before it is returned.

## Validation

Requests are validated with the Zod schemas generated from the bundled specs (decision [0004](../../docs/decisions/0004-api-definition.md)). `npm run generate:schemas` writes them to `generated/<bundle>/zod.gen.ts`, and `npm test` and `npm run typecheck` run it first. Each operation has `z<OperationId>Body`, `z<OperationId>Path`, `z<OperationId>Query` and `z<OperationId>Headers` where it has that part, for example `zCreateOrderBody` and `zListOrdersQuery` in `generated/orders-service-v1/zod.gen.ts`.

```ts
import { zCreateOrderBody, zCreateOrderHeaders } from '../../../generated/orders-service-v1/zod.gen'; // relative to a file in services/<service>/src

const headers = validateParameters(zCreateOrderHeaders, event.headers); // finds Idempotency-Key whatever its case
const order = validate(zCreateOrderBody, parseJsonBody(event.body));
```

- `validate(schema, input)` returns the parsed value, or throws a `ValidationError`, so `problemResponse` answers 400 with one `errors[]` entry per field. `field` is the path in the request (`items[0].quantity`), and `body` when the whole input is wrong.
- `parseJsonBody(event.body)` throws the same error for a missing body or text that is not JSON.
- `validateParameters(schema, values)` is for the query string, path parameters and headers. Their values are text, so it turns a value into a number or a boolean when the schema asks for one, applies defaults, matches names whatever their case and ignores names the schema does not have.

## Idempotency

`createIdempotency({ client, tableName, ttlSeconds })` remembers keys in a DynamoDB table that has string keys `PK` and `SK` and TTL on the attribute `expiresAt` (epoch seconds), which the stack that owns the table sets. Use an event id, or the `Idempotency-Key` of a request, as the key.

```ts
const idempotency = createIdempotency({ client: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: process.env.TABLE_NAME!, ttlSeconds: 24 * 3600 }); // once per execution environment

if (!(await idempotency.claim(event.id))) return; // seen before
try {
  await process(event);
} catch (error) {
  await idempotency.release(event.id); // so that the redelivery is not taken for a repeat
  throw error;
}
```

`claim` is one conditional put, so of many simultaneous calls with one key exactly one gets `true`. DynamoDB removes an expired item some time after `expiresAt`, so `claim` also accepts a key whose time has run out. It does not store a response or compare request bodies: the orders rules for a repeated key (the stored response, and a 409 for a different body) are for the orders service to add.

## HTTP client

For calls from one service to another (decision [0009](../../docs/decisions/0009-service-to-service-calls.md)).

```ts
const getApiKey = createServiceKeyProvider({ secretId: process.env.SERVICES_KEY_SECRET! }); // once per execution environment
const customers = createHttpClient({ service: 'customers', baseUrl: process.env.CUSTOMERS_URL!, timeoutMs: 2000, getApiKey });

const { status, body } = await customers.request({ path: `/v1/customers/${id}`, correlationId });
if (status === 404) throw new DomainError(unknownCustomer, 'There is no customer with this id.');
```

- Every call carries `x-correlation-id` and the `services` key in `x-api-key`. A header the caller passes cannot replace either.
- The secret is read from Secrets Manager once per execution environment. Calls that start while the read is running share it, and a failed read is tried again by the next call.
- An answer below 500 is returned, 404 and 409 included, because the caller decides what they mean. A timeout (it also covers reading the body), a network failure, a body that breaks off after the headers and any 5xx are thrown as a `ServiceUnavailableError`, which `problemResponse` answers as a 503 (with the `Retry-After` of the other service when it sent one).
- There is no retry unless `retries` is set, and then only for GET, HEAD, OPTIONS, PUT and DELETE, and only after a timeout, a network failure or a 502, 503 or 504. A POST or a PATCH is attempted once. Retries follow each other at once, without a pause.

## Tests that need DynamoDB Local

The idempotency tests run against DynamoDB Local when `DYNAMODB_ENDPOINT` is set, and are skipped when it is not. In CI (`CI=true`) a missing endpoint fails them instead. CI starts the container itself. To run them on your machine:

```
docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2 -jar DynamoDBLocal.jar -inMemory -sharedDb
DYNAMODB_ENDPOINT=http://localhost:8000 npm test
```
