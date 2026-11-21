import { describe, expect, it, vi } from 'vitest';
import { zGetHealthResponse as customersHealth, zGetVersionResponse as customersVersion, zProblem } from '../../../generated/customers-service-v0/zod.gen';
import { zGetHealthResponse as ordersHealth, zGetVersionResponse as ordersVersion } from '../../../generated/orders-service-v0/zod.gen';
import { zGetHealthResponse as shippingHealth, zGetVersionResponse as shippingVersion } from '../../../generated/shipping-service-v0/zod.gen';
import { correlationIdHeader } from '../src/correlation';
import { handleOperations } from '../src/operations';

const env = { STAGE: 'dev', BUILD_ID: 'abc1234-dirty', SPEC_VERSIONS: JSON.stringify({ v0: '0.2.0', v1: '0.3.0', v2: '0.1.0' }) };
const health = { httpMethod: 'GET', resource: '/v0/health' };
const version = { httpMethod: 'GET', resource: '/v0/version' };

// The three bundles carry the same schemas, because the operational routes come from the shared path items.
describe.each([
    ['customers', customersHealth, customersVersion],
    ['orders', ordersHealth, ordersVersion],
    ['shipping', shippingHealth, shippingVersion]
])('the answers of the operational routes against the %s spec', (_service, zHealth, zVersion) => {
    it('answers GET /v0/health with a body that matches the spec', () => {
        const response = handleOperations(health, env);

        expect(response.statusCode).toBe(200);
        expect(zHealth.parse(JSON.parse(response.body))).toEqual({ status: 'ok' });
    });

    it('answers GET /v0/version with the build id, the stage and every version of the API', () => {
        const response = handleOperations(version, env);

        expect(response.statusCode).toBe(200);
        expect(zVersion.parse(JSON.parse(response.body))).toEqual({ buildId: 'abc1234-dirty', stage: 'dev', specVersions: { v0: '0.2.0', v1: '0.3.0', v2: '0.1.0' } });
    });
});

describe('handleOperations', () => {
    it('answers health when nothing is configured, because it depends on nothing', () => {
        expect(handleOperations(health, {}).statusCode).toBe(200);
    });

    it('sends back the correlation id of the request, or a new one', () => {
        const given = handleOperations({ ...health, headers: { 'X-Correlation-Id': 'trace-1' } }, env);
        const generated = handleOperations(version, env);

        expect(given.headers[correlationIdHeader]).toBe('trace-1');
        expect(given.headers['content-type']).toBe('application/json');
        expect(generated.headers[correlationIdHeader]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it.each([
        ['another route', { httpMethod: 'GET', resource: '/v0/health/ready' }],
        ['another method', { httpMethod: 'POST', resource: '/v0/health' }],
        ['an event with no route', {}]
    ])('answers %s with a 404 in the shape of the spec, and reports it', (_name, event) => {
        const onError = vi.fn();
        const response = handleOperations({ ...event, headers: { 'x-correlation-id': 'trace-2' } }, env, onError);

        expect(response.statusCode).toBe(404);
        expect(zProblem.parse(JSON.parse(response.body))).toMatchObject({ status: 404, correlationId: 'trace-2' });
        expect(onError).toHaveBeenCalledWith(expect.any(Error), 'trace-2');
    });

    it.each([['STAGE'], ['BUILD_ID'], ['SPEC_VERSIONS']])('answers a version with a 500 and no detail when %s is missing', (name) => {
        const onError = vi.fn();
        const response = handleOperations(version, { ...env, [name]: undefined }, onError);

        expect(response.statusCode).toBe(500);
        expect(zProblem.parse(JSON.parse(response.body)).detail).toBeUndefined();
        expect(onError).toHaveBeenCalledOnce();
    });
});
