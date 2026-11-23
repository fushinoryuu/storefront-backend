import { ResponseType } from 'aws-cdk-lib/aws-apigateway';
import type { RestApi } from 'aws-cdk-lib/aws-apigateway';
import { problemKinds, problemTypeBase } from '../../../packages/shared/src/errors';
import type { ProblemKind } from '../../../packages/shared/src/errors';

/** What API Gateway puts in the body in place of the request id: the `requestId` of the gateway, the only id a response that no handler made can have. */
export const requestIdVariable = '$context.requestId';

/** How a gateway response gives the correlation id as a header. A response parameter, so there are no `$` and no quotes: `context.requestId`. */
const correlationHeader = { 'x-correlation-id': 'context.requestId' } as const;

/** How long a caller is told to wait after the gateway could not reach the function. A starting point, as the other numbers of `ServiceApi`. */
export const retryAfterSeconds = 5;

export interface GatewayResponseSpec {
    readonly type: ResponseType;
    /** The shared problem kind the body shows. Its status is the status of the response. */
    readonly kind: ProblemKind;
    /** Said to the caller. Leave it out for the 500, so the response does not show how the service works inside (as `InternalError` in the shared spec). */
    readonly detail?: string;
    /** Extra headers of the response. A static value is in single quotes, as API Gateway wants it. */
    readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The gateway responses of every `ServiceApi`: the answers that API Gateway makes itself, which would otherwise have a body of its own and no correlation id.
 * Each one is a `Problem` of the shared spec (`specs/shared/components.yaml`). Add a response here and `ServiceApi` makes it, and the tests check its body against the schema.
 *
 * - `INVALID_API_KEY`: a key that is missing or not known is a 403 `forbidden`.
 * - `THROTTLED` and `QUOTA_EXCEEDED`: a rate or a daily quota used up is a 429 `too-many-requests`.
 * - `MISSING_AUTHENTICATION_TOKEN`: a route that does not exist, or a method that the route does not have, is a 404 `not-found`. API Gateway makes it a 403, which says the key is wrong when it is the address.
 * - `INTEGRATION_TIMEOUT` and `INTEGRATION_FAILURE`: the gateway gave up waiting for the function, or could not reach it, is a 503 `service-unavailable` with `Retry-After`. The library project retries a 503.
 * - `DEFAULT_5XX`: every other error that API Gateway makes, such as a function that throws or runs past its own timeout, is a 500 `internal-error`, the same answer as an error that a handler does not handle.
 *   Not verified: the documentation of the response types does not say which of them API Gateway uses when a Lambda function times out or throws. It answered 502 `Internal server error` in `dev`. Whether `DEFAULT_5XX` replaces that 502 is checked on a deployed API.
 *   `DEFAULT_5XX` sets the status of every 5xx that has no response of its own, which is why the two integration responses above are set on their own.
 */
export const gatewayResponses: readonly GatewayResponseSpec[] = [
    { type: ResponseType.INVALID_API_KEY, kind: problemKinds.forbidden, detail: 'The API key is missing or not allowed.' },
    { type: ResponseType.THROTTLED, kind: problemKinds.tooManyRequests, detail: 'The rate limit for this API key was reached.' },
    { type: ResponseType.QUOTA_EXCEEDED, kind: problemKinds.tooManyRequests, detail: 'The daily quota for this API key was used up.' },
    { type: ResponseType.MISSING_AUTHENTICATION_TOKEN, kind: problemKinds.notFound, detail: 'There is no such route.' },
    { type: ResponseType.INTEGRATION_TIMEOUT, kind: problemKinds.serviceUnavailable, detail: 'The service did not answer in time.', headers: { 'retry-after': `'${retryAfterSeconds}'` } },
    { type: ResponseType.INTEGRATION_FAILURE, kind: problemKinds.serviceUnavailable, detail: 'The service could not be reached.', headers: { 'retry-after': `'${retryAfterSeconds}'` } },
    { type: ResponseType.DEFAULT_5XX, kind: problemKinds.internalError }
];

/** The body template of a gateway response: a `Problem` as JSON, with the request id of the gateway as the correlation id. */
export function problemTemplate({ kind, detail }: Pick<GatewayResponseSpec, 'kind' | 'detail'>): string {
    return JSON.stringify({
        type: `${problemTypeBase}/${kind.slug}`,
        title: kind.title,
        status: kind.status,
        ...(detail !== undefined && { detail }),
        correlationId: requestIdVariable
    });
}

/** `INVALID_API_KEY` becomes `InvalidApiKey`, because construct ids are PascalCase (conventions). */
function pascalCase(responseType: string): string {
    return responseType
        .split('_')
        .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
        .join('');
}

/** Makes every response of `gatewayResponses` on the API. */
export function addGatewayResponses(api: RestApi): void {
    for (const spec of gatewayResponses) {
        api.addGatewayResponse(`${pascalCase(spec.type.responseType)}Response`, {
            type: spec.type,
            statusCode: String(spec.kind.status),
            responseHeaders: { ...correlationHeader, ...spec.headers },
            templates: { 'application/json': problemTemplate(spec) }
        });
    }
}
