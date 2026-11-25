import type { z } from 'zod';
import type { zOrder } from '../../../generated/orders-service-v1/zod.gen';

/** An order as the API shows it (the `Order` schema of the spec). */
export type Order = z.output<typeof zOrder>;
