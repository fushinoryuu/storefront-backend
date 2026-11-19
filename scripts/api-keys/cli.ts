import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getStageConfig, stageNames, UnknownStageError } from '../../infra/lib/config/stages';
import { apiKeyIdParameterName, apiKeyKinds } from '../../infra/lib/naming';
import type { ApiKeyKind } from '../../infra/lib/naming';
import { consoleLog } from '../specs/cli';
import type { Log } from '../specs/cli';

/** Where the ids and the values come from. The AWS implementation is in `aws.ts`, and a test passes its own. */
export interface KeySource {
    /** The value of an SSM parameter. */
    parameter(name: string): Promise<string>;
    /** The value of an API key, from the API Gateway `get-api-key` call that includes it. */
    keyValue(id: string): Promise<string>;
}

/** The folder for the key files, relative to the repo root. It is in `.gitignore`. */
export const keysDirectory = '.api-keys';

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The value of each API key of a stage, read through the ids that the platform stack put in SSM. */
export async function fetchApiKeys(stage: string, source: KeySource): Promise<Record<ApiKeyKind, string>> {
    const config = getStageConfig(stage);
    const keys: Partial<Record<ApiKeyKind, string>> = {};
    for (const kind of apiKeyKinds) {
        keys[kind] = await source.keyValue(await source.parameter(apiKeyIdParameterName(config, kind)));
    }
    return keys as Record<ApiKeyKind, string>;
}

/** `npm run get-api-keys -- --stage dev`: writes the three key values to `.api-keys/<stage>.json`, which only the owner can read. Returns the exit code. */
export async function runGetApiKeys(rootDir: string, args: readonly string[], source: KeySource, log: Log = consoleLog): Promise<number> {
    const flag = args.indexOf('--stage');
    const stage = flag === -1 ? undefined : args[flag + 1];
    if (stage === undefined) {
        log.err(`Pass the stage: --stage ${stageNames.join(' or --stage ')}.`);
        return 1;
    }
    try {
        const keys = await fetchApiKeys(stage, source);
        const directory = path.join(rootDir, keysDirectory);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${stage}.json`);
        await writeFile(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
        // Only the kinds and the path are printed, never a value.
        log.out(`Wrote the ${apiKeyKinds.join(', ')} API keys of ${stage} to ${path.relative(rootDir, file)}.`);
        return 0;
    } catch (error) {
        log.err(error instanceof UnknownStageError ? error.message : `${describe(error)} Is the Platform stack of ${stage} deployed, and are you logged in (aws sso login --profile storefront)?`);
        return 1;
    }
}
