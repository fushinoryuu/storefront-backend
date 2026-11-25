import { z } from 'zod';
import { zProduct } from '../../../generated/orders-service-v1/zod.gen';
import { ValidationError } from '../../../packages/shared/src';
import products from '../data/products.json';

export type Product = z.output<typeof zProduct>;

export interface ProductPage {
    items: Product[];
    nextCursor: string | null;
}

export interface Catalog {
    /** The product with this id, or undefined when the catalog has none. */
    find(productId: string): Product | undefined;
    /** At most `limit` products in the order of the file, starting after the product that `cursor` names. A cursor that this catalog did not give out is a `ValidationError`. */
    page(limit: number, cursor?: string): ProductPage;
}

const encodeCursor = (productId: string) => Buffer.from(JSON.stringify({ last: productId })).toString('base64url');

function decodeCursor(cursor: string): string | undefined {
    try {
        const { last } = z.object({ last: z.string() }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
        return last;
    } catch {
        return undefined;
    }
}

/** The catalog of a list of products, which must all be valid and have different ids. It throws when they are not, so a broken file stops the function at start-up and not on the first order. */
export function createCatalog(data: unknown): Catalog {
    const list = z.array(zProduct).min(1).parse(data);
    const byId = new Map(list.map((product) => [product.productId, product]));
    if (byId.size !== list.length) throw new Error('Two products of the catalog have the same id.');

    return {
        find: (productId) => byId.get(productId),
        page(limit, cursor) {
            const last = cursor === undefined ? undefined : decodeCursor(cursor);
            const start = last === undefined ? 0 : list.findIndex((product) => product.productId === last) + 1;
            if (cursor !== undefined && start === 0) throw new ValidationError([{ field: 'cursor', message: 'is not a cursor of this list' }]);
            const items = list.slice(start, start + limit);
            const lastItem = items.at(-1);
            return { items, nextCursor: lastItem !== undefined && start + limit < list.length ? encodeCursor(lastItem.productId) : null };
        }
    };
}

/** The catalog of `data/products.json`. Prices always come from here and never from a request. */
export const catalog: Catalog = createCatalog(products);
