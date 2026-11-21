import { correlationHeaders, getCorrelationId } from './correlation';
import type { HeaderBag } from './correlation';
import { NotFoundError, problemResponse } from './errors';
import type { HttpResponse } from './errors';

// The handler behind `GET /v0/health` and `GET /v0/version`, which `ServiceApi` adds to every API. The shapes are the ones in specs/shared/paths/health.yaml and version.yaml.

/** What the handler reads of an API Gateway proxy event. The route is the declared `resource`, never the real path. */
export interface OperationsEvent {
    readonly httpMethod?: string;
    readonly resource?: string;
    readonly headers?: HeaderBag;
}

/** The variables that `ServiceApi` sets on the function, besides the standard ones of `ServiceFunction`. */
export const operationsEnvironment = { buildId: 'BUILD_ID', specVersions: 'SPEC_VERSIONS' } as const;

function ok(body: unknown, correlationId: string): HttpResponse {
    return { statusCode: 200, headers: { 'content-type': 'application/json', ...correlationHeaders(correlationId) }, body: JSON.stringify(body) };
}

/** The `STAGE`, `BUILD_ID` and `SPEC_VERSIONS` of the function, or an error that says which one is wrong. `SPEC_VERSIONS` is a JSON object of prefix to version. */
function readVersion(env: Readonly<Record<string, string | undefined>>) {
    const { STAGE: stage, [operationsEnvironment.buildId]: buildId, [operationsEnvironment.specVersions]: specVersions } = env;
    if (!stage || !buildId || !specVersions) throw new Error('The function needs the STAGE, BUILD_ID and SPEC_VERSIONS variables.');
    return { buildId, stage, specVersions: JSON.parse(specVersions) as Record<string, string> };
}

/**
 * Answers the two operational routes. Health says only that the function runs, so it reads nothing and calls nothing. Version reports what the variables hold.
 * Any other route is a 404, and a missing variable is a 500 without detail, as for any error that is not a `DomainError`.
 * `env` is a parameter so a test can pass its own, and `onError` is how the entry logs an error with the correlation id of the request.
 */
export function handleOperations(event: OperationsEvent, env: Readonly<Record<string, string | undefined>>, onError?: (error: unknown, correlationId: string) => void): HttpResponse {
    const correlationId = getCorrelationId(event.headers);
    try {
        if (event.httpMethod === 'GET' && event.resource === '/v0/health') return ok({ status: 'ok' }, correlationId);
        if (event.httpMethod === 'GET' && event.resource === '/v0/version') return ok(readVersion(env), correlationId);
        throw new NotFoundError('This function answers GET /v0/health and GET /v0/version only.');
    } catch (error) {
        onError?.(error, correlationId);
        return problemResponse(error, correlationId);
    }
}
