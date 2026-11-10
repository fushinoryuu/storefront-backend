import { correlationHeaders } from './correlation';

// The error model. `Problem` matches the schema of the same name in specs/shared/components.yaml, and the types in this file follow the problem kinds documented there.

export const problemTypeBase = 'https://storefront.example/problems';

export interface FieldError {
    field: string;
    message: string;
}

export interface Problem {
    type: string;
    title: string;
    status: number;
    detail?: string;
    correlationId: string;
    errors?: FieldError[];
}

/** A kind of problem. The slug becomes the end of the `type` URI, and the title and status are the same every time. */
export interface ProblemKind {
    readonly slug: string;
    readonly title: string;
    readonly status: number;
}

export const problemKinds = {
    invalidRequest: { slug: 'invalid-request', title: 'Invalid request', status: 400 },
    forbidden: { slug: 'forbidden', title: 'Forbidden', status: 403 },
    notFound: { slug: 'not-found', title: 'Not found', status: 404 },
    conflict: { slug: 'conflict', title: 'Conflict', status: 409 },
    serviceUnavailable: { slug: 'service-unavailable', title: 'Service unavailable', status: 503 },
    internalError: { slug: 'internal-error', title: 'Internal server error', status: 500 }
} as const satisfies Record<string, ProblemKind>;

/**
 * An error the caller can be told about. Throw it from the domain code and let the handler turn it into a response.
 * A service with a kind of its own (for example the 422 `unknown-customer` of orders) extends this class with that kind.
 */
export class DomainError extends Error {
    readonly kind: ProblemKind;
    readonly detail: string | undefined;

    constructor(kind: ProblemKind, detail?: string, options?: ErrorOptions) {
        super(detail ?? kind.title, options);
        this.name = new.target.name;
        this.kind = kind;
        this.detail = detail;
    }
}

export class ValidationError extends DomainError {
    readonly errors: readonly FieldError[];

    constructor(errors: readonly FieldError[], detail = 'One or more fields are not valid.', options?: ErrorOptions) {
        super(problemKinds.invalidRequest, detail, options);
        this.errors = errors;
    }
}

export class ForbiddenError extends DomainError {
    constructor(detail = 'The API key is missing or not allowed.', options?: ErrorOptions) {
        super(problemKinds.forbidden, detail, options);
    }
}

export class NotFoundError extends DomainError {
    constructor(detail = 'There is no resource with this id.', options?: ErrorOptions) {
        super(problemKinds.notFound, detail, options);
    }
}

export class ConflictError extends DomainError {
    constructor(detail = 'The resource is not in a state that allows this.', options?: ErrorOptions) {
        super(problemKinds.conflict, detail, options);
    }
}

export class ServiceUnavailableError extends DomainError {
    /** Seconds the caller should wait, sent as `Retry-After`. */
    readonly retryAfterSeconds: number | undefined;

    constructor(detail = 'A service this one depends on did not answer.', retryAfterSeconds?: number, options?: ErrorOptions) {
        super(problemKinds.serviceUnavailable, detail, options);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/** The one place that turns an error into a `Problem`. Anything that is not a `DomainError` becomes a 500 without detail, so internals do not leak. */
export function toProblem(error: unknown, correlationId: string): Problem {
    if (!(error instanceof DomainError)) {
        const { slug, title, status } = problemKinds.internalError;
        return { type: `${problemTypeBase}/${slug}`, title, status, correlationId };
    }
    const { slug, title, status } = error.kind;
    return {
        type: `${problemTypeBase}/${slug}`,
        title,
        status,
        ...(error.detail !== undefined && { detail: error.detail }),
        correlationId,
        ...(error instanceof ValidationError && { errors: [...error.errors] })
    };
}

export interface HttpResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

/** The error response of a handler: the status, the `Problem` as JSON, the correlation id header and, for a 503, `Retry-After`. */
export function problemResponse(error: unknown, correlationId: string): HttpResponse {
    const problem = toProblem(error, correlationId);
    const retryAfter = error instanceof ServiceUnavailableError ? error.retryAfterSeconds : undefined;
    return {
        statusCode: problem.status,
        headers: {
            'content-type': 'application/json',
            ...correlationHeaders(correlationId),
            ...(retryAfter !== undefined && { 'retry-after': String(retryAfter) })
        },
        body: JSON.stringify(problem)
    };
}
