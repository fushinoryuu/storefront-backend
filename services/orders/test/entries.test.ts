import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { zCreateOrderResponse, zGetOrderResponse, zListProductsResponse } from '../../../generated/orders-service-v1/zod.gen';
import { createTable, dynamoDbLocalEndpoint } from '../../../packages/shared/test/support/dynamodb-local';
import { ordersTable } from '../src/table';

// The Lambda entries of the three functions. Each one reads its variables and builds its logger and repository when the module loads, so every test sets the variables first and imports a fresh copy.
// The SDK reads the endpoint from `AWS_ENDPOINT_URL_DYNAMODB`, which is how these entries reach DynamoDB Local without a line of test code in them.

const customerId = '3f6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10';
const context = { awsRequestId: 'req-1' };
let tableName: string;
let written: string[];

beforeAll(async () => {
    tableName = (await createTable(undefined, Object.values(ordersTable.indexes))).tableName;
});

beforeEach(() => {
    vi.stubEnv('SERVICE_NAME', 'orders');
    vi.stubEnv('STAGE', 'dev');
    vi.stubEnv('TABLE_NAME', tableName);
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', dynamoDbLocalEndpoint);
    vi.stubEnv('AWS_REGION', 'us-west-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'local');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local');
    vi.stubEnv('POWERTOOLS_LOG_LEVEL', 'INFO');
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
    });
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const logLines = () =>
    written
        .join('')
        .split('\n')
        .filter((text) => text.trim() !== '')
        .map((text) => JSON.parse(text) as Record<string, unknown>);

describe('the entries of the orders functions', () => {
    it('lists the products without a table, so the function does not need TABLE_NAME', async () => {
        vi.stubEnv('TABLE_NAME', '');
        const { handler } = await import('../src/list-products');
        const response = await handler({}, context);

        expect(response.statusCode).toBe(200);
        expect(zListProductsResponse.parse(JSON.parse(response.body)).items.length).toBeGreaterThan(0);
    });

    it('places an order and reads it back through the entries, on the table of TABLE_NAME', async () => {
        const create = (await import('../src/create-order')).handler;
        const get = (await import('../src/get-order')).handler;
        const placed = await create({ headers: { 'Idempotency-Key': 'entry-1', 'x-correlation-id': 'corr-entry' }, body: JSON.stringify({ customerId, items: [{ productId: 'prd_3a7f1c', quantity: 2 }] }) }, context);
        const order = zCreateOrderResponse.parse(JSON.parse(placed.body));
        const read = await get({ pathParameters: { orderId: order.orderId } }, context);

        expect(placed.statusCode).toBe(201);
        expect(order.orderId).toMatch(/^ord_[0-9a-f]{12}$/);
        expect(placed.headers['location']).toBe(`/v1/orders/${order.orderId}`);
        expect(read.statusCode).toBe(200);
        expect(zGetOrderResponse.parse(JSON.parse(read.body))).toEqual(order);
    });

    it('logs with the service, the stage and the ids of the request, and not with the customer', async () => {
        const create = (await import('../src/create-order')).handler;
        await create({ headers: { 'Idempotency-Key': 'entry-2', 'x-correlation-id': 'corr-entry' }, body: JSON.stringify({ customerId, items: [{ productId: 'prd_3a7f1c', quantity: 1 }] }) }, context);

        expect(logLines()).toEqual([expect.objectContaining({ level: 'INFO', message: 'placed an order', service: 'orders', stage: 'dev', correlationId: 'corr-entry', requestId: 'req-1' })]);
        expect(written.join('')).not.toContain(customerId);
    });

    it.each(['../src/create-order', '../src/get-order'])('fails when it starts without a table, so a function that was not given one does not run (%s)', async (entry) => {
        vi.stubEnv('TABLE_NAME', '');

        await expect(import(/* @vite-ignore */ entry)).rejects.toThrow('TABLE_NAME');
    });
});
