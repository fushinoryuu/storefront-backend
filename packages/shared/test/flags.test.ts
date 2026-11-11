import { createServer, type RequestListener } from 'node:http';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { TestData, init } from '@launchdarkly/node-server-sdk';
import { createFlagClient, flags, type FlagClientOptions, type FlagFallback, type FlagKey } from '../src/index';

// Only the SDK's test data source and a server on this machine are used, so these tests never reach LaunchDarkly. The wrapper counts how often the SDK is started.
vi.mock('@launchdarkly/node-server-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@launchdarkly/node-server-sdk')>();
    return { ...actual, init: vi.fn(actual.init) };
});

const sdkKey = 'sdk-0000-fake-key-for-tests';

const clients: Array<{ close(): void }> = [];
const servers: Array<{ close(): void }> = [];

function newClient(options: Partial<FlagClientOptions> = {}) {
    const client = createFlagClient({ service: 'shipping', getSdkKey: async () => sdkKey, timeoutMs: 1000, ...options });
    clients.push(client);
    return client;
}

/** A flag source with the given flags on, in place of LaunchDarkly. */
function source(on: Partial<Record<FlagKey, boolean>>) {
    const data = new TestData();
    for (const [key, value] of Object.entries(on)) void data.update(data.flag(key).booleanFlag().variationForAll(value));
    return { data, sdkOptions: { updateProcessor: data.getFactory() } };
}

/** A server on this machine that stands in for LaunchDarkly. */
async function listen(handler: RequestListener) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No port.');
    servers.push({
        close: () => {
            server.closeAllConnections();
            server.close();
        }
    });
    const url = `http://127.0.0.1:${address.port}`;
    return { sdkOptions: { baseUri: url, streamUri: url, eventsUri: url } };
}

let output: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
    vi.mocked(init).mockClear();
    output = [vi.spyOn(console, 'error').mockImplementation(() => undefined), vi.spyOn(console, 'warn').mockImplementation(() => undefined), vi.spyOn(console, 'log').mockImplementation(() => undefined)];
});

afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) server.close();
    vi.restoreAllMocks();
});

describe('the registry', () => {
    it('gives every flag a lower case key, a default and a description', () => {
        for (const [key, flag] of Object.entries(flags)) {
            expect(key).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
            expect(typeof flag.default).toBe('boolean');
            expect(flag.description.length).toBeGreaterThan(0);
        }
    });

    it('turns every simulation off by default', () => {
        expect(Object.values(flags).every((flag) => flag.default === false)).toBe(true);
    });
});

describe('isEnabled', () => {
    it('only accepts a key from the registry', async () => {
        const client = newClient(source({}));

        expectTypeOf(client.isEnabled).parameter(0).toEqualTypeOf<FlagKey>();
        // @ts-expect-error The key is not in the registry, so this does not compile.
        await expect(client.isEnabled('no-such-flag')).rejects.toThrow('not in the registry');
        await expect(client.isEnabled('toString' as FlagKey)).rejects.toThrow('not in the registry');
    });

    it('returns the value from the data source, and follows a change', async () => {
        const { data, sdkOptions } = source({ 'shipment-simulation': true, 'customers-unavailable-simulation': false });
        const client = newClient({ sdkOptions });

        expect(await client.isEnabled('shipment-simulation')).toBe(true);
        expect(await client.isEnabled('customers-unavailable-simulation')).toBe(false);

        await data.update(data.flag('shipment-simulation').booleanFlag().variationForAll(false));
        expect(await client.isEnabled('shipment-simulation')).toBe(false);
    });

    it('uses one SDK instance for every call, also for calls that start together', async () => {
        const getSdkKey = vi.fn(async () => sdkKey);
        const client = newClient({ getSdkKey, ...source({ 'shipment-simulation': true }) });

        const answers = await Promise.all(Array.from({ length: 10 }, () => client.isEnabled('shipment-simulation')));
        await client.isEnabled('customers-unavailable-simulation');

        expect(answers.every(Boolean)).toBe(true);
        expect(init).toHaveBeenCalledTimes(1);
        expect(getSdkKey).toHaveBeenCalledTimes(1);
        expect(init).toHaveBeenCalledWith(sdkKey, expect.objectContaining({ sendEvents: false, application: { id: 'shipping' } }));
    });

    it('does not start the SDK before the first evaluation', () => {
        newClient(source({}));
        expect(init).not.toHaveBeenCalled();
    });
});

describe('when LaunchDarkly cannot answer', () => {
    it('gives the default when the SDK is not ready within the timeout, and says why', async () => {
        const fallbacks: FlagFallback[] = [];
        const client = newClient({ ...(await listen(() => undefined)), timeoutMs: 200, onFallback: (fallback) => fallbacks.push(fallback) });

        const started = Date.now();
        expect(await client.isEnabled('shipment-simulation')).toBe(flags['shipment-simulation'].default);

        expect(Date.now() - started).toBeLessThan(1500);
        expect(fallbacks).toEqual([{ flag: 'shipment-simulation', reason: 'not-ready', error: expect.any(Error) }]);
    });

    it('gives the default when LaunchDarkly refuses the key, and never writes the key to the console', async () => {
        const fallbacks: FlagFallback[] = [];
        const client = newClient({ ...(await listen((_request, response) => response.writeHead(401).end())), onFallback: (fallback) => fallbacks.push(fallback) });

        expect(await client.isEnabled('shipment-simulation')).toBe(false);
        expect(await client.isEnabled('shipment-simulation')).toBe(false);

        expect(fallbacks.map((fallback) => fallback.reason)).toEqual(['not-ready', 'not-ready']);
        expect(JSON.stringify(output.map((spy) => spy.mock.calls))).not.toContain(sdkKey);
    });

    it('gives the default when the key cannot be read, and reads it again on the next call', async () => {
        const getSdkKey = vi.fn<FlagClientOptions['getSdkKey']>().mockRejectedValueOnce(new Error('Secrets Manager is down')).mockResolvedValue(sdkKey);
        const fallbacks: FlagFallback[] = [];
        const client = newClient({ getSdkKey, ...source({ 'shipment-simulation': true }), onFallback: (fallback) => fallbacks.push(fallback) });

        expect(await client.isEnabled('shipment-simulation')).toBe(false);
        expect(fallbacks).toEqual([{ flag: 'shipment-simulation', reason: 'sdk-key', error: new Error('Secrets Manager is down') }]);
        expect(await client.isEnabled('shipment-simulation')).toBe(true);
        expect(init).toHaveBeenCalledTimes(1);
    });

    it('gives the default when reading the key takes longer than the timeout', async () => {
        const fallbacks: FlagFallback[] = [];
        const client = newClient({ getSdkKey: () => new Promise<string>(() => undefined), timeoutMs: 50, onFallback: (fallback) => fallbacks.push(fallback) });

        expect(await client.isEnabled('shipment-simulation')).toBe(false);
        expect(fallbacks.map((fallback) => fallback.reason)).toEqual(['sdk-key']);
        expect(init).not.toHaveBeenCalled();
    });

    it('is not changed by a callback that throws', async () => {
        const client = newClient({
            getSdkKey: () => Promise.reject(new Error('down')),
            onFallback: () => {
                throw new Error('log failed');
            }
        });

        expect(await client.isEnabled('shipment-simulation')).toBe(false);
    });

    it('needs a timeout above zero', () => {
        expect(() => createFlagClient({ service: 'shipping', getSdkKey: async () => sdkKey, timeoutMs: 0 })).toThrow(RangeError);
    });
});
