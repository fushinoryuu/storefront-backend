import { DomainError, correlationHeaders, getCorrelationId, problemResponse } from '../../../packages/shared/src';
import type { HeaderBag, HttpResponse, RequestLogger, ServiceLogger } from '../../../packages/shared/src';

/** What the handlers read of an API Gateway proxy event. */
export interface ApiEvent {
    readonly headers?: HeaderBag;
    readonly pathParameters?: Readonly<Record<string, string | undefined>> | null;
    readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
    readonly body?: string | null;
}

export interface LambdaContext {
    readonly awsRequestId: string;
}

export type ApiHandler = (event: ApiEvent, context: LambdaContext) => Promise<HttpResponse>;

export interface Reply {
    readonly status: number;
    readonly body: unknown;
    readonly headers?: Readonly<Record<string, string>>;
}

export interface Request {
    readonly event: ApiEvent;
    readonly correlationId: string;
    readonly log: RequestLogger;
}

/**
 * Wraps the code of one route in what every handler does: find the correlation id, log with it, answer with the JSON of the reply, and turn any error into a `Problem`.
 * An error the caller can be told about (a `DomainError`) is logged at `warn`, with its status and type. Any other error is logged with its stack, and the caller gets a 500 without detail.
 */
export function route(logger: ServiceLogger, handle: (request: Request) => Promise<Reply>): ApiHandler {
    return async (event, context) => {
        const correlationId = getCorrelationId(event.headers);
        const log = logger.forRequest({ correlationId, requestId: context.awsRequestId });
        try {
            const { status, body, headers } = await handle({ event, correlationId, log });
            return { statusCode: status, headers: { 'content-type': 'application/json', ...correlationHeaders(correlationId), ...headers }, body: JSON.stringify(body) };
        } catch (error) {
            if (error instanceof DomainError) log.warn('request refused', { status: error.kind.status, type: error.kind.slug });
            else log.error('request failed', { error });
            return problemResponse(error, correlationId);
        }
    };
}
