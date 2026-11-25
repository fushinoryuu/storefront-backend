import { randomUUID } from 'node:crypto';
import { ConflictError } from '../../../packages/shared/src';
import type { Catalog } from './catalog';
import { decideKey, hashRequest, idempotencyTtlSeconds, normalizeRequest } from './idempotency';
import type { PlaceOrderRequest } from './idempotency';
import type { Order } from './order';
import { priceItems } from './pricing';
import type { OrdersRepository } from './repository';

export interface PlaceOrderDeps {
    readonly repository: OrdersRepository;
    readonly catalog: Catalog;
    /** The clock. Tests replace it. */
    readonly now: () => Date;
    /** Makes the id of a new order. Tests replace it. */
    readonly newOrderId: () => string;
}

export interface PlaceOrderResult {
    readonly order: Order;
    /** True when the key was used before with the same request, and the order is the first one. */
    readonly replayed: boolean;
}

/** `ord_` and 12 characters of a random UUID: 48 bits, and the table refuses an id that exists, so a clash is an error and not a wrong order. */
export const newOrderId = () => `ord_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

const keyReused = 'This Idempotency-Key was already used with another request. Use a new key for a new order.';
const keyInUse = 'Another request with this Idempotency-Key is still being processed. Send the request again in a moment.';

/**
 * Places an order, in the order that the roadmap gives: look at the key, price the lines from the catalog, and write the order with the record of the key in one transaction.
 * The key comes first, so a repeat is answered with the first order even when the catalog has changed since. A request that fails validation is not remembered, so the same key can be sent again with a body that is right.
 * The customer is not checked yet (the customers service does not exist).
 */
export async function placeOrder(deps: PlaceOrderDeps, { key, request, correlationId }: { key: string; request: PlaceOrderRequest; correlationId: string }): Promise<PlaceOrderResult> {
    const { repository, catalog } = deps;
    const requestHash = hashRequest(request);
    const now = deps.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);

    const first = decideKey(await repository.getIdempotencyRecord(key), requestHash, nowSeconds);
    if (first.kind === 'replay') return { order: first.order, replayed: true };
    if (first.kind === 'conflict') throw new ConflictError(keyReused);

    const { customerId, items: lines } = normalizeRequest(request);
    const { items, currency, total } = priceItems(lines, catalog);
    const at = now.toISOString();
    const order: Order = { orderId: deps.newOrderId(), customerId, status: 'PENDING', items, currency, total, version: 1, createdAt: at, updatedAt: at };

    if ((await repository.placeOrder({ order, key, requestHash, correlationId, nowSeconds, expiresAt: nowSeconds + idempotencyTtlSeconds })) === 'placed') return { order, replayed: false };

    // A request with this key was written between the read and the write. What it means is decided the same way.
    const second = decideKey(await repository.getIdempotencyRecord(key), requestHash, nowSeconds);
    if (second.kind === 'replay') return { order: second.order, replayed: true };
    throw new ConflictError(second.kind === 'conflict' ? keyReused : keyInUse);
}
