import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { localBuildId, readGitState, resolveBuildId } from '../lib/config/build-id';

const clean = () => ({ commit: 'abc1234', dirty: false });
const dirty = () => ({ commit: 'abc1234', dirty: true });
const noGit = () => undefined;

describe('resolveBuildId', () => {
    it('uses the BUILD_ID variable before the git commit', () => {
        expect(resolveBuildId({ BUILD_ID: 'run-42' }, clean)).toBe('run-42');
    });

    it('uses the variable as it is, also when the working tree has changes', () => {
        expect(resolveBuildId({ BUILD_ID: 'run-42' }, dirty)).toBe('run-42');
    });

    it('uses the short git commit before local', () => {
        expect(resolveBuildId({}, clean)).toBe('abc1234');
    });

    it('adds -dirty to the commit only when the working tree has changes', () => {
        expect(resolveBuildId({}, dirty)).toBe('abc1234-dirty');
        expect(resolveBuildId({}, clean)).not.toContain('dirty');
    });

    it('is local when there is no variable and no git repository', () => {
        expect(resolveBuildId({}, noGit)).toBe(localBuildId);
        expect(localBuildId).toBe('local');
    });

    it('treats an empty or blank variable as not set', () => {
        expect(resolveBuildId({ BUILD_ID: '' }, clean)).toBe('abc1234');
        expect(resolveBuildId({ BUILD_ID: '  ' }, clean)).toBe('abc1234');
    });
});

describe('readGitState', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'build-id-'));
    afterAll(() => rmSync(directory, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: directory, stdio: 'ignore' });

    it('is undefined outside a repository, and in one with no commit', () => {
        expect(readGitState(directory)).toBeUndefined();
        git('init', '--quiet');
        expect(readGitState(directory)).toBeUndefined();
    });

    it('reads the short commit, and sees a new file and a changed file as changes', () => {
        writeFileSync(path.join(directory, 'a.txt'), 'one');
        git('add', 'a.txt');
        git('commit', '--quiet', '-m', 'first');
        const clean = readGitState(directory)!;
        expect(clean.commit).toMatch(/^[0-9a-f]{7,}$/);
        expect(clean.dirty).toBe(false);

        writeFileSync(path.join(directory, 'b.txt'), 'untracked');
        expect(readGitState(directory)).toEqual({ commit: clean.commit, dirty: true });
        rmSync(path.join(directory, 'b.txt'));
        expect(readGitState(directory)!.dirty).toBe(false);

        writeFileSync(path.join(directory, 'a.txt'), 'two');
        expect(readGitState(directory)!.dirty).toBe(true);
    });
});
