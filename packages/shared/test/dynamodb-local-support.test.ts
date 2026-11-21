import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createTable, resolveEndpoint } from './support/dynamodb-local';

// These tests need no DynamoDB Local: they check how the tests find it, and what they say when it is not there.

/** A port that nothing listens on: the OS gives a free one, and it is closed again before the test uses it. */
async function closedPort(): Promise<number> {
    const server = createTcpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

describe('resolveEndpoint', () => {
    it('uses DYNAMODB_ENDPOINT when it is set', () => {
        expect(resolveEndpoint({ DYNAMODB_ENDPOINT: 'http://localhost:9000' })).toBe('http://localhost:9000');
    });

    it('uses the endpoint of the compose file when it is not set, or is empty', () => {
        const composePort = /127\.0\.0\.1:(\d+):8000/.exec(readFileSync(new URL('../../../docker-compose.yaml', import.meta.url), 'utf8'))?.[1];
        expect(composePort).toBeDefined();
        expect(resolveEndpoint({})).toBe(`http://127.0.0.1:${composePort}`);
        expect(resolveEndpoint({ DYNAMODB_ENDPOINT: '' })).toBe(`http://127.0.0.1:${composePort}`);
    });
});

describe('createTable when there is no DynamoDB Local', () => {
    it('says which endpoint has none, and the command that starts it', async () => {
        const endpoint = `http://127.0.0.1:${await closedPort()}`;
        const error: unknown = await createTable(endpoint).then(
            () => undefined,
            (reason: unknown) => reason
        );
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain(`There is no DynamoDB Local at ${endpoint}`);
        expect(message).toContain('docker compose up --detach --wait');
        expect(message).toContain('DYNAMODB_ENDPOINT');
    });

    it('does not take any other failure for a missing DynamoDB Local', async () => {
        const server = createHttpServer((_request, response) => {
            response.writeHead(500, { 'content-type': 'application/x-amz-json-1.0' });
            response.end(JSON.stringify({ __type: 'com.amazon.coral.service#InternalFailure', message: 'broken' }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        try {
            const error: unknown = await createTable(`http://127.0.0.1:${port}`).then(
                () => undefined,
                (reason: unknown) => reason
            );
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).not.toContain('There is no DynamoDB Local');
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
