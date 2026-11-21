import { createLogger } from './logger';
import { handleOperations } from './operations';
import type { OperationsEvent } from './operations';

// The entry of the function that `ServiceApi` adds. It is not exported from the package: a service never imports it.
const logger = createLogger({ service: process.env.SERVICE_NAME ?? 'unknown', stage: process.env.STAGE ?? 'unknown' });

export const handler = async (event: OperationsEvent, context: { awsRequestId: string }) => handleOperations(event, process.env, (error, correlationId) => logger.forRequest({ correlationId, requestId: context.awsRequestId }).error('operational request failed', { error }));
