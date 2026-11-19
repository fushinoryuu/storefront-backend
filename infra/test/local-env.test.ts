import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLocalEnv, localEnvFile } from '../lib/config/local-env';

const name = 'LOCAL_ENV_TEST_VALUE';
let dir: string;
let file: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'local-env-'));
    file = path.join(dir, '.env');
});

afterEach(async () => {
    delete process.env[name];
    await rm(dir, { recursive: true, force: true });
});

describe('loadLocalEnv', () => {
    it('sets the variables of the file', async () => {
        await writeFile(file, `${name}=from-file\n`);
        loadLocalEnv(file);

        expect(process.env[name]).toBe('from-file');
    });

    it('keeps a variable that is already set, so the shell or a workflow wins', async () => {
        process.env[name] = 'from-shell';
        await writeFile(file, `${name}=from-file\n`);
        loadLocalEnv(file);

        expect(process.env[name]).toBe('from-shell');
    });

    it('does nothing, and prints nothing, when there is no file', () => {
        expect(() => loadLocalEnv(path.join(dir, 'missing.env'))).not.toThrow();
        expect(process.env[name]).toBeUndefined();
    });

    it('reads the .env file at the repo root, which git ignores', () => {
        expect(localEnvFile).toBe(path.resolve(import.meta.dirname, '..', '..', '.env'));
    });
});
