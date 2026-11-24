import { getOrderHandler } from './handlers';
import { repositoryFromEnvironment } from './repository';
import { logger } from './runtime';

// The entry of the function behind `GET /v1/orders/{orderId}`.
export const handler = getOrderHandler({ repository: repositoryFromEnvironment(), logger });
