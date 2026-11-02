import path from 'node:path';
import { formatResults, hasErrors, lintSpecs } from './specs/lint';

const rootDir = path.resolve(import.meta.dirname, '..');
const results = await lintSpecs(rootDir);

if (results.length === 0) {
  console.log('No specs found under services/*/openapi*.yaml.');
} else {
  const report = formatResults(results);
  if (report) console.log(report);
  console.log(`Linted ${results.length} spec(s).`);
}
process.exitCode = hasErrors(results) ? 1 : 0;
