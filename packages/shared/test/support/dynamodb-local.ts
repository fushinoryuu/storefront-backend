import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// The tests that need a DynamoDB run against the DynamoDB Local of docker-compose.yaml, which listens on 127.0.0.1:8000.
// Start it before `npm test` with: docker compose up --detach --wait
// DYNAMODB_ENDPOINT points the tests at another DynamoDB Local. CI starts the container in its workflow.

const composeEndpoint = 'http://127.0.0.1:8000';

/** The endpoint in `DYNAMODB_ENDPOINT`, or the one of the compose file when the variable is not set or is empty. */
export function resolveEndpoint(env: NodeJS.ProcessEnv): string {
    return env['DYNAMODB_ENDPOINT'] || composeEndpoint;
}

export const dynamoDbLocalEndpoint = resolveEndpoint(process.env);

export interface LocalTable {
    client: DynamoDBDocumentClient;
    tableName: string;
    /** The TTL setting of the table, as DynamoDB Local reports it. */
    timeToLiveAttribute(): Promise<string | undefined>;
}

function isConnectionRefused(error: unknown): boolean {
    const { code, cause } = error as { code?: unknown; cause?: { code?: unknown } };
    return code === 'ECONNREFUSED' || cause?.code === 'ECONNREFUSED';
}

/** A global secondary index with string keys, which projects every attribute. */
export interface LocalIndex {
    readonly name: string;
    readonly partitionKey: string;
    readonly sortKey: string;
}

/** A new table with string keys `PK` and `SK` and TTL on `expiresAt`, named so that tests never share a table. `indexes` adds global secondary indexes. */
export async function createTable(endpoint: string = dynamoDbLocalEndpoint, indexes: readonly LocalIndex[] = []): Promise<LocalTable> {
    const raw = new DynamoDBClient({ endpoint, region: 'us-west-2', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
    const tableName = `test-${randomUUID()}`;
    try {
        await raw.send(
            new CreateTableCommand({
                TableName: tableName,
                BillingMode: 'PAY_PER_REQUEST',
                AttributeDefinitions: [...new Set(['PK', 'SK', ...indexes.flatMap(({ partitionKey, sortKey }) => [partitionKey, sortKey])])].map((AttributeName) => ({ AttributeName, AttributeType: 'S' as const })),
                KeySchema: [
                    { AttributeName: 'PK', KeyType: 'HASH' },
                    { AttributeName: 'SK', KeyType: 'RANGE' }
                ],
                ...(indexes.length > 0 && {
                    GlobalSecondaryIndexes: indexes.map(({ name, partitionKey, sortKey }) => ({
                        IndexName: name,
                        KeySchema: [
                            { AttributeName: partitionKey, KeyType: 'HASH' as const },
                            { AttributeName: sortKey, KeyType: 'RANGE' as const }
                        ],
                        Projection: { ProjectionType: 'ALL' as const }
                    }))
                })
            })
        );
    } catch (error) {
        if (isConnectionRefused(error)) {
            throw new Error(`There is no DynamoDB Local at ${endpoint}. Start it with "docker compose up --detach --wait" (docker-compose.yaml), or set DYNAMODB_ENDPOINT.`, { cause: error });
        }
        throw error;
    }
    await raw.send(new UpdateTimeToLiveCommand({ TableName: tableName, TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } }));
    return {
        client: DynamoDBDocumentClient.from(raw),
        tableName,
        timeToLiveAttribute: async () => (await raw.send(new DescribeTimeToLiveCommand({ TableName: tableName }))).TimeToLiveDescription?.AttributeName
    };
}
