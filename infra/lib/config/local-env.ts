import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The `.env` file at the repo root. Git ignores it, so a value in it, such as an alarm address, stays on this machine. */
export const localEnvFile = fileURLToPath(new URL('../../../.env', import.meta.url));

/**
 * Loads the variables of the `.env` file into `process.env`, if there is a file.
 * A variable that is already set keeps its value, so the shell or a deploy workflow wins over the file.
 */
export function loadLocalEnv(file: string = localEnvFile): void {
    if (existsSync(file)) process.loadEnvFile(file);
}
