import { describe, expect, it } from 'vitest';
import { zProblem } from '../../../generated/customers-service-v0/zod.gen';
import { ForbiddenError, problemResponse, requireAdminKey } from '../src/index';

const adminKeyId = 'adm1nk3y1d';
const asCaller = (apiKeyId: string | null | undefined) => ({ requestContext: { identity: { apiKeyId } } });

describe('requireAdminKey', () => {
    it('accepts the admin key id', () => {
        expect(() => requireAdminKey(asCaller(adminKeyId), adminKeyId)).not.toThrow();
    });

    it.each([
        ['the tests key', 'tests1d'],
        ['the services key', 'services1d']
    ])('refuses %s with a ForbiddenError', (_name, keyId) => {
        expect(() => requireAdminKey(asCaller(keyId), adminKeyId)).toThrow(ForbiddenError);
    });

    it.each([
        ['no key id', asCaller(undefined)],
        ['a null key id', asCaller(null)],
        ['an empty key id', asCaller('')],
        ['no identity', { requestContext: {} }],
        ['no request context', {}]
    ])('refuses a request with %s', (_name, event) => {
        expect(() => requireAdminKey(event, adminKeyId)).toThrow(ForbiddenError);
    });

    it('answers a refused caller with the shared error shape, a 403', () => {
        let thrown: unknown;
        try {
            requireAdminKey(asCaller('tests1d'), adminKeyId);
        } catch (error) {
            thrown = error;
        }
        const response = problemResponse(thrown, 'corr-1');

        expect(response.statusCode).toBe(403);
        expect(zProblem.parse(JSON.parse(response.body))).toMatchObject({ status: 403, correlationId: 'corr-1' });
    });

    it.each([undefined, ''])('does not let a request with no key id match an admin key id of %j: that is a mistake of the service, not a 403', (missing) => {
        const call = () => requireAdminKey(asCaller(undefined), missing);

        expect(call).toThrow(/admin API key/);
        expect(call).not.toThrow(ForbiddenError);
        expect(problemResponse(new Error('x'), 'corr-1').statusCode).toBe(500);
    });
});
