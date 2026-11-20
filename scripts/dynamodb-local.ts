import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The compose file that defines DynamoDB Local: the one place that names its image and version. The CI workflow reads it too. */
export const composeFile = fileURLToPath(new URL('../docker-compose.yaml', import.meta.url));

const service = 'dynamodb';
const containerPort = 8000;

/** The arguments of one `docker compose` command for the compose file of the repo, whatever directory the tests run from. */
const compose = (...args: string[]): string[] => ['compose', '--file', composeFile, ...args];

/** Runs one `docker` command and gives what it printed. It rejects when the command fails. */
export type Docker = (args: readonly string[]) => Promise<string>;

export const docker: Docker = async (args) => {
    const { stdout } = await execFileAsync('docker', [...args], { timeout: 300_000 });
    return stdout.trim();
};

/** The same as `Docker`, for a process that is about to exit and cannot wait for a promise. It throws when the command fails. */
export type DockerSync = (args: readonly string[]) => void;

export const dockerSync: DockerSync = (args) => {
    execFileSync('docker', [...args], { stdio: 'ignore', timeout: 30_000 });
};

/** The host port that Docker published for the container, from the output of `docker compose port`, for example `127.0.0.1:8000`. */
export function parsePublishedPort(output: string): number {
    const match = /:(\d+)\s*$/m.exec(output);
    if (match?.[1] === undefined) throw new Error(`Could not read the published port from the output of docker compose port: "${output}".`);
    return Number(match[1]);
}

function firstLine(error: unknown): string {
    const text = error instanceof Error ? ((error as { stderr?: unknown }).stderr ?? error.message) : error;
    return String(text).trim().split('\n')[0] ?? '';
}

/** Why there is no container runtime to use, or `undefined` when `docker compose` answers. */
async function whyUnavailable(run: Docker): Promise<string | undefined> {
    try {
        await run(['info', '--format', '{{.ServerVersion}}']);
    } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return 'docker is not installed';
        return `docker could not reach its daemon (${firstLine(error)})`;
    }
    try {
        await run(['compose', 'version']);
    } catch {
        return 'docker compose is not available';
    }
    return undefined;
}

export interface Running {
    readonly endpoint: string;
    /** Stops what this run started, which removes the container. It does nothing for a container that was already running, and it is safe to call more than once. */
    stop(): Promise<void>;
    /** The same, without waiting on a promise, for the `exit` event. */
    stopNow(): void;
}

export type Started = { readonly kind: 'started'; readonly running: Running } | { readonly kind: 'unavailable'; readonly reason: string };

export interface StartOptions {
    readonly run?: Docker;
    readonly runSync?: DockerSync;
    readonly info?: (message: string) => void;
}

/**
 * Starts DynamoDB Local with `docker compose up --wait`, which pulls the image on the first run and waits for the healthcheck of the compose file.
 * A container that is already running (someone ran `docker compose up`) is used and left running.
 * It gives `unavailable` when there is no container runtime. Any other failure rejects, and what was started is stopped first.
 */
export async function startDynamoDbLocal({ run = docker, runSync = dockerSync, info = (message) => console.info(message) }: StartOptions = {}): Promise<Started> {
    const reason = await whyUnavailable(run);
    if (reason !== undefined) return { kind: 'unavailable', reason };

    const endpointOf = async () => `http://127.0.0.1:${parsePublishedPort(await run(compose('port', service, String(containerPort))))}`;
    if ((await run(compose('ps', '--status', 'running', '--quiet', service))) !== '') {
        return { kind: 'started', running: { endpoint: await endpointOf(), stop: async () => undefined, stopNow: () => undefined } };
    }

    const downArgs = compose('down', '--timeout', '2');
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        await run(downArgs).catch(() => undefined);
    };
    const stopNow = () => {
        if (stopped) return;
        stopped = true;
        try {
            runSync(downArgs);
        } catch {
            // The container may be gone already. There is nobody left to tell.
        }
    };

    info('Starting DynamoDB Local with docker compose (the first run pulls the image)...');
    try {
        await run(compose('up', '--detach', '--wait', service));
        return { kind: 'started', running: { endpoint: await endpointOf(), stop, stopNow } };
    } catch (error) {
        const logs = await run(compose('logs', service)).catch(() => '(no logs)');
        await stop();
        throw new Error(`DynamoDB Local did not start: ${firstLine(error)}\nIts logs:\n${logs}`, { cause: error });
    }
}

export interface SetupDeps extends StartOptions {
    readonly env: NodeJS.ProcessEnv;
    readonly warn: (message: string) => void;
    /** Registers what runs when the process exits. */
    readonly onExit?: (handler: () => void) => void;
}

/**
 * What the vitest global setup does. With `DYNAMODB_ENDPOINT` set it starts nothing, and the tests use that endpoint.
 * Without it, it starts the container and sets the variable for the test workers, and gives back the function that stops the container.
 * vitest exits at once on Ctrl+C without calling that function, so the container is also stopped when the process exits.
 * With no container runtime the tests are skipped with a warning, and with `CI=true` the setup fails, because a skipped test is a check nobody sees.
 */
export async function setupDynamoDbLocal({ env, warn, onExit = (handler) => process.once('exit', handler), ...options }: SetupDeps): Promise<(() => Promise<void>) | undefined> {
    if (env['DYNAMODB_ENDPOINT'] !== undefined && env['DYNAMODB_ENDPOINT'] !== '') return undefined;

    const started = await startDynamoDbLocal(options);
    if (started.kind === 'unavailable') {
        const how = 'To run them, install a container runtime with docker compose (Docker Desktop, OrbStack or Colima) and start it, and `npm test` starts DynamoDB Local itself. To start it by hand, run `docker compose up --detach --wait`, then `DYNAMODB_ENDPOINT=http://localhost:8000 npm test`.';
        if (env['CI'] === 'true') throw new Error(`The DynamoDB Local tests need a container runtime, and ${started.reason}. ${how}`);
        warn(`The DynamoDB Local tests are skipped: ${started.reason}. ${how}`);
        return undefined;
    }

    env['DYNAMODB_ENDPOINT'] = started.running.endpoint;
    onExit(() => started.running.stopNow());
    return async () => {
        await started.running.stop();
    };
}
