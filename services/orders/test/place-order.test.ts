import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ValidationError } from '../../../packages/shared/src';
import { createCatalog } from '../src/catalog';
import { hashRequest, idempotencyTtlSeconds } from '../src/idempotency';
import type { IdempotencyRecord } from '../src/idempotency';
import type { Order } from '../src/order';
import { newOrderId, placeOrder } from '../src/place-order';
import type { OrdersRepository } from '../src/repository';

// `placeOrder` on a fake repository, so that the branches after a refused write are reached on purpose and not by a race.

const customerId = '3f6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10';
const request = { customerId, items: [{ productId: 'prd_lamp', quantity: 2 }] };
const other = { customerId, items: [{ productId: 'prd_lamp', quantity: 3 }] };
const catalog = createCatalog([{ productId: 'prd_lamp', name: 'Lamp', unitPrice: 2499, currency: 'USD' }]);
const at = new Date(Date.UTC(2026, 10, 24, 10, 0, 0));
const nowSeconds = at.getTime() / 1000;
const input = { key: 'key-1', request, correlationId: 'corr-1' };

const firstOrder: Order = { orderId: 'ord_first', customerId, status: 'PENDING', items: [{ productId: 'prd_lamp', quantity: 2, unitPrice: 2499 }], currency: 'USD', total: 4998, version: 1, createdAt: at.toISOString(), updatedAt: at.toISOString() };
const recordOf = (requestBody: typeof request, overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord => ({ requestHash: hashRequest(requestBody), order: firstOrder, expiresAt: nowSeconds + 100, ...overrides });

/** A repository that answers the reads in turn, and answers every write with `outcome`. */
function fakeRepository(outcome: 'placed' | 'key-taken', ...records: (IdempotencyRecord | undefined)[]) {
    const getIdempotencyRecord = vi.fn<OrdersRepository['getIdempotencyRecord']>();
    for (const record of records) getIdempotencyRecord.mockResolvedValueOnce(record);
    const placeOrderWrite = vi.fn<OrdersRepository['placeOrder']>().mockResolvedValue(outcome);
    const repository: OrdersRepository = { getOrder: vi.fn(), getIdempotencyRecord, placeOrder: placeOrderWrite };
    return { deps: { repository, catalog, now: () => at, newOrderId: () => 'ord_new' }, getIdempotencyRecord, placeOrderWrite };
}

const conflictOf = async (run: Promise<unknown>) => {
    const error: unknown = await run.then(
        () => undefined,
        (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ConflictError);
    return (error as ConflictError).detail;
};

describe('placeOrder', () => {
    it('writes a new order, with the key, the hash, the correlation id and a record that lasts 24 hours', async () => {
        const { deps, placeOrderWrite } = fakeRepository('placed', undefined);

        const result = await placeOrder(deps, input);

        expect(result).toEqual({ order: { ...firstOrder, orderId: 'ord_new' }, replayed: false });
        expect(placeOrderWrite).toHaveBeenCalledExactlyOnceWith({ order: result.order, key: 'key-1', requestHash: hashRequest(request), correlationId: 'corr-1', nowSeconds, expiresAt: nowSeconds + idempotencyTtlSeconds });
    });

    it('answers a repeat with the first order and writes nothing', async () => {
        const { deps, placeOrderWrite } = fakeRepository('placed', recordOf(request));

        expect(await placeOrder(deps, input)).toEqual({ order: firstOrder, replayed: true });
        expect(placeOrderWrite).not.toHaveBeenCalled();
    });

    it('refuses another request with the same key before it prices anything or writes', async () => {
        const { deps, placeOrderWrite } = fakeRepository('placed', recordOf(other));

        expect(await conflictOf(placeOrder(deps, input))).toContain('already used with another request');
        expect(placeOrderWrite).not.toHaveBeenCalled();
    });

    it('places a new order when the record of the key has expired', async () => {
        const { deps, placeOrderWrite } = fakeRepository('placed', recordOf(other, { expiresAt: nowSeconds }));

        expect((await placeOrder(deps, input)).replayed).toBe(false);
        expect(placeOrderWrite).toHaveBeenCalledOnce();
    });

    it('does not write, or remember the key, when a line fails validation', async () => {
        const { deps, placeOrderWrite } = fakeRepository('placed', undefined);

        await expect(placeOrder(deps, { ...input, request: { customerId, items: [{ productId: 'prd_nope', quantity: 1 }] } })).rejects.toBeInstanceOf(ValidationError);
        expect(placeOrderWrite).not.toHaveBeenCalled();
    });

    describe('when the write is refused because the key was taken in the meantime', () => {
        it('answers with the order of the other request, when it is the same request', async () => {
            const { deps, getIdempotencyRecord } = fakeRepository('key-taken', undefined, recordOf(request));

            expect(await placeOrder(deps, input)).toEqual({ order: firstOrder, replayed: true });
            expect(getIdempotencyRecord).toHaveBeenCalledTimes(2);
        });

        it('refuses the request, when the other request had another body', async () => {
            const { deps } = fakeRepository('key-taken', undefined, recordOf(other));

            expect(await conflictOf(placeOrder(deps, input))).toContain('already used with another request');
        });

        it('asks the caller to send it again, when the record of the other request cannot be read yet', async () => {
            const { deps } = fakeRepository('key-taken', undefined, undefined);

            expect(await conflictOf(placeOrder(deps, input))).toContain('still being processed');
        });

        it('asks the caller to send it again, when the record it finds has expired', async () => {
            const { deps } = fakeRepository('key-taken', undefined, recordOf(request, { expiresAt: nowSeconds }));

            expect(await conflictOf(placeOrder(deps, input))).toContain('still being processed');
        });
    });
});

describe('newOrderId', () => {
    it('is ord_ and 12 hex characters, and differs every time', () => {
        const ids = new Set(Array.from({ length: 50 }, newOrderId));

        expect(ids.size).toBe(50);
        for (const id of ids) expect(id).toMatch(/^ord_[0-9a-f]{12}$/);
    });
});
