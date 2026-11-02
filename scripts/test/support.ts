import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'repo');

/** A throwaway copy of the fixture repo that a test can change. */
export async function copyFixture(): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'specs-fixture-'));
  await cp(fixtureRoot, dir, { recursive: true });
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}
