import { z } from 'zod';
import { zCreateOrder, zCreateOrderHeaders, zCreateOrderItem, zGetOrderPath, zListProductsQuery } from '../../../generated/orders-service-v1/zod.gen';
import { NotFoundError, parseJsonBody, validate, validateParameters } from '../../../packages/shared/src';
import type { ServiceLogger } from '../../../packages/shared/src';
import type { Catalog } from './catalog';
import { route } from './http';
import type { ApiHandler } from './http';
import { placeOrder } from './place-order';
import type { PlaceOrderDeps } from './place-order';
import type { OrdersRepository } from './repository';

/**
 * The body of `createOrder`, from the schema of the spec but strict. The spec says that a field that is not listed (a `unitPrice`, for example) is rejected with 400,
 * and the generated schema drops it instead. The limits of `items` are the ones of the generated schema, and a test keeps the two the same.
 */
export const createOrderBody = z.object({ ...zCreateOrder.shape, items: z.array(zCreateOrderItem.strict()).min(1).max(20) }).strict();

export function listProductsHandler({ catalog, logger }: { catalog: Catalog; logger: ServiceLogger }): ApiHandler {
    return route(logger, async ({ event }) => {
        const { limit, cursor } = validateParameters(zListProductsQuery, event.queryStringParameters, 'query');
        return { status: 200, body: catalog.page(limit, cursor) };
    });
}

export function createOrderHandler(deps: PlaceOrderDeps & { logger: ServiceLogger }): ApiHandler {
    return route(deps.logger, async ({ event, correlationId, log }) => {
        const { 'Idempotency-Key': key } = validateParameters(zCreateOrderHeaders, event.headers, 'headers');
        const request = validate(createOrderBody, parseJsonBody(event.body));
        const { order, replayed } = await placeOrder(deps, { key, request, correlationId });
        log.info(replayed ? 'answered a repeated request with the first order' : 'placed an order', { orderId: order.orderId });
        return { status: 201, headers: { location: `/v1/orders/${order.orderId}` }, body: order };
    });
}

export function getOrderHandler({ repository, logger }: { repository: OrdersRepository; logger: ServiceLogger }): ApiHandler {
    return route(logger, async ({ event }) => {
        const { orderId } = validateParameters(zGetOrderPath, event.pathParameters, 'path');
        const order = await repository.getOrder(orderId);
        if (order === undefined) throw new NotFoundError('There is no order with this id.');
        return { status: 200, body: order };
    });
}
