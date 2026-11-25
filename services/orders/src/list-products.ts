import { catalog } from './catalog';
import { listProductsHandler } from './handlers';
import { logger } from './runtime';

// The entry of the function behind `GET /v1/products`.
export const handler = listProductsHandler({ catalog, logger });
