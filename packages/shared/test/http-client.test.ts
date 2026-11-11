import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableError, createHttpClient, createServiceKeyProvider, secretsManagerReader, toProblem, type HttpClientOptions } from '../src/index';

const correlationId = '6f0d6b1c-0c46-4d4c-b0b5-0c8d1f3f8f30';
const baseUrl = 'https://abc.execute-api.us-west-2.amazonaws.com/dev';

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function client(fetch: ReturnType<typeof vi.fn>, options: Partial<HttpClientOptions> = {}) {
    return createHttpClient({ service: 'customers', baseUrl, timeoutMs: 1000, getApiKey: async () => 'services-key', fetch: fetch as unknown as typeof globalThis.fetch, ...options });
}

/** A body that fails after the headers have arrived. */
const brokenBody = (cause: Error) =>
    new ReadableStream({
        pull(controller) {
            controller.error(cause);
        }
    });

/** A body that never ends, and fails with the reason of the signal when the timeout aborts the request, as a real fetch does. */
const lateBody = (signal: AbortSignal | null | undefined) =>
    new ReadableStream({
        start(controller) {
            signal?.addEventListener('abort', () => controller.error(signal.reason));
        }
    });

async function failureOf(run: Promise<unknown>): Promise<ServiceUnavailableError> {
    try {
        await run;
    } catch (error) {
        if (error instanceof ServiceUnavailableError) return error;
        throw error;
    }
    throw new Error('Expected a ServiceUnavailableError.');
}

describe('the request', () => {
    it('forwards the correlation id, attaches the services key and keeps the stage in the URL', async () => {
        const fetch = vi.fn().mockResolvedValue(json({ customerId: 'c-1' }));

        await client(fetch).request({ path: '/v1/customers/c-1', correlationId });

        const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${baseUrl}/v1/customers/c-1`);
        expect(init.method).toBe('GET');
        expect(init.headers).toMatchObject({ 'x-correlation-id': correlationId, 'x-api-key': 'services-key', accept: 'application/json' });
    });

    it.each(['/', '//'])('joins a base URL that ends in %s to the path with a single slash', async (ending) => {
        const fetch = vi.fn().mockResolvedValue(json({}));

        await client(fetch, { baseUrl: `${baseUrl}${ending}` }).request({ path: '/v1/customers', correlationId });

        expect((fetch.mock.calls[0] as [string])[0]).toBe(`${baseUrl}/v1/customers`);
    });

    it('does not let a caller header replace the key or the correlation id', async () => {
        const fetch = vi.fn().mockResolvedValue(json({}));

        await client(fetch).request({ path: '/x', correlationId, headers: { 'x-api-key': 'other', 'x-correlation-id': 'other', 'x-extra': '1' } });

        expect((fetch.mock.calls[0] as [string, RequestInit])[1].headers).toMatchObject({ 'x-api-key': 'services-key', 'x-correlation-id': correlationId, 'x-extra': '1' });
    });

    it('sends a body as JSON', async () => {
        const fetch = vi.fn().mockResolvedValue(json({}, { status: 201 }));

        await client(fetch).request({ method: 'POST', path: '/v1/customers', correlationId, body: { email: 'a@example.com' } });

        const init = (fetch.mock.calls[0] as [string, RequestInit])[1];
        expect(init.body).toBe('{"email":"a@example.com"}');
        expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    });

    it('returns an answer below 500, a 404 included, with its parsed body', async () => {
        const problem = { status: 404, title: 'Not found' };
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(json(problem, { status: 404 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(new Response('plain', { status: 200 }));
        const http = client(fetch);

        expect(await http.request({ path: '/a', correlationId })).toMatchObject({ status: 404, body: problem });
        expect(await http.request({ path: '/b', correlationId })).toMatchObject({ status: 204, body: undefined });
        expect(await http.request({ path: '/c', correlationId })).toMatchObject({ status: 200, body: 'plain' });
    });
});

describe('when the service does not answer', () => {
    it('times out as configured and says so as a 503', async () => {
        const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
        const started = Date.now();

        const error = await failureOf(client(fetch, { timeoutMs: 30 }).request({ path: '/slow', correlationId }));

        expect(Date.now() - started).toBeGreaterThanOrEqual(25);
        expect(Date.now() - started).toBeLessThan(900);
        expect(error.detail).toBe('The customers service did not answer in time.');
        expect(toProblem(error, correlationId)).toMatchObject({ status: 503, type: 'https://storefront.example/problems/service-unavailable' });
    });

    it('turns a network failure into a 503 that keeps the cause', async () => {
        const cause = new TypeError('fetch failed');

        const error = await failureOf(client(vi.fn().mockRejectedValue(cause)).request({ path: '/x', correlationId }));

        expect(error.detail).toBe('The customers service could not be reached.');
        expect(error.cause).toBe(cause);
    });

    it('turns a body that breaks off after the headers into a 503 that keeps the cause', async () => {
        const cause = new TypeError('terminated');
        const fetch = vi.fn().mockResolvedValue(new Response(brokenBody(cause), { status: 200 }));

        const error = await failureOf(client(fetch).request({ path: '/x', correlationId }));

        expect(error.detail).toBe('The customers service could not be reached.');
        expect(error.cause).toBe(cause);
        expect(toProblem(error, correlationId)).toMatchObject({ status: 503, type: 'https://storefront.example/problems/service-unavailable' });
    });

    it('times out as configured when the body is late after the headers', async () => {
        const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(lateBody(init.signal), { status: 200 }));
        const started = Date.now();

        const error = await failureOf(client(fetch, { timeoutMs: 30 }).request({ path: '/slow-body', correlationId }));

        expect(Date.now() - started).toBeGreaterThanOrEqual(25);
        expect(Date.now() - started).toBeLessThan(900);
        expect(error.detail).toBe('The customers service did not answer in time.');
    });

    it.each([500, 502, 503, 504])('turns a %i into a 503, and passes on Retry-After', async (status) => {
        const fetch = vi.fn().mockResolvedValue(new Response('oops', { status, headers: { 'retry-after': '30' } }));

        const error = await failureOf(client(fetch).request({ path: '/x', correlationId }));

        expect(error.detail).toBe('The customers service is not available.');
        expect(error.retryAfterSeconds).toBe(30);
    });
});

describe('Retry-After', () => {
    it.each([
        ['zero', '0'],
        ['text', 'soon'],
        ['a date, which is not read because the specs give seconds', 'Wed, 21 Oct 2026 07:28:00 GMT'],
        ['a fraction', '1.5'],
        ['a negative number', '-5']
    ])('is left out when it is %s', async (_name, value) => {
        const fetch = vi.fn().mockResolvedValue(new Response('', { status: 503, headers: { 'retry-after': value } }));

        const error = await failureOf(client(fetch).request({ path: '/x', correlationId }));

        expect(error.retryAfterSeconds).toBeUndefined();
    });

    it('is left out when the other service does not send it', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));

        expect((await failureOf(client(fetch).request({ path: '/x', correlationId }))).retryAfterSeconds).toBeUndefined();
    });
});

describe('retries', () => {
    it('does not retry a POST, even when retries are set and the answer is a 503', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));

        await failureOf(client(fetch, { retries: 3 }).request({ method: 'POST', path: '/v1/orders', correlationId, body: {} }));

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a PATCH, or a POST that timed out', async () => {
        const fetch = vi.fn().mockRejectedValue(new Error('network'));
        const http = client(fetch, { retries: 3 });

        await failureOf(http.request({ method: 'PATCH', path: '/x', correlationId, body: {} }));
        await failureOf(http.request({ method: 'POST', path: '/x', correlationId, body: {} }));

        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry by default', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));

        await failureOf(client(fetch).request({ path: '/x', correlationId }));

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('retries a GET up to the configured number of times, and returns the first good answer', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockRejectedValueOnce(new Error('network'))
            .mockResolvedValueOnce(json({ ok: true }));

        const result = await client(fetch, { retries: 2 }).request({ path: '/x', correlationId });

        expect(result.body).toEqual({ ok: true });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each(['HEAD', 'OPTIONS', 'PUT', 'DELETE'] as const)('retries a %s the same way', async (method) => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValueOnce(json({}));

        const result = await client(fetch, { retries: 1 }).request({ method, path: '/x', correlationId });

        expect(result.status).toBe(200);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('retries a GET whose body broke off, and does not retry a POST whose body broke off', async () => {
        const fetch = vi
            .fn()
            .mockImplementationOnce(async () => new Response(brokenBody(new TypeError('terminated')), { status: 200 }))
            .mockImplementationOnce(async () => json({ ok: true }));
        expect((await client(fetch, { retries: 1 }).request({ path: '/x', correlationId })).body).toEqual({ ok: true });
        expect(fetch).toHaveBeenCalledTimes(2);

        const post = vi.fn().mockImplementation(async () => new Response(brokenBody(new TypeError('terminated')), { status: 200 }));
        await failureOf(client(post, { retries: 3 }).request({ method: 'POST', path: '/x', correlationId, body: {} }));
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('gives up when the retries run out, and does not retry a 500', async () => {
        const unavailable = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
        await failureOf(client(unavailable, { retries: 1 }).request({ path: '/x', correlationId }));
        expect(unavailable).toHaveBeenCalledTimes(2);

        const broken = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
        await failureOf(client(broken, { retries: 1 }).request({ path: '/x', correlationId }));
        expect(broken).toHaveBeenCalledTimes(1);
    });
});

describe('the services key', () => {
    it('is read from the secret once for many calls', async () => {
        const read = vi.fn().mockResolvedValue('services-key');
        const getApiKey = createServiceKeyProvider({ secretId: 'storefront/services-key', read });
        const fetch = vi.fn().mockImplementation(async () => json({}));
        const http = client(fetch, { getApiKey });

        await Promise.all([http.request({ path: '/a', correlationId }), http.request({ path: '/b', correlationId })]);
        await http.request({ path: '/c', correlationId });

        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith('storefront/services-key');
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(fetch.mock.calls.every(([, init]) => (init as RequestInit).headers && (init as { headers: Record<string, string> }).headers['x-api-key'] === 'services-key')).toBe(true);
    });

    it('is read again after a read that failed', async () => {
        const read = vi.fn().mockRejectedValueOnce(new Error('throttled')).mockResolvedValueOnce('services-key');
        const getApiKey = createServiceKeyProvider({ secretId: 's', read });

        await expect(getApiKey()).rejects.toThrow('throttled');
        expect(await getApiKey()).toBe('services-key');
        expect(await getApiKey()).toBe('services-key');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('is the string value of the Secrets Manager secret', async () => {
        const send = vi.fn().mockResolvedValue({ SecretString: 'from-secrets-manager' });
        expect(await secretsManagerReader({ send })('storefront/services-key')).toBe('from-secrets-manager');
        expect((send.mock.calls[0] as [{ input: unknown }])[0].input).toEqual({ SecretId: 'storefront/services-key' });

        await expect(secretsManagerReader({ send: vi.fn().mockResolvedValue({}) })('empty')).rejects.toThrow('no string value');
    });
});
