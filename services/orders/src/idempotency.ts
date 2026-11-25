import { createHash } from 'node:crypto';
import type { Order } from './order';

/** How long an `Idempotency-Key` is remembered (the spec says 24 hours). */
export const idempotencyTtlSeconds = 24 * 60 * 60;

/** What the service remembers of a key: a hash of the request that used it, the order that it placed, and the time (epoch seconds) after which the key is free again. */
export interface IdempotencyRecord {
    readonly requestHash: string;
    readonly order: Order;
    readonly expiresAt: number;
}

export interface PlaceOrderRequest {
    readonly customerId: string;
    readonly items: readonly { readonly productId: string; readonly quantity: number }[];
}

/** The customer id is the same customer in any case, so it is lower-cased first. The order of the lines counts, because it is the order of the order. */
export function normalizeRequest({ customerId, items }: PlaceOrderRequest): PlaceOrderRequest {
    return { customerId: customerId.toLowerCase(), items: items.map(({ productId, quantity }) => ({ productId, quantity })) };
}

/** A hash of the request, so the same body gives the same hash whatever the order of its fields or the case of the customer id. The body itself is not kept. */
export function hashRequest(request: PlaceOrderRequest): string {
    return createHash('sha256')
        .update(JSON.stringify(normalizeRequest(request)))
        .digest('hex');
}

export type KeyDecision = { kind: 'new' } | { kind: 'replay'; order: Order } | { kind: 'conflict' };

/** What a request does with its key: place a new order (no record, or the record has expired), answer again with the first order (the same request), or be refused (another request). */
export function decideKey(record: IdempotencyRecord | undefined, requestHash: string, nowSeconds: number): KeyDecision {
    if (record === undefined || record.expiresAt <= nowSeconds) return { kind: 'new' };
    return record.requestHash === requestHash ? { kind: 'replay', order: record.order } : { kind: 'conflict' };
}
