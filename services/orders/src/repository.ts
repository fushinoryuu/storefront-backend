import { DynamoDBClient, TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { zOrder } from '../../../generated/orders-service-v1/zod.gen';
import type { IdempotencyRecord } from './idempotency';
import type { Order } from './order';
import { ordersTable } from './table';

const { partitionKey, sortKey, ttlAttribute, indexes } = ordersTable;

export interface PlaceOrderInput {
    readonly order: Order;
    /** The `Idempotency-Key` of the request. */
    readonly key: string;
    readonly requestHash: string;
    /** Kept on the order item, for the events that are made from it later. It is not part of the order that the API shows. */
    readonly correlationId: string;
    /** Epoch seconds. A key that has expired counts as free, and this one lasts until `expiresAt`. */
    readonly nowSeconds: number;
    readonly expiresAt: number;
}

export interface OrdersRepository {
    /** The order with this id, read consistently so an order that was just placed is found. */
    getOrder(orderId: string): Promise<Order | undefined>;
    /** What is remembered of a key, expired or not. `decideKey` says whether it still counts. */
    getIdempotencyRecord(key: string): Promise<IdempotencyRecord | undefined>;
    /**
     * Writes the order and the idempotency record together, or neither. It answers `key-taken` when the key is held by a record that has not expired,
     * or by a request that is writing it at this moment. The caller then reads the record and decides what the repeat means.
     */
    placeOrder(input: PlaceOrderInput): Promise<'placed' | 'key-taken'>;
}

const orderKey = (orderId: string) => ({ [partitionKey]: `ORDER#${orderId}`, [sortKey]: 'META' });
const idempotencyKey = (key: string) => ({ [partitionKey]: `IDEM#${key}`, [sortKey]: 'META' });

const zRecord = z.object({ requestHash: z.string(), order: zOrder, expiresAt: z.number() });

export function createOrdersRepository({ client, tableName }: { client: DynamoDBDocumentClient; tableName: string }): OrdersRepository {
    return {
        async getOrder(orderId) {
            const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: orderKey(orderId), ConsistentRead: true }));
            return Item === undefined ? undefined : zOrder.parse(Item);
        },

        async getIdempotencyRecord(key) {
            const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: idempotencyKey(key), ConsistentRead: true }));
            return Item === undefined ? undefined : zRecord.parse(Item);
        },

        async placeOrder({ order, key, requestHash, correlationId, nowSeconds, expiresAt }) {
            const sortValue = `${order.createdAt}#${order.orderId}`;
            const orderItem = {
                ...orderKey(order.orderId),
                [indexes.byCustomer.partitionKey]: `CUSTOMER#${order.customerId}`,
                [indexes.byCustomer.sortKey]: sortValue,
                [indexes.byStatus.partitionKey]: `STATUS#${order.status}`,
                [indexes.byStatus.sortKey]: sortValue,
                ...order,
                correlationId
            };
            try {
                await client.send(
                    new TransactWriteCommand({
                        TransactItems: [
                            { Put: { TableName: tableName, Item: orderItem, ConditionExpression: `attribute_not_exists(${partitionKey})` } },
                            {
                                Put: {
                                    TableName: tableName,
                                    Item: { ...idempotencyKey(key), requestHash, order, [ttlAttribute]: expiresAt },
                                    ConditionExpression: `attribute_not_exists(${partitionKey}) OR ${ttlAttribute} <= :now`,
                                    ExpressionAttributeValues: { ':now': nowSeconds }
                                }
                            }
                        ]
                    })
                );
                return 'placed';
            } catch (error) {
                // The reasons come in the order of the items. A refused order item (an id that exists already) is not a repeat, so it is thrown.
                if (error instanceof TransactionCanceledException) {
                    const codes = (error.CancellationReasons ?? []).map((reason) => reason.Code);
                    if (codes[1] === 'ConditionalCheckFailed' || codes.includes('TransactionConflict')) return 'key-taken';
                }
                if (error instanceof TransactionConflictException) return 'key-taken';
                throw error;
            }
        }
    };
}

/** The repository of the table in `TABLE_NAME`, which the stack sets on the functions that are given the table. It throws when the variable is missing, so such a function stops when it starts. */
export function repositoryFromEnvironment(): OrdersRepository {
    const tableName = process.env['TABLE_NAME'];
    if (!tableName) throw new Error('The function needs the TABLE_NAME variable.');
    return createOrdersRepository({ client: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName });
}
