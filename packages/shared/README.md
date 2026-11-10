# shared

Code that every service uses, so they log, trace a request and report errors the same way. Services import this package and never Powertools itself (decision [0010](../../docs/decisions/0010-observability-toolkit.md)). The validation wrapper, the idempotency helper, the HTTP client and the feature flag client are added by later tickets.

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
