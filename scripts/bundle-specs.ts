import path from 'node:path';
import { runBundleSpecs } from './specs/cli';

process.exitCode = await runBundleSpecs(
  path.resolve(import.meta.dirname, '..'),
  process.argv.slice(2),
);
