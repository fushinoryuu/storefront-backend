import type { z } from 'zod';
import { zCreateOrderItem, zOrderItem } from '../../../generated/orders-service-v1/zod.gen';
import { ValidationError } from '../../../packages/shared/src';
import type { FieldError } from '../../../packages/shared/src';
import type { Catalog } from './catalog';

export type RequestedItem = z.output<typeof zCreateOrderItem>;
export type OrderItem = z.output<typeof zOrderItem>;

export interface PricedItems {
    items: OrderItem[];
    currency: string;
    /** The sum of quantity times price over the lines, in minor units: an integer, so no floating point is involved. */
    total: number;
}

/**
 * Prices the lines of an order from the catalog. The request has no price to read, and a line gets the price that the catalog has now.
 * It throws one `ValidationError` that lists every line that fails: a product that is not in the catalog, a product on two lines, and a product whose currency is not the one of the first line.
 */
export function priceItems(requested: readonly RequestedItem[], catalog: Pick<Catalog, 'find'>): PricedItems {
    const errors: FieldError[] = [];
    const lineOf = new Map<string, number>();
    const items: OrderItem[] = [];
    let currency: string | undefined;

    requested.forEach(({ productId, quantity }, index) => {
        const field = `items[${index}].productId`;
        const earlier = lineOf.get(productId);
        if (earlier !== undefined) {
            errors.push({ field, message: `is already on items[${earlier}]` });
            return;
        }
        lineOf.set(productId, index);
        const product = catalog.find(productId);
        if (product === undefined) {
            errors.push({ field, message: 'is not a product of the catalog' });
        } else if (currency !== undefined && product.currency !== currency) {
            errors.push({ field, message: `is priced in ${product.currency}, and the order is in ${currency}` });
        } else {
            currency = product.currency;
            items.push({ productId, quantity, unitPrice: product.unitPrice });
        }
    });

    if (errors.length === 0 && currency === undefined) errors.push({ field: 'items', message: 'must have at least one line' });
    if (errors.length > 0 || currency === undefined) throw new ValidationError(errors);
    return { items, currency, total: items.reduce((sum, { quantity, unitPrice }) => sum + quantity * unitPrice, 0) };
}
