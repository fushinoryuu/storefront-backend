import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Starts DynamoDB Local for the tests that need it (scripts/dynamodb-local.ts).
        globalSetup: ['./scripts/vitest-global-setup.ts']
    }
});
