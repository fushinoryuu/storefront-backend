import { catalog } from './catalog';
import { createOrderHandler } from './handlers';
import { newOrderId } from './place-order';
import { repositoryFromEnvironment } from './repository';
import { logger } from './runtime';

// The entry of the function behind `POST /v1/orders`.
export const handler = createOrderHandler({ repository: repositoryFromEnvironment(), catalog, logger, now: () => new Date(), newOrderId });
