import { execFileSync } from 'node:child_process';

/** The environment variable that sets the build id. A deploy workflow sets it, so the id is the commit that was built. */
export const buildIdVariable = 'BUILD_ID';

/** The build id when there is no variable and no git repository, for example in a copy of the code that has no `.git`. */
export const localBuildId = 'local';

/** What the working tree says: the short commit it is on, and whether files differ from that commit. */
export interface GitState {
    readonly commit: string;
    readonly dirty: boolean;
}

/** The state of the git working tree in `cwd`, or `undefined` when git is missing, `cwd` is not a repository or it has no commit. Untracked files count as changes. */
export function readGitState(cwd: string = process.cwd()): GitState | undefined {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return { commit: git('rev-parse', '--short', 'HEAD'), dirty: git('status', '--porcelain') !== '' };
    } catch {
        return undefined;
    }
}

/**
 * The build id that `GET /v0/version` reports: the `BUILD_ID` variable when it is set, else the short git commit, else `local`.
 * The commit gets a `-dirty` suffix when the working tree has changes, because then the code deployed is not the code of that commit.
 * The variable is used as it is: whoever sets it says what was built. It is read when the app is built, so the id is in the template and not looked up by the function.
 */
export function resolveBuildId(env: NodeJS.ProcessEnv = process.env, git: () => GitState | undefined = readGitState): string {
    const fromEnv = env[buildIdVariable]?.trim();
    if (fromEnv) return fromEnv;
    const state = git();
    return state === undefined ? localBuildId : `${state.commit}${state.dirty ? '-dirty' : ''}`;
}
