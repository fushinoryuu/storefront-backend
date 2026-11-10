import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Tests that need DynamoDB Local run when DYNAMODB_ENDPOINT is set (for example http://localhost:8000) and always in CI, where a missing endpoint fails them instead of skipping them quietly.
// Start it with: docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2 -jar DynamoDBLocal.jar -inMemory -sharedDb

export const dynamoDbLocalEndpoint = process.env['DYNAMODB_ENDPOINT'];
export const needsDynamoDbLocal = dynamoDbLocalEndpoint !== undefined || process.env['CI'] === 'true';

export interface LocalTable {
    client: DynamoDBDocumentClient;
    tableName: string;
    /** The TTL setting of the table, as DynamoDB Local reports it. */
    timeToLiveAttribute(): Promise<string | undefined>;
}

/** A new table with string keys `PK` and `SK` and TTL on `expiresAt`, named so that tests never share a table. */
export async function createTable(): Promise<LocalTable> {
    if (dynamoDbLocalEndpoint === undefined) throw new Error('DYNAMODB_ENDPOINT is not set, so there is no DynamoDB Local to test against.');
    const raw = new DynamoDBClient({ endpoint: dynamoDbLocalEndpoint, region: 'us-west-2', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
    const tableName = `test-${randomUUID()}`;
    await raw.send(
        new CreateTableCommand({
            TableName: tableName,
            BillingMode: 'PAY_PER_REQUEST',
            AttributeDefinitions: [
                { AttributeName: 'PK', AttributeType: 'S' },
                { AttributeName: 'SK', AttributeType: 'S' }
            ],
            KeySchema: [
                { AttributeName: 'PK', KeyType: 'HASH' },
                { AttributeName: 'SK', KeyType: 'RANGE' }
            ]
        })
    );
    await raw.send(new UpdateTimeToLiveCommand({ TableName: tableName, TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } }));
    return {
        client: DynamoDBDocumentClient.from(raw),
        tableName,
        timeToLiveAttribute: async () => (await raw.send(new DescribeTimeToLiveCommand({ TableName: tableName }))).TimeToLiveDescription?.AttributeName
    };
}
