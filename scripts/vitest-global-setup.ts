import { setupDynamoDbLocal } from './dynamodb-local';

/** Runs once before the whole test run. vitest calls the function it gives back when the run ends, whether it passed or failed. */
export default function setup() {
    return setupDynamoDbLocal({ env: process.env, warn: (message) => console.warn(message) });
}
