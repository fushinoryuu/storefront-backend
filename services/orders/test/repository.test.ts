import { TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTable } from '../../../packages/shared/test/support/dynamodb-local';
import type { LocalTable } from '../../../packages/shared/test/support/dynamodb-local';
import { hashRequest } from '../src/idempotency';
import type { Order } from '../src/order';
import { createOrdersRepository } from '../src/repository';
import type { PlaceOrderInput } from '../src/repository';
import { ordersTable } from '../src/table';

// These run against the DynamoDB Local of docker-compose.yaml (see packages/shared/README.md), with a table built from the shape of `ordersTable`.

const customerId = '3f6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10';
const now = 1_800_000_000;
const orderOf = (orderId: string, overrides: Partial<Order> = {}): Order => ({
    orderId,
    customerId,
    status: 'PENDING',
    items: [{ productId: 'prd_3a7f1c', quantity: 2, unitPrice: 2499 }],
    currency: 'USD',
    total: 4998,
    version: 1,
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:00:00.000Z',
    ...overrides
});
const inputOf = (key: string, order: Order, overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
    order,
    key,
    requestHash: hashRequest({ customerId, items: order.items }),
    correlationId: 'corr-1',
    nowSeconds: now,
    expiresAt: now + 86_400,
    ...overrides
});

describe('the orders repository against DynamoDB Local', () => {
    let table: LocalTable;
    let repository: ReturnType<typeof createOrdersRepository>;
    const rawItem = async (PK: string, SK = 'META') => (await table.client.send(new GetCommand({ TableName: table.tableName, Key: { PK, SK } }))).Item;

    beforeAll(async () => {
        table = await createTable(undefined, Object.values(ordersTable.indexes));
        repository = createOrdersRepository({ client: table.client, tableName: table.tableName });
    });

    it('has no order and no record for an id and a key it does not know', async () => {
        expect(await repository.getOrder('ord_unknown')).toBeUndefined();
        expect(await repository.getIdempotencyRecord('unknown')).toBeUndefined();
    });

    it('places an order, and reads it back as the order of the API with nothing else on it', async () => {
        const order = orderOf('ord_a');

        expect(await repository.placeOrder(inputOf('key-a', order))).toBe('placed');
        expect(await repository.getOrder('ord_a')).toStrictEqual(order);
    });

    it('writes the order and the record of its key together', async () => {
        const order = orderOf('ord_b');
        await repository.placeOrder(inputOf('key-b', order));

        expect(await repository.getIdempotencyRecord('key-b')).toStrictEqual({ requestHash: hashRequest({ customerId, items: order.items }), order, expiresAt: now + 86_400 });
    });

    it('stores the keys of the indexes on the order, and the correlation id of the request', async () => {
        await repository.placeOrder(inputOf('key-c', orderOf('ord_c')));
        const item = await rawItem('ORDER#ord_c');

        expect(item).toMatchObject({
            GSI1PK: `CUSTOMER#${customerId}`,
            GSI1SK: '2026-11-23T10:00:00.000Z#ord_c',
            GSI2PK: 'STATUS#PENDING',
            GSI2SK: '2026-11-23T10:00:00.000Z#ord_c',
            correlationId: 'corr-1'
        });
    });

    it('lets the order be found through the index of the customer, newest first, and through the index of the status', async () => {
        const other = '9a6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10';
        await repository.placeOrder(inputOf('key-d1', orderOf('ord_d1', { customerId: other, createdAt: '2026-11-23T10:00:00.000Z' })));
        await repository.placeOrder(inputOf('key-d2', orderOf('ord_d2', { customerId: other, createdAt: '2026-11-23T11:00:00.000Z' })));
        const query = async (index: string, partitionKey: string, value: string) =>
            (await table.client.send(new QueryCommand({ TableName: table.tableName, IndexName: index, KeyConditionExpression: '#pk = :value', ExpressionAttributeNames: { '#pk': partitionKey }, ExpressionAttributeValues: { ':value': value }, ScanIndexForward: false }))).Items?.map(
                (item) => item['orderId']
            );
        const { byCustomer, byStatus } = ordersTable.indexes;

        expect(await query(byCustomer.name, byCustomer.partitionKey, `CUSTOMER#${other}`)).toEqual(['ord_d2', 'ord_d1']);
        expect(await query(byStatus.name, byStatus.partitionKey, 'STATUS#PENDING')).toEqual(expect.arrayContaining(['ord_d1', 'ord_d2']));
    });

    it('sets the time to live on the record of the key and not on the order', async () => {
        await repository.placeOrder(inputOf('key-e', orderOf('ord_e')));

        expect(await table.timeToLiveAttribute()).toBe(ordersTable.ttlAttribute);
        expect(await rawItem('IDEM#key-e')).toMatchObject({ expiresAt: now + 86_400 });
        expect(await rawItem('ORDER#ord_e')).not.toHaveProperty('expiresAt');
    });

    it('answers key-taken for a key that is remembered, and writes no second order', async () => {
        await repository.placeOrder(inputOf('key-f', orderOf('ord_f1')));

        expect(await repository.placeOrder(inputOf('key-f', orderOf('ord_f2')))).toBe('key-taken');
        expect(await repository.getOrder('ord_f2')).toBeUndefined();
        expect((await repository.getIdempotencyRecord('key-f'))?.order.orderId).toBe('ord_f1');
    });

    it('lets a key whose time has run out place a new order, and the record then holds the new order', async () => {
        await repository.placeOrder(inputOf('key-g', orderOf('ord_g1'), { expiresAt: now + 10 }));
        const later = now + 10;

        expect(await repository.placeOrder(inputOf('key-g', orderOf('ord_g2'), { nowSeconds: later, expiresAt: later + 86_400 }))).toBe('placed');
        expect((await repository.getIdempotencyRecord('key-g'))?.order.orderId).toBe('ord_g2');
    });

    it('lets exactly one of many simultaneous requests with one key place an order, and writes one order', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.placeOrder(inputOf('key-h', orderOf(`ord_h${index}`)))));
        const orders = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.getOrder(`ord_h${index}`)));

        expect(results.filter((result) => result === 'placed')).toHaveLength(1);
        expect(orders.filter((order) => order !== undefined)).toHaveLength(1);
    });

    it('does not take an order id that exists already for a repeat, and leaves the key free', async () => {
        await repository.placeOrder(inputOf('key-i1', orderOf('ord_i')));

        await expect(repository.placeOrder(inputOf('key-i2', orderOf('ord_i')))).rejects.toBeInstanceOf(TransactionCanceledException);
        expect(await repository.getIdempotencyRecord('key-i2')).toBeUndefined();
    });
});

describe('the orders repository when the database refuses a write', () => {
    const failing = (error: unknown) => createOrdersRepository({ client: { send: vi.fn().mockRejectedValue(error) } as unknown as DynamoDBDocumentClient, tableName: 't' });
    const canceled = (...codes: string[]) => new TransactionCanceledException({ message: 'canceled', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });
    const place = (repository: ReturnType<typeof createOrdersRepository>) => repository.placeOrder(inputOf('k', orderOf('ord_x')));

    it('takes a refusal of the record of the key for a key that is taken', async () => {
        expect(await place(failing(canceled('None', 'ConditionalCheckFailed')))).toBe('key-taken');
    });

    it.each([
        ['a transaction that conflicts with another one on the same items', canceled('None', 'TransactionConflict')],
        ['a transaction conflict that is raised on its own', new TransactionConflictException({ message: 'conflict', $metadata: {} })]
    ])('takes %s for a key that is taken', async (_name, error) => {
        expect(await place(failing(error))).toBe('key-taken');
    });

    it('does not take a refusal of the order item for a repeat, so it is not hidden', async () => {
        await expect(place(failing(canceled('ConditionalCheckFailed', 'None')))).rejects.toBeInstanceOf(TransactionCanceledException);
    });

    it('does not hide any other error', async () => {
        await expect(place(failing(new Error('boom')))).rejects.toThrow('boom');
    });
});
