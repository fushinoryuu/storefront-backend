import path from 'node:path';
import { awsKeySource } from './api-keys/aws';
import { runGetApiKeys } from './api-keys/cli';

// The same profile as the other commands (docs/aws-setup.md), unless the shell names another.
process.env.AWS_PROFILE ??= 'storefront';

process.exitCode = await runGetApiKeys(path.resolve(import.meta.dirname, '..'), process.argv.slice(2), awsKeySource());
