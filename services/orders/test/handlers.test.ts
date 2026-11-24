import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { zCreateOrder, zCreateOrderResponse, zGetOrderResponse, zListProductsResponse, zProblem } from '../../../generated/orders-service-v1/zod.gen';
import type { HttpResponse, RequestLogger, ServiceLogger } from '../../../packages/shared/src';
import { createTable } from '../../../packages/shared/test/support/dynamodb-local';
import { catalog } from '../src/catalog';
import { createOrderBody, createOrderHandler, getOrderHandler, listProductsHandler } from '../src/handlers';
import type { ApiEvent } from '../src/http';
import { createOrdersRepository } from '../src/repository';
import { ordersTable } from '../src/table';

// The handlers run on the real repository and a real DynamoDB Local table (see packages/shared/README.md), and every response is checked against the schemas that are generated from the spec.

const customerId = '3f6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10';
const context = { awsRequestId: 'req-1' };
const body = {
    customerId,
    items: [
        { productId: 'prd_3a7f1c', quantity: 2 },
        { productId: 'prd_9d2e4b', quantity: 1 }
    ]
};

let clock = Date.UTC(2026, 10, 23, 10, 0, 0);
let counter = 0;
const logged: { level: string; message: string; fields: Record<string, unknown> }[] = [];
const record =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}) =>
        void logged.push({ level, message, fields });
const log: RequestLogger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
const logger: ServiceLogger = { forRequest: () => log };

const parsed = (response: HttpResponse): unknown => JSON.parse(response.body);
const post = (payload: unknown, key: string | null, headers: Record<string, string> = {}): ApiEvent => ({ headers: { ...(key !== null && { 'Idempotency-Key': key }), ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });

function expectProblem(response: HttpResponse, status: number, type: string) {
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toBe('application/json');
    const problem = zProblem.parse(parsed(response));
    expect(problem).toMatchObject({ status, type: `https://storefront.example/problems/${type}` });
    return problem;
}

describe('the handlers of the orders service', () => {
    let repository: ReturnType<typeof createOrdersRepository>;
    let createOrder: ReturnType<typeof createOrderHandler>;
    let getOrder: ReturnType<typeof getOrderHandler>;
    const listProducts = listProductsHandler({ catalog, logger });

    beforeAll(async () => {
        const table = await createTable(undefined, Object.values(ordersTable.indexes));
        repository = createOrdersRepository({ client: table.client, tableName: table.tableName });
        createOrder = createOrderHandler({ repository, catalog, logger, now: () => new Date(clock), newOrderId: () => `ord_${++counter}` });
        getOrder = getOrderHandler({ repository, logger });
    });

    // Every test uses a key of its own, so none depends on another.
    const place = (key: string, payload: unknown = body) => createOrder(post(payload, key), context);

    describe('listProducts', () => {
        it('answers with the catalog in the shape of the spec', async () => {
            const response = await listProducts({}, context);

            expect(response.statusCode).toBe(200);
            const page = zListProductsResponse.parse(parsed(response));
            expect(page.items).toEqual(catalog.page(100).items);
            expect(page.nextCursor).toBeNull();
        });

        it('pages with limit and cursor, and the cursor of one page opens the next', async () => {
            const first = zListProductsResponse.parse(parsed(await listProducts({ queryStringParameters: { limit: '5' } }, context)));
            const second = zListProductsResponse.parse(parsed(await listProducts({ queryStringParameters: { limit: '5', cursor: first.nextCursor! } }, context)));

            expect(first.items).toHaveLength(5);
            expect(second.items).toEqual(catalog.page(5, first.nextCursor!).items);
            expect(second.items[0]).not.toEqual(first.items[0]);
        });

        it.each([
            ['limit', '0'],
            ['limit', '101'],
            ['limit', 'many'],
            ['cursor', 'nope']
        ])('refuses %s=%s with a 400 that names it', async (name, value) => {
            const problem = expectProblem(await listProducts({ queryStringParameters: { [name]: value } }, context), 400, 'invalid-request');

            expect(problem.errors?.map(({ field }) => field)).toEqual([name]);
        });
    });

    describe('createOrder', () => {
        it('places an order, priced from the catalog, and answers 201 with the order and its Location', async () => {
            const response = await place('placed-1');

            expect(response.statusCode).toBe(201);
            const order = zCreateOrderResponse.parse(parsed(response));
            expect(order).toMatchObject({ customerId, status: 'PENDING', currency: 'USD', total: 6297, version: 1, createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() });
            expect(order.items).toEqual([
                { productId: 'prd_3a7f1c', quantity: 2, unitPrice: 2499 },
                { productId: 'prd_9d2e4b', quantity: 1, unitPrice: 1299 }
            ]);
            expect(response.headers['location']).toBe(`/v1/orders/${order.orderId}`);
            expect(response.headers['content-type']).toBe('application/json');
        });

        it('sends back the correlation id of the request, or a new one', async () => {
            const given = await createOrder(post(body, 'corr-1', { 'X-Correlation-Id': 'trace-7' }), context);
            const generated = await place('corr-2');

            expect(given.headers['x-correlation-id']).toBe('trace-7');
            expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
        });

        it('finds the header of the key whatever its case', async () => {
            expect((await createOrder({ headers: { 'idempotency-key': 'lower-case-key' }, body: JSON.stringify(body) }, context)).statusCode).toBe(201);
        });

        it('answers a repeated key and body with the first order, and places no second one', async () => {
            const first = await place('repeat-1');
            const created = counter;
            const again = await place('repeat-1');

            expect(again.statusCode).toBe(201);
            expect(parsed(again)).toEqual(parsed(first));
            expect(again.headers['location']).toBe(first.headers['location']);
            expect(await repository.getOrder(`ord_${created + 1}`)).toBeUndefined();
        });

        it('takes a body with the same content as the same request, whatever the order of its fields', async () => {
            const first = await place('repeat-2');
            const reordered = await place('repeat-2', {
                items: [
                    { quantity: 2, productId: 'prd_3a7f1c' },
                    { quantity: 1, productId: 'prd_9d2e4b' }
                ],
                customerId: customerId.toUpperCase()
            });

            expect(parsed(reordered)).toEqual(parsed(first));
        });

        it.each([
            ['another quantity', { ...body, items: [{ productId: 'prd_3a7f1c', quantity: 3 }, body.items[1]] }],
            ['another product', { ...body, items: [body.items[0], { productId: 'prd_1b4c7e', quantity: 1 }] }],
            ['another customer', { ...body, customerId: '4f6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10' }]
        ])('answers 409 for a repeated key with %s, and keeps the first order', async (name, other) => {
            const key = `reused-${name.replaceAll(' ', '-')}`;
            const first = zCreateOrderResponse.parse(parsed(await place(key)));
            const problem = expectProblem(await place(key, other), 409, 'conflict');

            expect(problem.detail).toContain('Idempotency-Key');
            expect(await repository.getOrder(first.orderId)).toEqual(first);
        });

        it('lets exactly one of many simultaneous requests with one key place an order, and answers the others with that order or a 409 to send again', async () => {
            const before = counter;
            const responses = await Promise.all(Array.from({ length: 6 }, () => place('simultaneous')));
            const placed = responses.filter(({ statusCode }) => statusCode === 201).map((response) => zCreateOrderResponse.parse(parsed(response)));
            const stored = await Promise.all(Array.from({ length: 6 }, (_, index) => repository.getOrder(`ord_${before + index + 1}`)));

            expect(placed.length).toBeGreaterThanOrEqual(1);
            expect(new Set(placed.map(({ orderId }) => orderId)).size).toBe(1);
            for (const response of responses.filter(({ statusCode }) => statusCode !== 201)) expectProblem(response, 409, 'conflict');
            expect(stored.filter((order) => order !== undefined)).toHaveLength(1);
        });

        it('forgets a key after 24 hours, so the key places a new order', async () => {
            const first = zCreateOrderResponse.parse(parsed(await place('expires')));
            clock += 24 * 3600 * 1000 + 1000;
            const later = await place('expires');

            expect(later.statusCode).toBe(201);
            expect(zCreateOrderResponse.parse(parsed(later)).orderId).not.toBe(first.orderId);
        });

        it('cannot be given a price: a price on a line, or any other field that the spec does not list, is a 400, and no order is placed', async () => {
            const before = counter;
            const priced = expectProblem(await place('price-1', { ...body, items: [{ productId: 'prd_3a7f1c', quantity: 1, unitPrice: 1 }] }), 400, 'invalid-request');
            const total = expectProblem(await place('price-2', { ...body, total: 1 }), 400, 'invalid-request');

            expect(priced.errors).toEqual([{ field: 'items[0]', message: expect.stringContaining('unitPrice') }]);
            expect(total.errors).toEqual([{ field: 'body', message: expect.stringContaining('total') }]);
            expect(counter).toBe(before);
        });

        it('answers 400 for a product that is not in the catalog, names its line, and does not remember the key', async () => {
            const bad = {
                customerId,
                items: [
                    { productId: 'prd_3a7f1c', quantity: 1 },
                    { productId: 'prd_nope', quantity: 1 }
                ]
            };
            const problem = expectProblem(await place('unknown-product', bad), 400, 'invalid-request');

            expect(problem.errors).toEqual([{ field: 'items[1].productId', message: 'is not a product of the catalog' }]);
            expect((await place('unknown-product')).statusCode).toBe(201);
        });

        it.each([
            ['no body', undefined, 'body'],
            ['a body that is not JSON', '{nope', 'body'],
            ['a body that is a list', [], 'body'],
            ['no customer', { items: body.items }, 'customerId'],
            ['a customer id that is not a UUID', { ...body, customerId: 'cus_1' }, 'customerId'],
            ['no lines', { ...body, items: [] }, 'items'],
            ['more than 20 lines', { ...body, items: Array.from({ length: 21 }, (_, index) => ({ productId: `prd_${index}`, quantity: 1 })) }, 'items'],
            ['a quantity of 0', { ...body, items: [{ productId: 'prd_3a7f1c', quantity: 0 }] }, 'items[0].quantity'],
            ['a quantity above 100', { ...body, items: [{ productId: 'prd_3a7f1c', quantity: 101 }] }, 'items[0].quantity'],
            ['a quantity that is not a whole number', { ...body, items: [{ productId: 'prd_3a7f1c', quantity: 1.5 }] }, 'items[0].quantity'],
            ['a line with no product', { ...body, items: [{ quantity: 1 }] }, 'items[0].productId'],
            ['a product on two lines', { ...body, items: [body.items[0], body.items[0]] }, 'items[1].productId']
        ])('answers 400 for %s, and names %s', async (name, payload, field) => {
            const key = `invalid-${name}`.replaceAll(' ', '-');
            const response = payload === undefined ? await createOrder({ headers: { 'Idempotency-Key': key } }, context) : await place(key, payload);
            const problem = expectProblem(response, 400, 'invalid-request');

            expect(problem.errors?.map((error) => error.field)).toContain(field);
        });

        it.each([
            ['is missing', null],
            ['is empty', ''],
            ['has a character that is not allowed', 'key with spaces'],
            ['is longer than 64 characters', 'k'.repeat(65)]
        ])('answers 400 when the Idempotency-Key %s', async (_name, key) => {
            const problem = expectProblem(await createOrder(post(body, key), context), 400, 'invalid-request');

            expect(problem.errors?.map(({ field }) => field)).toEqual(['Idempotency-Key']);
        });

        it('accepts a key of 64 characters, the longest the spec allows', async () => {
            expect((await place('k'.repeat(64))).statusCode).toBe(201);
        });

        it('answers 500 without detail when the table fails, and logs the error with its stack', async () => {
            const broken = createOrderHandler({ repository: createOrdersRepository({ client: { send: vi.fn().mockRejectedValue(new Error('table is gone')) } as unknown as DynamoDBDocumentClient, tableName: 't' }), catalog, logger, now: () => new Date(clock), newOrderId: () => 'ord_x' });
            logged.length = 0;
            const response = await broken(post(body, 'broken'), context);
            const problem = expectProblem(response, 500, 'internal-error');

            expect(problem.detail).toBeUndefined();
            expect(response.body).not.toContain('table is gone');
            expect(logged).toContainEqual({ level: 'error', message: 'request failed', fields: { error: expect.objectContaining({ message: 'table is gone' }) } });
        });

        it('logs what it did without the customer, the lines or the key', async () => {
            logged.length = 0;
            const order = zCreateOrderResponse.parse(parsed(await place('log-1')));
            await place('log-1');
            await place('log-1', { ...body, customerId: '5f6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10' });

            expect(logged).toEqual([
                { level: 'info', message: 'placed an order', fields: { orderId: order.orderId } },
                { level: 'info', message: 'answered a repeated request with the first order', fields: { orderId: order.orderId } },
                { level: 'warn', message: 'request refused', fields: { status: 409, type: 'conflict' } }
            ]);
        });
    });

    describe('getOrder', () => {
        it('answers with the order that was placed, in the shape of the spec and with nothing of the table in it', async () => {
            const placed = zCreateOrderResponse.parse(parsed(await place('get-1')));
            const response = await getOrder({ pathParameters: { orderId: placed.orderId } }, context);

            expect(response.statusCode).toBe(200);
            expect(zGetOrderResponse.parse(parsed(response))).toStrictEqual(placed);
            expect(Object.keys(parsed(response) as object).sort()).toEqual(Object.keys(zGetOrderResponse.shape).sort());
        });

        it('answers 404 for an order that does not exist', async () => {
            const problem = expectProblem(await getOrder({ pathParameters: { orderId: 'ord_nope' } }, context), 404, 'not-found');

            expect(problem.detail).toBe('There is no order with this id.');
        });

        it('answers 404 for the key of an idempotency record that is used as an order id', async () => {
            await place('get-2');

            expectProblem(await getOrder({ pathParameters: { orderId: 'IDEM#get-2' } }, context), 404, 'not-found');
        });

        it('answers 400 when the route did not give an order id', async () => {
            expectProblem(await getOrder({}, context), 400, 'invalid-request');
        });
    });
});

describe('the body of createOrder', () => {
    const accepted = (payload: unknown) => createOrderBody.safeParse(payload).success;
    const generatedAccepts = (payload: unknown) => zCreateOrder.safeParse(payload).success;

    it.each([
        ['a valid body', body],
        ['20 lines', { customerId, items: Array.from({ length: 20 }, (_, index) => ({ productId: `prd_${index}`, quantity: 100 })) }],
        ['21 lines', { customerId, items: Array.from({ length: 21 }, (_, index) => ({ productId: `prd_${index}`, quantity: 1 })) }],
        ['no lines', { customerId, items: [] }],
        ['a quantity of 100', { customerId, items: [{ productId: 'p', quantity: 100 }] }],
        ['a quantity of 101', { customerId, items: [{ productId: 'p', quantity: 101 }] }],
        ['a product id of 64 characters', { customerId, items: [{ productId: 'p'.repeat(64), quantity: 1 }] }],
        ['a product id of 65 characters', { customerId, items: [{ productId: 'p'.repeat(65), quantity: 1 }] }],
        ['a customer that is not a UUID', { customerId: 'x', items: body.items }]
    ])('decides %s like the schema that is generated from the spec', (_name, payload) => {
        expect(accepted(payload)).toBe(generatedAccepts(payload));
    });

    it('refuses what the generated schema would let through: a field that the spec does not list', () => {
        const extra = { ...body, unitPrice: 1 };

        expect(generatedAccepts(extra)).toBe(true);
        expect(accepted(extra)).toBe(false);
    });
});
