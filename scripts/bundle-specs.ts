import path from 'node:path';
import { checkBundles, writeBundles } from './specs/bundle';

const rootDir = path.resolve(import.meta.dirname, '..');

if (process.argv.includes('--check')) {
  const problems = await checkBundles(rootDir);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error('Run `npm run bundle:specs` and commit the result.');
    process.exitCode = 1;
  } else {
    console.log('Bundled specs are current.');
  }
} else {
  const outputs = await writeBundles(rootDir);
  console.log(`Wrote ${outputs.length} bundle(s) to specs/.`);
}
