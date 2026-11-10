import { randomUUID } from 'node:crypto';

export const correlationIdHeader = 'x-correlation-id';

// What a client may send. It ends up in every log line and in the error body, so anything else is replaced by a generated id.
const acceptableCorrelationId = /^[A-Za-z0-9._:-]{1,128}$/;

export type HeaderBag = Readonly<Record<string, string | undefined>> | null | undefined;

function findHeader(headers: HeaderBag, name: string): string | undefined {
    if (!headers) return undefined;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name) return value;
    }
    return undefined;
}

/** The correlation id of a request: the `x-correlation-id` header when it is usable, a new UUID when it is missing or not usable. */
export function getCorrelationId(headers: HeaderBag): string {
    const value = findHeader(headers, correlationIdHeader)?.trim();
    return value !== undefined && acceptableCorrelationId.test(value) ? value : randomUUID();
}

/** The header that carries the correlation id. Put it on every response and on every downstream HTTP call. */
export function correlationHeaders(correlationId: string): Record<string, string> {
    return { [correlationIdHeader]: correlationId };
}
