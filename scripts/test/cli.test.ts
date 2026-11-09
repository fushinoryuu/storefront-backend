import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBundleSpecs, runLintSpecs } from '../specs/cli';
import { capture, fixtureCopies, fixtureRoot } from './support';

const fx = fixtureCopies();

afterEach(() => fx.cleanup());

describe('runBundleSpecs', () => {
    it('writes the bundles, and then --check passes', async () => {
        const dir = await fx.copy();
        const write = capture();
        expect(await runBundleSpecs(dir, [], write.log)).toBe(0);
        expect(write.out).toEqual(['Wrote 3 bundle(s) to specs/.']);

        const check = capture();
        expect(await runBundleSpecs(dir, ['--check'], check.log)).toBe(0);
        expect(check.out).toEqual(['Bundled specs are current.']);
        expect(check.err).toEqual([]);
    });

    it('fails --check when the bundles are missing', async () => {
        const check = capture();
        expect(await runBundleSpecs(await fx.copy(), ['--check'], check.log)).toBe(1);
        expect(check.err.join('\n')).toContain('specs/demo-service-v1.yaml is missing.');
        expect(check.err.at(-1)).toBe('Run `npm run bundle:specs` and commit the result.');
    });

    it('fails --check when a source changed after the bundles were written', async () => {
        const dir = await fx.copy();
        await runBundleSpecs(dir, [], capture().log);
        const { writeFile, readFile } = await import('node:fs/promises');
        const source = path.join(dir, 'services/demo/openapi.yaml');
        await writeFile(source, (await readFile(source, 'utf8')).replace('Get a thing', 'Fetch a thing'));

        const check = capture();
        expect(await runBundleSpecs(dir, ['--check'], check.log)).toBe(1);
        expect(check.err.join('\n')).toContain('specs/demo-service-v1.yaml is stale.');
    });

    it('succeeds in a repo without specs', async () => {
        const check = capture();
        expect(await runBundleSpecs(path.join(fixtureRoot, 'specs'), ['--check'], check.log)).toBe(0);
    });

    it('prints the message, not a stack, and fails when a source cannot be bundled', async () => {
        const dir = await fx.edited('services/demo/openapi.yaml', (text) => text.replace('/v1/things:', '/things:'));
        const run = capture();
        expect(await runBundleSpecs(dir, [], run.log)).toBe(1);
        expect(run.err).toEqual(['services/demo/openapi.yaml: all paths need one /v<N> prefix to name the bundle.']);
    });
});

describe('runLintSpecs', () => {
    it('passes the valid fixture repo', async () => {
        const run = capture();
        expect(await runLintSpecs(fixtureRoot, run.log)).toBe(0);
        expect(run.out).toEqual(['Linted 3 spec(s).']);
    });

    it('fails when a spec has an error', async () => {
        const dir = await fx.edited('services/demo/openapi.yaml', (text) => text.replace('      summary: Get a thing\n', ''));
        const run = capture();
        expect(await runLintSpecs(dir, run.log)).toBe(1);
        expect(run.out.join('\n')).toContain('operation-summary');
    });

    it('prints a warning but still passes', async () => {
        const dir = await fx.edited('services/demo/openapi.yaml', (text) => `${text}    Pet:\n      oneOf:\n        - type: string\n        - type: integer\n`);
        const run = capture();
        expect(await runLintSpecs(dir, run.log)).toBe(0);
        expect(run.out.join('\n')).toContain('warn discriminator');
    });

    it('succeeds and says so when there are no specs', async () => {
        const run = capture();
        expect(await runLintSpecs(path.join(fixtureRoot, 'specs'), run.log)).toBe(0);
        expect(run.out).toEqual(['No specs found under services/*/openapi*.yaml.']);
    });
});
