import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../packages/shared/src';
import { createCatalog } from '../src/catalog';
import { priceItems } from '../src/pricing';

const catalog = createCatalog([
    { productId: 'prd_lamp', name: 'Lamp', unitPrice: 2499, currency: 'USD' },
    { productId: 'prd_book', name: 'Notebook', unitPrice: 1299, currency: 'USD' },
    { productId: 'prd_free', name: 'Sticker', unitPrice: 0, currency: 'USD' },
    { productId: 'prd_euro', name: 'Mug', unitPrice: 1500, currency: 'EUR' }
]);

const errorsOf = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        return (error as ValidationError).errors;
    }
    throw new Error('Expected a ValidationError, and nothing was thrown.');
};

describe('priceItems', () => {
    it('prices every line from the catalog and adds them up in whole minor units', () => {
        expect(
            priceItems(
                [
                    { productId: 'prd_lamp', quantity: 2 },
                    { productId: 'prd_book', quantity: 1 }
                ],
                catalog
            )
        ).toEqual({
            items: [
                { productId: 'prd_lamp', quantity: 2, unitPrice: 2499 },
                { productId: 'prd_book', quantity: 1, unitPrice: 1299 }
            ],
            currency: 'USD',
            total: 6297
        });
    });

    it('takes the price from the catalog even when the request carries one, because a price on a line is not read', () => {
        const line = { productId: 'prd_lamp', quantity: 1, unitPrice: 1 };

        expect(priceItems([line], catalog)).toMatchObject({ items: [{ unitPrice: 2499 }], total: 2499 });
    });

    it('totals a free product as 0', () => {
        expect(priceItems([{ productId: 'prd_free', quantity: 5 }], catalog)).toMatchObject({ total: 0 });
    });

    it('names every line that fails, and not only the first', () => {
        const errors = errorsOf(() =>
            priceItems(
                [
                    { productId: 'prd_nope', quantity: 1 },
                    { productId: 'prd_lamp', quantity: 1 },
                    { productId: 'prd_missing', quantity: 1 }
                ],
                catalog
            )
        );

        expect(errors).toEqual([
            { field: 'items[0].productId', message: 'is not a product of the catalog' },
            { field: 'items[2].productId', message: 'is not a product of the catalog' }
        ]);
    });

    it('refuses a product that is on two lines, and names the first line', () => {
        const errors = errorsOf(() =>
            priceItems(
                [
                    { productId: 'prd_lamp', quantity: 1 },
                    { productId: 'prd_book', quantity: 1 },
                    { productId: 'prd_lamp', quantity: 3 }
                ],
                catalog
            )
        );

        expect(errors).toEqual([{ field: 'items[2].productId', message: 'is already on items[0]' }]);
    });

    it('refuses a product with another currency than the first line, so the order has one currency', () => {
        const errors = errorsOf(() =>
            priceItems(
                [
                    { productId: 'prd_lamp', quantity: 1 },
                    { productId: 'prd_euro', quantity: 1 }
                ],
                catalog
            )
        );

        expect(errors).toEqual([{ field: 'items[1].productId', message: 'is priced in EUR, and the order is in USD' }]);
    });

    it('takes the currency of the products, when they all agree', () => {
        expect(priceItems([{ productId: 'prd_euro', quantity: 2 }], catalog)).toMatchObject({ currency: 'EUR', total: 3000 });
    });

    it('refuses an order with no line, which the schema already refuses', () => {
        expect(errorsOf(() => priceItems([], catalog))).toEqual([{ field: 'items', message: 'must have at least one line' }]);
    });
});
