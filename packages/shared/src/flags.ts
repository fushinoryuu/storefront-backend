import { basicLogger, init, type LDClient, type LDOptions } from '@launchdarkly/node-server-sdk';

// The feature flag client (decision 0011). A service never depends on LaunchDarkly being reachable: every flag has a default here, and it is the answer whenever LaunchDarkly cannot give one.

export interface FlagDefinition {
    /** The value used when LaunchDarkly cannot answer. Choose the safe one: a simulation is off. */
    readonly default: boolean;
    readonly description: string;
}

/** Every flag the code knows, by its LaunchDarkly key. A flag is on or off and nothing more, so it has no targeting rules. */
export const flags = {
    'shipment-simulation': { default: false, description: 'Lets the admin route advanceShipment move a shipment to its next state. When off, the route answers 404.' },
    'customers-unavailable-simulation': { default: false, description: 'Makes the orders service treat its call to the customers service as failing, so a test can see the 503.' }
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof flags;

/** Why a flag was answered with its default, for the service to log. */
export interface FlagFallback {
    flag: FlagKey;
    /** `sdk-key`: the SDK key could not be read in time. `not-ready`: the SDK was not ready in time, or gave up. `error`: the evaluation failed. */
    reason: 'sdk-key' | 'not-ready' | 'error';
    error: unknown;
}

export interface FlagClientOptions {
    /** The name of the service. It is the one context every evaluation uses, and the app id on LaunchDarkly's service connections page. */
    service: string;
    /** Gives the SDK key of this stage's LaunchDarkly environment. See `createSecretProvider`. */
    getSdkKey: () => Promise<string>;
    /** How long to wait for the SDK key and for the SDK to connect, in milliseconds, before a flag is answered with its default. */
    timeoutMs: number;
    /** Called each time a flag is answered with its default because LaunchDarkly could not answer. A throw from it is ignored. */
    onFallback?: (fallback: FlagFallback) => void;
    /** Extra SDK options, for tests. */
    sdkOptions?: LDOptions;
}

export interface FlagClient {
    /** Resolves with the flag's value, or its default. It never rejects for a flag in the registry. */
    isEnabled(flag: FlagKey): Promise<boolean>;
    /** Closes the SDK. Only tests need it. */
    close(): void;
}

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`LaunchDarkly was not ready within ${timeoutMs} ms.`)), timeoutMs);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Create the flag client of a service once per execution environment, outside the handler. The SDK starts on the first evaluation and is reused after that, so a Lambda
 * instance holds one connection. An SDK that is not ready in time keeps connecting, and the next evaluation uses it when it is.
 */
export function createFlagClient({ service, getSdkKey, timeoutMs, onFallback, sdkOptions }: FlagClientOptions): FlagClient {
    if (!(timeoutMs > 0)) throw new RangeError('timeoutMs must be greater than 0.');
    const context = { kind: 'service', key: service };
    let started: Promise<LDClient> | undefined;

    // A failed start is not kept, so the next evaluation tries again.
    const start = (): Promise<LDClient> =>
        (started ??= getSdkKey()
            .then((sdkKey) => init(sdkKey, { logger: basicLogger({ level: 'warn' }), application: { id: service }, sendEvents: false, ...sdkOptions }))
            .catch((error: unknown) => {
                started = undefined;
                throw error;
            }));

    return {
        async isEnabled(flag) {
            if (!Object.hasOwn(flags, flag)) throw new Error(`The feature flag ${String(flag)} is not in the registry.`);
            const { default: fallback } = flags[flag];
            const useDefault = (reason: FlagFallback['reason'], error: unknown) => {
                try {
                    onFallback?.({ flag, reason, error });
                } catch {
                    // The service's logging must not change the answer.
                }
                return fallback;
            };

            // The time for the key and for the connection together is timeoutMs.
            const deadline = Date.now() + timeoutMs;
            let client: LDClient;
            try {
                client = await within(start(), timeoutMs);
            } catch (error) {
                return useDefault('sdk-key', error);
            }
            try {
                await client.waitForInitialization({ timeout: Math.max(deadline - Date.now(), 1) / 1000 });
            } catch (error) {
                return useDefault('not-ready', error);
            }
            try {
                return await client.boolVariation(flag, context, fallback);
            } catch (error) {
                return useDefault('error', error);
            }
        },
        close() {
            void started?.then(
                (sdk) => sdk.close(),
                () => undefined
            );
            started = undefined;
        }
    };
}
