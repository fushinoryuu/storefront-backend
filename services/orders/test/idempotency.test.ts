import { describe, expect, it } from 'vitest';
import { decideKey, hashRequest, idempotencyTtlSeconds, normalizeRequest } from '../src/idempotency';
import type { IdempotencyRecord } from '../src/idempotency';
import type { Order } from '../src/order';

const customerId = '3f6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10';
const request = { customerId, items: [{ productId: 'prd_3a7f1c', quantity: 2 }] };
const order: Order = { orderId: 'ord_1', customerId, status: 'PENDING', items: [{ productId: 'prd_3a7f1c', quantity: 2, unitPrice: 2499 }], currency: 'USD', total: 4998, version: 1, createdAt: '2026-11-23T10:00:00.000Z', updatedAt: '2026-11-23T10:00:00.000Z' };
const now = 1_800_000_000;
const record = (overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord => ({ requestHash: hashRequest(request), order, expiresAt: now + 100, ...overrides });

describe('idempotencyTtlSeconds', () => {
    it('is the 24 hours that the spec promises', () => {
        expect(idempotencyTtlSeconds).toBe(86_400);
    });
});

describe('hashRequest', () => {
    it('gives the same hash for the same body, whatever the order of its fields', () => {
        const reordered = { items: [{ quantity: 2, productId: 'prd_3a7f1c' }], customerId };

        expect(hashRequest(reordered)).toBe(hashRequest(request));
    });

    it('gives the same hash when the customer id has other letter case, because it is the same customer', () => {
        expect(hashRequest({ ...request, customerId: customerId.toUpperCase() })).toBe(hashRequest(request));
    });

    it.each([
        ['another customer', { ...request, customerId: '4f6c2a1e-8b1d-4c52-9a53-0f4f6d2b7a10' }],
        ['another product', { ...request, items: [{ productId: 'prd_9d2e4b', quantity: 2 }] }],
        ['another quantity', { ...request, items: [{ productId: 'prd_3a7f1c', quantity: 3 }] }],
        ['another number of lines', { ...request, items: [...request.items, { productId: 'prd_9d2e4b', quantity: 1 }] }],
        ['the lines in another order', { ...request, items: [{ productId: 'prd_9d2e4b', quantity: 1 }, ...request.items] }]
    ])('gives another hash for %s', (_name, other) => {
        expect(hashRequest(other)).not.toBe(hashRequest(request));
    });

    it('is a SHA-256 in hex, and does not hold the body', () => {
        expect(hashRequest(request)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashRequest(request)).not.toContain(customerId);
    });
});

describe('normalizeRequest', () => {
    it('keeps only the customer and the product and quantity of each line', () => {
        const withExtras = { customerId: customerId.toUpperCase(), items: [{ productId: 'prd_3a7f1c', quantity: 2, unitPrice: 1 }] };

        expect(normalizeRequest(withExtras)).toEqual(request);
    });
});

describe('decideKey', () => {
    it('places a new order for a key that is not remembered', () => {
        expect(decideKey(undefined, hashRequest(request), now)).toEqual({ kind: 'new' });
    });

    it('answers again with the first order for the same request', () => {
        expect(decideKey(record(), hashRequest(request), now)).toEqual({ kind: 'replay', order });
    });

    it('refuses another request with the same key', () => {
        expect(decideKey(record(), hashRequest({ ...request, items: [{ productId: 'prd_9d2e4b', quantity: 1 }] }), now)).toEqual({ kind: 'conflict' });
    });

    it('places a new order once the key has expired, even for another request, because DynamoDB removes the item some time later', () => {
        const expired = record({ expiresAt: now });

        expect(decideKey(expired, hashRequest(request), now)).toEqual({ kind: 'new' });
        expect(decideKey(expired, 'another-hash', now)).toEqual({ kind: 'new' });
    });

    it('still counts a key in the last second before it expires', () => {
        expect(decideKey(record({ expiresAt: now + 1 }), hashRequest(request), now).kind).toBe('replay');
    });
});
