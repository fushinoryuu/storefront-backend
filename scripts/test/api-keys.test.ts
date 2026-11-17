import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keysDirectory, runGetApiKeys } from '../api-keys/cli';
import type { KeySource } from '../api-keys/cli';
import { capture } from './support';

const secrets = { tests: 'tests-value-1234', services: 'services-value-5678', admin: 'admin-value-9012' };

/** Parameters hold key ids (`id-<kind>`), and each id maps to a value. */
function fakeSource(missing?: string): KeySource {
    return {
        async parameter(name) {
            if (name === missing) throw new Error(`Parameter ${name} not found.`);
            const kind = /\/(\w+)-api-key-id$/.exec(name)?.[1];
            return `id-${kind}`;
        },
        async keyValue(id) {
            return secrets[id.replace('id-', '') as keyof typeof secrets];
        }
    };
}

let root: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'api-keys-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('runGetApiKeys', () => {
    it('writes the three values to a file only the owner can read, and prints no value', async () => {
        const run = capture();
        expect(await runGetApiKeys(root, ['--stage', 'dev'], fakeSource(), run.log)).toBe(0);

        const file = path.join(root, keysDirectory, 'dev.json');
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(secrets);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(run.out).toEqual(['Wrote the tests, services, admin API keys of dev to .api-keys/dev.json.']);
        expect([...run.out, ...run.err].join('\n')).not.toMatch(/value-\d{4}/);
    });

    it('reads the ids from the parameters of the stage that was named', async () => {
        const names: string[] = [];
        const source: KeySource = { ...fakeSource(), parameter: (name) => (names.push(name), Promise.resolve('id-tests')) };
        await runGetApiKeys(root, ['--stage', 'prod'], source, capture().log);

        expect(names).toEqual(['/storefront/prod/platform/tests-api-key-id', '/storefront/prod/platform/services-api-key-id', '/storefront/prod/platform/admin-api-key-id']);
    });

    it('asks for a stage when none is given', async () => {
        const run = capture();
        expect(await runGetApiKeys(root, [], fakeSource(), run.log)).toBe(1);
        expect(run.err).toEqual(['Pass the stage: --stage dev or --stage prod.']);
    });

    it('rejects a stage that does not exist, and writes nothing', async () => {
        const run = capture();
        expect(await runGetApiKeys(root, ['--stage', 'staging'], fakeSource(), run.log)).toBe(1);
        expect(run.err.join('\n')).toMatch(/Unknown stage "staging"/);
        await expect(stat(path.join(root, keysDirectory))).rejects.toThrow();
    });

    it('fails with a hint, and writes nothing, when a parameter is missing', async () => {
        const run = capture();
        const missing = '/storefront/dev/platform/admin-api-key-id';
        expect(await runGetApiKeys(root, ['--stage', 'dev'], fakeSource(missing), run.log)).toBe(1);
        expect(run.err.join('\n')).toMatch(/Is the Platform stack of dev deployed/);
        await expect(stat(path.join(root, keysDirectory))).rejects.toThrow();
    });
});

describe('the key folder', () => {
    it('is ignored by git, so a key value cannot be committed by accident', () => {
        const repoRoot = path.resolve(import.meta.dirname, '..', '..');
        expect(execFileSync('git', ['check-ignore', `${keysDirectory}/dev.json`], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe(`${keysDirectory}/dev.json`);
    });
});
