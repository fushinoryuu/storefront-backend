import { checkBundles, writeBundles } from './bundle';
import { formatResults, hasErrors, lintSpecs } from './lint';

/** Where the commands print, so a test can capture the output. */
export interface Log {
    out(message: string): void;
    err(message: string): void;
}

export const consoleLog: Log = { out: console.log, err: console.error };

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `npm run lint:specs`. Returns the process exit code. */
export async function runLintSpecs(rootDir: string, log: Log = consoleLog): Promise<number> {
    try {
        const results = await lintSpecs(rootDir);
        if (results.length === 0) {
            log.out('No specs found under services/*/openapi*.yaml.');
            return 0;
        }
        const report = formatResults(results);
        if (report) log.out(report);
        log.out(`Linted ${results.length} spec(s).`);
        return hasErrors(results) ? 1 : 0;
    } catch (error) {
        log.err(describe(error));
        return 1;
    }
}

/** `npm run bundle:specs`, with `--check` to only compare. Returns the process exit code. */
export async function runBundleSpecs(rootDir: string, args: readonly string[], log: Log = consoleLog): Promise<number> {
    try {
        if (args.includes('--check')) {
            const problems = await checkBundles(rootDir);
            if (problems.length > 0) {
                log.err(problems.join('\n'));
                log.err('Run `npm run bundle:specs` and commit the result.');
                return 1;
            }
            log.out('Bundled specs are current.');
            return 0;
        }
        const outputs = await writeBundles(rootDir);
        log.out(`Wrote ${outputs.length} bundle(s) to specs/.`);
        return 0;
    } catch (error) {
        log.err(describe(error));
        return 1;
    }
}
