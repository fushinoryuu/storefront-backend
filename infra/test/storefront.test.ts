import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const entrypoint = fileURLToPath(new URL('../bin/storefront.ts', import.meta.url));

function runEntrypoint(context?: Record<string, string>) {
    const env = { ...process.env, CDK_CONTEXT_JSON: context ? JSON.stringify(context) : undefined };
    return spawnSync(process.execPath, ['--import', 'tsx', entrypoint], {
        cwd: repoRoot,
        env,
        encoding: 'utf8'
    });
}

describe('infra/bin/storefront.ts', () => {
    it('exits 1 with a one-line message for an unknown stage', () => {
        const result = runEntrypoint({ stage: 'staging' });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Unknown stage .*Pass one of: dev, prod/);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
    }, 30_000);

    it('builds without a stage', () => {
        expect(runEntrypoint().status).toBe(0);
    }, 30_000);
});
