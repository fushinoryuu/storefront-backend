import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { correlationHeaders } from './correlation';
import { ServiceUnavailableError } from './errors';

// The client for calls from one service to another (decision 0009).

export type SecretReader = (secretId: string) => Promise<string>;

/** Reads the string value of a secret from Secrets Manager. */
export function secretsManagerReader(client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({})): SecretReader {
    return async (secretId) => {
        const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
        if (!SecretString) throw new Error(`The secret ${secretId} has no string value.`);
        return SecretString;
    };
}

/**
 * The `services` API key. The secret is read on the first call and the answer is kept for the life of the execution environment, so create the provider once, outside the handler.
 * Calls made while the first read is still running share it. A read that fails is not kept, so the next call tries again.
 */
export function createServiceKeyProvider({ secretId, read = secretsManagerReader() }: { secretId: string; read?: SecretReader }): () => Promise<string> {
    let key: Promise<string> | undefined;
    return () => {
        key ??= read(secretId).catch((error: unknown) => {
            key = undefined;
            throw error;
        });
        return key;
    };
}

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'PUT' | 'DELETE' | 'POST' | 'PATCH';

// Repeating one of these gives the same result as doing it once. POST and PATCH are never repeated.
const repeatable = new Set<HttpMethod>(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export interface HttpClientOptions {
    /** The name of the service that is called, used in error messages. */
    service: string;
    /** The base URL of the service, with the stage in it if it has one. */
    baseUrl: string;
    /** How long to wait for an answer, in milliseconds, for each attempt. */
    timeoutMs: number;
    /** Gives the `services` API key. See `createServiceKeyProvider`. */
    getApiKey: () => Promise<string>;
    /** Extra attempts after a timeout, a network failure or a 502, 503 or 504, for GET, HEAD, OPTIONS, PUT and DELETE only. Defaults to 0, no retry. */
    retries?: number;
    fetch?: typeof fetch;
}

export interface HttpRequest {
    method?: HttpMethod;
    /** The path with its leading slash and query string, for example `/v1/customers/123`. */
    path: string;
    correlationId: string;
    /** Sent as JSON. */
    body?: unknown;
    headers?: Readonly<Record<string, string>>;
}

export interface HttpResult {
    status: number;
    headers: Headers;
    /** The parsed JSON, the text when it is not JSON, or undefined when there is no body. */
    body: unknown;
}

export interface HttpClient {
    /** Resolves with every answer below 500, 4xx included, because a 404 is an answer the caller has to interpret. Anything else is a `ServiceUnavailableError` (a 503 for our own caller). */
    request(request: HttpRequest): Promise<HttpResult>;
}

function parseBody(text: string): unknown {
    if (text === '') return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function retryAfter(headers: Headers): number | undefined {
    const seconds = Number(headers.get('retry-after'));
    return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** One attempt that did not get an answer worth returning. A 500 is not tried again, because the server may have done the work before it failed. */
interface Failure {
    error: ServiceUnavailableError;
    retryable: boolean;
}

export function createHttpClient({ service, baseUrl, timeoutMs, getApiKey, retries = 0, fetch: send = fetch }: HttpClientOptions): HttpClient {
    const root = baseUrl.replace(/\/+$/, '');

    async function attempt(request: HttpRequest, apiKey: string): Promise<HttpResult | Failure> {
        const { method = 'GET', path, correlationId, body, headers } = request;
        let response: Response;
        try {
            response = await send(`${root}${path}`, {
                method,
                headers: {
                    accept: 'application/json',
                    ...(body !== undefined && { 'content-type': 'application/json' }),
                    ...headers,
                    ...correlationHeaders(correlationId),
                    'x-api-key': apiKey
                },
                ...(body !== undefined && { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (cause) {
            const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
            return { error: new ServiceUnavailableError(`The ${service} service ${timedOut ? 'did not answer in time' : 'could not be reached'}.`, undefined, { cause }), retryable: true };
        }
        if (response.status >= 500) {
            await response.body?.cancel();
            const cause = new Error(`The ${service} service answered ${response.status}.`);
            return { error: new ServiceUnavailableError(`The ${service} service is not available.`, retryAfter(response.headers), { cause }), retryable: [502, 503, 504].includes(response.status) };
        }
        return { status: response.status, headers: response.headers, body: parseBody(await response.text()) };
    }

    return {
        async request(request) {
            const apiKey = await getApiKey();
            const attempts = 1 + (repeatable.has(request.method ?? 'GET') ? retries : 0);
            for (let n = 1; ; n++) {
                const outcome = await attempt(request, apiKey);
                if (!('error' in outcome)) return outcome;
                if (n >= attempts || !outcome.retryable) throw outcome.error;
            }
        }
    };
}
