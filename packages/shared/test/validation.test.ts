import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zCreateOrderBody, zCreateOrderHeaders, zListOrdersQuery } from '../../../generated/orders-service-v1/zod.gen';
import { zCreateCustomer } from '../../../generated/customers-service-v1/zod.gen';
import { ValidationError, fieldPath, parseJsonBody, toProblem, validate, validateParameters } from '../src/index';

const correlationId = '6f0d6b1c-0c46-4d4c-b0b5-0c8d1f3f8f20';
const customerId = '3f2c4a6e-7a62-4f0e-9a43-0e0b1e1d5c11';

function thrown(run: () => unknown): ValidationError {
    try {
        run();
    } catch (error) {
        if (error instanceof ValidationError) return error;
        throw error;
    }
    throw new Error('Expected a ValidationError.');
}

describe('validate', () => {
    const order = { customerId, items: [{ productId: 'p-1', quantity: 2 }] };

    it('returns the parsed value of a valid body', () => {
        expect(validate(zCreateOrderBody, order)).toEqual(order);
    });

    it('turns a body that breaks the spec into the shared error shape, with one errors[] entry per field', () => {
        const error = thrown(() => validate(zCreateOrderBody, { customerId: 'not-a-uuid', items: [{ productId: 'p-1', quantity: 0 }, { quantity: 1 }] }));
        const problem = toProblem(error, correlationId);

        expect(problem).toMatchObject({ type: 'https://storefront.example/problems/invalid-request', status: 400, correlationId });
        expect(problem.errors?.map((e) => e.field).sort()).toEqual(['customerId', 'items[0].quantity', 'items[1].productId']);
        expect(problem.errors?.every((e) => e.message.length > 0)).toBe(true);
    });

    it('names the input when the input as a whole is wrong', () => {
        expect(thrown(() => validate(zCreateOrderBody, 'text')).errors).toEqual([{ field: 'body', message: expect.any(String) }]);
        expect(thrown(() => validate(zCreateOrderBody, 'text', 'request')).errors[0]?.field).toBe('request');
    });

    it('checks a customer body with nullable fields', () => {
        const error = thrown(() => validate(zCreateCustomer, { email: 'nobody' }));
        expect(error.errors.map((e) => e.field)).toContain('email');
    });
});

describe('fieldPath', () => {
    it.each([
        [['limit'], 'limit'],
        [['items', 0, 'quantity'], 'items[0].quantity'],
        [[0, 'name'], '[0].name'],
        [[], 'body']
    ])('writes %j as %s', (path, expected) => {
        expect(fieldPath(path, 'body')).toBe(expected);
    });
});

describe('parseJsonBody', () => {
    it('parses JSON', () => {
        expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
    });

    it.each([
        ['a missing body', undefined, 'is required'],
        ['a null body', null, 'is required'],
        ['a blank body', '  ', 'is required'],
        ['text that is not JSON', '{oops', 'must be valid JSON']
    ])('rejects %s', (_name, raw, message) => {
        expect(thrown(() => parseJsonBody(raw)).errors).toEqual([{ field: 'body', message }]);
    });
});

describe('validateParameters', () => {
    it('turns the text of a query string into the numbers the schema asks for, and applies the default', () => {
        expect(validateParameters(zListOrdersQuery, { limit: '50', status: 'PENDING' })).toEqual({ limit: 50, status: 'PENDING' });
        expect(validateParameters(zListOrdersQuery, undefined)).toEqual({ limit: 20 });
    });

    it('reports a value that is out of range or not a number', () => {
        expect(thrown(() => validateParameters(zListOrdersQuery, { limit: '500' })).errors.map((e) => e.field)).toEqual(['limit']);
        expect(thrown(() => validateParameters(zListOrdersQuery, { limit: 'many' })).errors.map((e) => e.field)).toEqual(['limit']);
    });

    it('turns true and false into booleans, also under optional and default, and leaves other text for the schema to report', () => {
        const schema = z.object({ includeDeleted: z.boolean(), dryRun: z.boolean().optional(), notify: z.boolean().default(false) });

        expect(validateParameters(schema, { includeDeleted: 'true', dryRun: 'false', notify: 'true' })).toEqual({ includeDeleted: true, dryRun: false, notify: true });
        expect(validateParameters(schema, { includeDeleted: 'false' })).toEqual({ includeDeleted: false, notify: false });
        expect(thrown(() => validateParameters(schema, { includeDeleted: 'yes', dryRun: 'TRUE' })).errors.map((e) => e.field)).toEqual(['includeDeleted', 'dryRun']);
    });

    it('reads only the names in the schema', () => {
        expect(validateParameters(zListOrdersQuery, { limit: '5', color: 'red' })).toEqual({ limit: 5 });
    });

    it('finds a header whatever its case, and reports a missing one', () => {
        expect(validateParameters(zCreateOrderHeaders, { 'idempotency-key': 'abc-123', host: 'x' })).toEqual({ 'Idempotency-Key': 'abc-123' });
        expect(thrown(() => validateParameters(zCreateOrderHeaders, {}, 'headers')).errors.map((e) => e.field)).toEqual(['Idempotency-Key']);
        expect(thrown(() => validateParameters(zCreateOrderHeaders, { 'Idempotency-Key': 'has space' })).errors.map((e) => e.field)).toEqual(['Idempotency-Key']);
    });
});
