import path from 'node:path';
import { runLintSpecs } from './specs/cli';

process.exitCode = await runLintSpecs(path.resolve(import.meta.dirname, '..'));
