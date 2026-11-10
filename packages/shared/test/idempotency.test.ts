import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createIdempotency, idempotencyTtlAttribute } from '../src/index';
import { createTable, needsDynamoDbLocal, type LocalTable } from './support/dynamodb-local';

describe('createIdempotency without a database', () => {
    const failing = (error: unknown) => ({ send: vi.fn().mockRejectedValue(error) }) as unknown as DynamoDBDocumentClient;

    it('takes a failed condition for a repeat', async () => {
        const error = new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
        expect(await createIdempotency({ client: failing(error), tableName: 't', ttlSeconds: 60 }).claim('k')).toBe(false);
    });

    it('does not hide any other error, so a broken table is not taken for a repeat', async () => {
        const idempotency = createIdempotency({ client: failing(new Error('boom')), tableName: 't', ttlSeconds: 60 });
        await expect(idempotency.claim('k')).rejects.toThrow('boom');
    });

    it('refuses an empty key', async () => {
        const idempotency = createIdempotency({ client: failing(new Error('not reached')), tableName: 't', ttlSeconds: 60 });
        await expect(idempotency.claim('')).rejects.toThrow('empty');
        await expect(idempotency.release('')).rejects.toThrow('empty');
    });
});

describe.skipIf(!needsDynamoDbLocal)('createIdempotency against DynamoDB Local', () => {
    const start = Date.UTC(2026, 10, 10, 12, 0, 0);
    let table: LocalTable;
    let clock = start;

    beforeAll(async () => {
        table = await createTable();
    });

    const make = (ttlSeconds = 3600) => createIdempotency({ client: table.client, tableName: table.tableName, ttlSeconds, now: () => clock });
    const stored = async (key: string) => (await table.client.send(new GetCommand({ TableName: table.tableName, Key: { PK: `IDEMPOTENCY#${key}`, SK: 'IDEMPOTENCY' } }))).Item;

    it('sees a second call with the same key as a duplicate', async () => {
        const idempotency = make();
        expect(await idempotency.claim('order-1')).toBe(true);
        expect(await idempotency.claim('order-1')).toBe(false);
        expect(await idempotency.claim('order-2')).toBe(true);
    });

    it('lets exactly one of many simultaneous calls through', async () => {
        const idempotency = make();
        const results = await Promise.all(Array.from({ length: 10 }, () => idempotency.claim('race')));
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('stores when the key runs out in the TTL attribute, and the table has TTL on that attribute', async () => {
        await make(600).claim('ttl');
        expect((await stored('ttl'))?.[idempotencyTtlAttribute]).toBe(start / 1000 + 600);
        expect(await table.timeToLiveAttribute()).toBe(idempotencyTtlAttribute);
    });

    it('accepts a key again once its time has run out, even before DynamoDB removes the item', async () => {
        const idempotency = make(60);
        expect(await idempotency.claim('expiring')).toBe(true);
        clock = start + 59_000;
        expect(await idempotency.claim('expiring')).toBe(false);
        clock = start + 61_000;
        expect(await idempotency.claim('expiring')).toBe(true);
        expect((await stored('expiring'))?.[idempotencyTtlAttribute]).toBe((start + 61_000) / 1000 + 60);
        clock = start;
    });

    it('forgets a released key', async () => {
        const idempotency = make();
        await idempotency.claim('failed');
        await idempotency.release('failed');
        expect(await stored('failed')).toBeUndefined();
        expect(await idempotency.claim('failed')).toBe(true);
    });
});
