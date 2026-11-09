import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Log } from '../specs/cli';

export const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'repo');

/** Throwaway copies of the fixture repo that a test can change. Call `cleanup` after each test. */
export function fixtureCopies(): {
    copy: () => Promise<string>;
    edited: (file: string, edit: (text: string) => string) => Promise<string>;
    cleanup: () => Promise<void>;
} {
    const dirs: string[] = [];
    const copy = async (): Promise<string> => {
        const dir = await mkdtemp(path.join(tmpdir(), 'specs-fixture-'));
        dirs.push(dir);
        await cp(fixtureRoot, dir, { recursive: true });
        return dir;
    };
    return {
        copy,
        async edited(file, edit) {
            const dir = await copy();
            const target = path.join(dir, file);
            await writeFile(target, edit(await readFile(target, 'utf8')));
            return dir;
        },
        async cleanup() {
            await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
        }
    };
}

/** A log that keeps what a command printed. */
export function capture(): { out: string[]; err: string[]; log: Log } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, log: { out: (m) => out.push(m), err: (m) => err.push(m) } };
}
