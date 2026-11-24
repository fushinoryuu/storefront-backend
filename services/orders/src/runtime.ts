import { createLogger } from '../../../packages/shared/src';

// What the entries of the functions share: the logger, made once per execution environment, when the module loads.

export const logger = createLogger({ service: process.env['SERVICE_NAME'] ?? 'orders', stage: process.env['STAGE'] ?? 'unknown' });
