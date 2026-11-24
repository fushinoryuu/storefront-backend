import { idempotencyTtlAttribute } from '../../../packages/shared/src';

/** One global secondary index of the table: its name and the attributes that make its key. */
export interface TableIndex {
    readonly name: string;
    readonly partitionKey: string;
    readonly sortKey: string;
}

/**
 * The shape of the orders table, described in docs/services/orders-table-design.md. The stack builds the table from this, and the repository tests build a local one the same way,
 * so a change to the shape is made here and every user of it sees it. Both indexes project every attribute.
 */
export const ordersTable = {
    partitionKey: 'PK',
    sortKey: 'SK',
    /** The attribute that DynamoDB reads to remove an item once its time (epoch seconds) has passed. Idempotency items have it, and orders do not. */
    ttlAttribute: idempotencyTtlAttribute,
    indexes: {
        /** Orders of a customer, newest first (pattern 2). */
        byCustomer: { name: 'GSI1', partitionKey: 'GSI1PK', sortKey: 'GSI1SK' },
        /** Orders in a status, newest first (pattern 3). */
        byStatus: { name: 'GSI2', partitionKey: 'GSI2PK', sortKey: 'GSI2SK' }
    }
} as const satisfies { partitionKey: string; sortKey: string; ttlAttribute: string; indexes: Record<string, TableIndex> };
