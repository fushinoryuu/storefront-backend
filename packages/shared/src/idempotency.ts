import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Deduplication with a conditional write. The table needs string keys `PK` and `SK` and a TTL setting on `expiresAt` (epoch seconds), which the stack that owns the table turns on.

export const idempotencyTtlAttribute = 'expiresAt';

const sortKey = 'IDEMPOTENCY';

export interface IdempotencyOptions {
    client: DynamoDBDocumentClient;
    tableName: string;
    /** How long a key is remembered, in seconds. */
    ttlSeconds: number;
    /** The clock, in milliseconds. Tests replace it. */
    now?: () => number;
}

export interface Idempotency {
    /** True the first time a key is seen, false for a repeat. A key whose time has run out counts as new, because DynamoDB removes expired items some time after `expiresAt`. */
    claim(key: string): Promise<boolean>;
    /** Forgets a key. Call it when the work failed after `claim`, so that a retry or a redelivery is not taken for a repeat. */
    release(key: string): Promise<void>;
}

/** Remembers event ids and idempotency keys. Use the id of an event or the `Idempotency-Key` of a request as the key. */
export function createIdempotency({ client, tableName, ttlSeconds, now = Date.now }: IdempotencyOptions): Idempotency {
    const itemKey = (key: string) => {
        if (key === '') throw new Error('An idempotency key cannot be empty.');
        return { PK: `IDEMPOTENCY#${key}`, SK: sortKey };
    };

    return {
        async claim(key) {
            const seconds = Math.floor(now() / 1000);
            try {
                await client.send(
                    new PutCommand({
                        TableName: tableName,
                        Item: { ...itemKey(key), [idempotencyTtlAttribute]: seconds + ttlSeconds },
                        ConditionExpression: `attribute_not_exists(PK) OR ${idempotencyTtlAttribute} <= :now`,
                        ExpressionAttributeValues: { ':now': seconds }
                    })
                );
                return true;
            } catch (error) {
                if (error instanceof ConditionalCheckFailedException) return false;
                throw error;
            }
        },

        async release(key) {
            await client.send(new DeleteCommand({ TableName: tableName, Key: itemKey(key) }));
        }
    };
}
