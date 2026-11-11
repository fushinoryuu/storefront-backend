import { readdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@hey-api/openapi-ts';

// Turns every bundled spec into Zod schemas under generated/<bundle>/ (decision 0004, option d). The folder is not committed: the bundles are the source, and `pretest` and `pretypecheck` run this script.

const rootDir = path.resolve(import.meta.dirname, '..');
const bundles = readdirSync(path.join(rootDir, 'specs')).filter((name) => /^[a-z]+-service-v\d+\.yaml$/.test(name));

if (bundles.length === 0) {
    console.error('No bundled specs found in specs/. Run npm run bundle:specs first.');
    process.exit(1);
}

for (const bundle of bundles) {
    const name = bundle.replace(/\.yaml$/, '');
    await createClient({
        input: path.join(rootDir, 'specs', bundle),
        output: { path: path.join(rootDir, 'generated', name), clean: true },
        plugins: ['zod'],
        logs: { level: 'silent' }
    });
}

console.log(`Generated Zod schemas for ${bundles.length} spec(s) in generated/.`);
