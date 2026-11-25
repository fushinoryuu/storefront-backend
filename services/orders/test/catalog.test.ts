import { describe, expect, it } from 'vitest';
import { zProductPage } from '../../../generated/orders-service-v1/zod.gen';
import { ValidationError } from '../../../packages/shared/src';
import { catalog, createCatalog } from '../src/catalog';

const product = (n: number) => ({ productId: `prd_${n}`, name: `Product ${n}`, unitPrice: 100 * n, currency: 'USD' });
const five = createCatalog([1, 2, 3, 4, 5].map(product));

describe('the catalog of the service', () => {
    it('holds about a dozen products that match the Product schema of the spec, with prices in whole minor units', () => {
        const { items } = catalog.page(100);

        expect(items.length).toBeGreaterThanOrEqual(10);
        expect(zProductPage.parse({ items, nextCursor: null })).toBeDefined();
        expect(items.every(({ unitPrice }) => Number.isInteger(unitPrice))).toBe(true);
    });

    it('has the products that the examples of the spec use, at the prices of the examples', () => {
        expect(catalog.find('prd_3a7f1c')).toEqual({ productId: 'prd_3a7f1c', name: 'Desk lamp', unitPrice: 2499, currency: 'USD' });
        expect(catalog.find('prd_9d2e4b')).toMatchObject({ name: 'Notebook', unitPrice: 1299 });
    });
});

describe('createCatalog', () => {
    it('finds a product by id, and has none for an id it does not know', () => {
        expect(five.find('prd_3')).toEqual(product(3));
        expect(five.find('prd_9')).toBeUndefined();
    });

    it.each([
        ['a product that has no price', [{ productId: 'prd_1', name: 'One', currency: 'USD' }]],
        ['a price that is not a whole number', [{ ...product(1), unitPrice: 9.99 }]],
        ['a negative price', [{ ...product(1), unitPrice: -1 }]],
        ['a currency that is not a three-letter code', [{ ...product(1), currency: 'usd' }]],
        ['no product at all', []],
        ['something that is not a list', { products: [] }]
    ])('refuses %s, so a broken file stops the function when it starts', (_name, data) => {
        expect(() => createCatalog(data)).toThrow();
    });

    it('refuses two products with the same id', () => {
        expect(() => createCatalog([product(1), product(1)])).toThrow('same id');
    });
});

describe('Catalog.page', () => {
    it('gives the first products in the order of the list, with a cursor when there are more', () => {
        const { items, nextCursor } = five.page(2);

        expect(items).toEqual([product(1), product(2)]);
        expect(nextCursor).toEqual(expect.any(String));
    });

    it('continues after the cursor, and ends with a null cursor on the last page', () => {
        const first = five.page(2);
        const second = five.page(2, first.nextCursor!);
        const third = five.page(2, second.nextCursor!);

        expect(second.items).toEqual([product(3), product(4)]);
        expect(third).toEqual({ items: [product(5)], nextCursor: null });
    });

    it('has a null cursor when the page holds the last product, and not an empty page after it', () => {
        expect(five.page(5)).toEqual({ items: five.page(100).items, nextCursor: null });
        expect(five.page(100).nextCursor).toBeNull();
    });

    it('visits every product once when the pages are followed to the end', () => {
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
            const page = catalog.page(5, cursor);
            seen.push(...page.items.map(({ productId }) => productId));
            cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);

        expect(seen).toEqual(catalog.page(100).items.map(({ productId }) => productId));
    });

    it.each([
        ['text that is not a cursor', 'nope'],
        ['a cursor with the wrong content', Buffer.from(JSON.stringify({ first: 'prd_1' })).toString('base64url')],
        ['a cursor for a product that is not in the list', Buffer.from(JSON.stringify({ last: 'prd_9' })).toString('base64url')]
    ])('refuses %s with a 400 that names the cursor', (_name, cursor) => {
        const failure = (() => {
            try {
                five.page(2, cursor);
            } catch (error) {
                return error;
            }
        })();

        expect(failure).toBeInstanceOf(ValidationError);
        expect((failure as ValidationError).errors).toEqual([{ field: 'cursor', message: 'is not a cursor of this list' }]);
    });
});
