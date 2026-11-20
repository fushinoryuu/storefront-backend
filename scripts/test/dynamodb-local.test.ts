import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { composeFile, parsePublishedPort, setupDynamoDbLocal, startDynamoDbLocal, type Docker, type DockerSync } from '../dynamodb-local';

interface FakeOptions {
    /** What `docker info` does: answers, or fails with this error. */
    info?: Error;
    /** `docker compose` is not installed. */
    noCompose?: boolean;
    /** The container is already running, because someone ran `docker compose up`. */
    alreadyRunning?: boolean;
    /** `docker compose up` fails with this error. */
    up?: Error;
    port?: string;
}

/** A docker that records the commands it was given and answers like the real one would. */
function fakeDocker({ info, noCompose = false, alreadyRunning = false, up, port = '127.0.0.1:8000' }: FakeOptions = {}) {
    const calls: string[][] = [];
    const run: Docker = async (args) => {
        calls.push([...args]);
        if (args[0] === 'info') {
            if (info !== undefined) throw info;
            return '29.0.0';
        }
        if (args[1] === 'version') {
            if (noCompose) throw new Error("docker: 'compose' is not a docker command");
            return 'v5.0.0';
        }
        // Every other command is `docker compose --file <file> <command> ...`.
        switch (args[3]) {
            case 'ps':
                return alreadyRunning ? 'container-id' : '';
            case 'up':
                if (up !== undefined) throw up;
                return '';
            case 'port':
                return port;
            case 'logs':
                return 'the logs of the container';
            default:
                return '';
        }
    };
    const syncCalls: string[][] = [];
    const runSync: DockerSync = (args) => {
        syncCalls.push([...args]);
    };
    /** The compose commands that ran, without `compose --file <file>`. */
    const composed = () => calls.filter((call) => call[0] === 'compose' && call[1] === '--file').map((call) => call.slice(3));
    return { run, runSync, calls, syncCalls, composed };
}

const options = (docker: ReturnType<typeof fakeDocker>) => ({ run: docker.run, runSync: docker.runSync, info: vi.fn() });
const down = ['down', '--timeout', '2'];
const missing = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
const daemonDown = Object.assign(new Error('Command failed'), { stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\nIs it running?' });

describe('the compose file of DynamoDB Local', () => {
    const compose = readFileSync(composeFile, 'utf8');

    it('names the image with its version, once, and the CI workflow reads it from there', () => {
        expect(compose.match(/image:\s*amazon\/dynamodb-local:\d+\.\d+\.\d+/g)).toHaveLength(1);
        const workflow = readFileSync(new URL('../../.github/workflows/ci.yaml', import.meta.url), 'utf8');
        expect(workflow).toContain('docker compose config --images');
        expect(workflow).not.toMatch(/dynamodb-local:\d/);
    });

    it('has the healthcheck that `docker compose up --wait` waits for, and only this machine can reach the port', () => {
        expect(compose).toMatch(/healthcheck:/);
        expect(compose).toMatch(/127\.0\.0\.1:\d+:8000/);
    });
});

describe('parsePublishedPort', () => {
    it('reads the port from one line or from the two lines Docker prints for IPv4 and IPv6', () => {
        expect(parsePublishedPort('127.0.0.1:8000')).toBe(8000);
        expect(parsePublishedPort('0.0.0.0:32768\n[::]:32768')).toBe(32768);
    });

    it('fails on output that has no port', () => {
        expect(() => parsePublishedPort('')).toThrow('published port');
        expect(() => parsePublishedPort('no such container')).toThrow('published port');
    });
});

describe('startDynamoDbLocal', () => {
    it('starts the container with docker compose, waits for its healthcheck, and reads the endpoint from the published port', async () => {
        const docker = fakeDocker();
        const started = await startDynamoDbLocal(options(docker));
        expect(started.kind).toBe('started');
        if (started.kind !== 'started') return;
        expect(started.running.endpoint).toBe('http://127.0.0.1:8000');
        expect(docker.composed()).toEqual([
            ['ps', '--status', 'running', '--quiet', 'dynamodb'],
            ['up', '--detach', '--wait', 'dynamodb'],
            ['port', 'dynamodb', '8000']
        ]);
        expect(docker.calls.find((call) => call[2] === composeFile)).toBeDefined();

        await started.running.stop();
        expect(docker.composed().at(-1)).toEqual(down);
    });

    it('stops it only once, whichever of the two ways of stopping comes first', async () => {
        const docker = fakeDocker();
        const started = await startDynamoDbLocal(options(docker));
        if (started.kind !== 'started') throw new Error('not started');
        started.running.stopNow();
        started.running.stopNow();
        await started.running.stop();
        expect(docker.syncCalls).toHaveLength(1);
        expect(docker.syncCalls[0]?.slice(3)).toEqual(down);
        expect(docker.composed().filter((args) => args[0] === 'down')).toEqual([]);
    });

    it('uses a container that is already running and leaves it running', async () => {
        const docker = fakeDocker({ alreadyRunning: true });
        const started = await startDynamoDbLocal(options(docker));
        if (started.kind !== 'started') throw new Error('not started');
        expect(started.running.endpoint).toBe('http://127.0.0.1:8000');
        await started.running.stop();
        started.running.stopNow();
        expect(docker.composed().map((args) => args[0])).toEqual(['ps', 'port']);
        expect(docker.syncCalls).toEqual([]);
    });

    it('is unavailable when docker is not installed, and starts nothing', async () => {
        const docker = fakeDocker({ info: missing });
        expect(await startDynamoDbLocal(options(docker))).toEqual({ kind: 'unavailable', reason: 'docker is not installed' });
        expect(docker.composed()).toEqual([]);
    });

    it('is unavailable when the daemon is not running, and says why', async () => {
        const started = await startDynamoDbLocal(options(fakeDocker({ info: daemonDown })));
        expect(started).toEqual({ kind: 'unavailable', reason: 'docker could not reach its daemon (Cannot connect to the Docker daemon at unix:///var/run/docker.sock)' });
    });

    it('is unavailable when docker has no compose', async () => {
        expect(await startDynamoDbLocal(options(fakeDocker({ noCompose: true })))).toEqual({ kind: 'unavailable', reason: 'docker compose is not available' });
    });

    it('shows the logs and takes everything down when the container does not start', async () => {
        const docker = fakeDocker({ up: Object.assign(new Error('Command failed'), { stderr: 'container storefront-dynamodb is unhealthy' }) });
        await expect(startDynamoDbLocal(options(docker))).rejects.toThrow('container storefront-dynamodb is unhealthy');
        await expect(startDynamoDbLocal(options(docker))).rejects.toThrow('the logs of the container');
        expect(docker.composed().at(-1)).toEqual(down);
    });

    it('takes everything down when it cannot read the port', async () => {
        const docker = fakeDocker({ port: '' });
        await expect(startDynamoDbLocal(options(docker))).rejects.toThrow('published port');
        expect(docker.composed().at(-1)).toEqual(down);
    });
});

describe('setupDynamoDbLocal', () => {
    it('starts nothing and leaves the variable alone when DYNAMODB_ENDPOINT is set', async () => {
        const docker = fakeDocker();
        const env: NodeJS.ProcessEnv = { DYNAMODB_ENDPOINT: 'http://localhost:9000' };
        expect(await setupDynamoDbLocal({ ...options(docker), env, warn: vi.fn() })).toBeUndefined();
        expect(docker.calls).toEqual([]);
        expect(env['DYNAMODB_ENDPOINT']).toBe('http://localhost:9000');
    });

    it('starts the container, sets the variable for the tests and gives back the function that stops it', async () => {
        const docker = fakeDocker();
        const env: NodeJS.ProcessEnv = {};
        const stop = await setupDynamoDbLocal({ ...options(docker), env, warn: vi.fn(), onExit: vi.fn() });
        expect(env['DYNAMODB_ENDPOINT']).toBe('http://127.0.0.1:8000');
        expect(docker.composed().map((args) => args[0])).not.toContain('down');
        await stop?.();
        expect(docker.composed().at(-1)).toEqual(down);
    });

    it('also stops the container when the process exits, which is all that happens on Ctrl+C, and only once', async () => {
        const docker = fakeDocker();
        let onExit: (() => void) | undefined;
        const stop = await setupDynamoDbLocal({
            ...options(docker),
            env: {},
            warn: vi.fn(),
            onExit: (handler) => {
                onExit = handler;
            }
        });
        expect(onExit).toBeDefined();
        expect(docker.syncCalls).toEqual([]);
        onExit?.();
        expect(docker.syncCalls).toHaveLength(1);

        // The run ended normally as well: the second stop does nothing.
        onExit?.();
        await stop?.();
        expect(docker.syncCalls).toHaveLength(1);
        expect(docker.composed().map((args) => args[0])).not.toContain('down');
    });

    it('treats an empty DYNAMODB_ENDPOINT as not set', async () => {
        const env: NodeJS.ProcessEnv = { DYNAMODB_ENDPOINT: '' };
        await setupDynamoDbLocal({ ...options(fakeDocker()), env, warn: vi.fn(), onExit: vi.fn() });
        expect(env['DYNAMODB_ENDPOINT']).toBe('http://127.0.0.1:8000');
    });

    it('skips the tests with a message that says what to install and how to start the container by hand, when there is no container runtime', async () => {
        const warn = vi.fn();
        const env: NodeJS.ProcessEnv = {};
        expect(await setupDynamoDbLocal({ ...options(fakeDocker({ info: missing })), env, warn })).toBeUndefined();
        expect(env['DYNAMODB_ENDPOINT']).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toContain('skipped');
        expect(message).toContain('docker is not installed');
        expect(message).toContain('install a container runtime');
        expect(message).toContain('docker compose up --detach --wait');
        expect(message).toContain('DYNAMODB_ENDPOINT=http://localhost:8000 npm test');
    });

    it('fails, and does not skip, in CI when there is no container runtime', async () => {
        const warn = vi.fn();
        await expect(setupDynamoDbLocal({ ...options(fakeDocker({ info: missing })), env: { CI: 'true' }, warn })).rejects.toThrow('docker is not installed');
        expect(warn).not.toHaveBeenCalled();
    });

    it('uses the endpoint in CI when it is set, and starts nothing', async () => {
        const docker = fakeDocker({ info: missing });
        await setupDynamoDbLocal({ ...options(docker), env: { CI: 'true', DYNAMODB_ENDPOINT: 'http://localhost:8000' }, warn: vi.fn() });
        expect(docker.calls).toEqual([]);
    });
});
