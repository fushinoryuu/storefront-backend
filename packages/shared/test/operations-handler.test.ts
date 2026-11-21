import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Lambda entry of the function that `ServiceApi` adds. It reads its variables and creates its logger when the module loads, so each test sets them first and imports a fresh copy.

let written: string[];

beforeEach(() => {
    vi.stubEnv('SERVICE_NAME', 'customers');
    vi.stubEnv('STAGE', 'dev');
    vi.stubEnv('BUILD_ID', 'abc1234');
    vi.stubEnv('SPEC_VERSIONS', JSON.stringify({ v0: '0.2.0', v1: '0.3.0' }));
    vi.stubEnv('POWERTOOLS_LOG_LEVEL', 'INFO');
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
    });
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const context = { awsRequestId: 'req-1' };
const logLines = () =>
    written
        .join('')
        .split('\n')
        .filter((text) => text.trim() !== '')
        .map((text) => JSON.parse(text) as Record<string, unknown>);
const loadHandler = async () => (await import('../src/operations-handler')).handler;

describe('the entry of the operations function', () => {
    it('answers health with a 200 and logs nothing', async () => {
        const response = await (await loadHandler())({ httpMethod: 'GET', resource: '/v0/health' }, context);

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
        expect(logLines()).toEqual([]);
    });

    it('answers version from the variables of the function', async () => {
        const response = await (await loadHandler())({ httpMethod: 'GET', resource: '/v0/version' }, context);

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ buildId: 'abc1234', stage: 'dev', specVersions: { v0: '0.2.0', v1: '0.3.0' } });
    });

    it('answers another route with a 404, and logs the error with the ids of the request, the service and the stage', async () => {
        const response = await (await loadHandler())({ httpMethod: 'GET', resource: '/v0/other', headers: { 'x-correlation-id': 'corr-1' } }, context);

        expect(response.statusCode).toBe(404);
        expect(logLines()).toHaveLength(1);
        expect(logLines()[0]).toMatchObject({ level: 'ERROR', message: 'operational request failed', service: 'customers', stage: 'dev', correlationId: 'corr-1', requestId: 'req-1' });
    });
});
