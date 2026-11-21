import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Off unless asked for, because it slows the run down: `npm test -- --coverage` writes the report to coverage/.
        coverage: {
            provider: 'v8',
            // Every source file counts, also one that no test imports, so a file with no test shows as 0% and not as missing.
            include: ['infra/**/*.ts', 'packages/*/src/**/*.ts', 'services/*/src/**/*.ts', 'scripts/**/*.ts'],
            exclude: ['**/test/**', '**/*.test.ts', '**/node_modules/**', '**/cdk.out/**'],
            // The summary is for the log, the HTML report is for reading line by line, and lcov is the format other tools read.
            reporter: ['text-summary', 'html', 'lcov'],
            reportsDirectory: 'coverage'
        }
    }
});
