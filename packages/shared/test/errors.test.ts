import { readFileSync } from 'node:fs';
import { parseYaml } from '@redocly/openapi-core';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError, problemKinds, problemResponse, problemTypeBase, toProblem } from '../src/index';

const correlationId = '6f0d6b1c-0c46-4d4c-b0b5-0c8d1f3f8f10';

// The kinds a service can throw, with the status and the problem type the specs document for them.
const documented: [string, DomainError, number, string][] = [
    ['ValidationError', new ValidationError([{ field: 'limit', message: 'must be at most 100' }]), 400, 'invalid-request'],
    ['ForbiddenError', new ForbiddenError(), 403, 'forbidden'],
    ['NotFoundError', new NotFoundError('There is no shipment with this id.'), 404, 'not-found'],
    ['ConflictError', new ConflictError(), 409, 'conflict'],
    ['ServiceUnavailableError', new ServiceUnavailableError('The customers service did not answer.', 30), 503, 'service-unavailable'],
    ['a DomainError with a kind of its own', new DomainError({ slug: 'unknown-customer', title: 'Unknown customer', status: 422 }, 'There is no customer with this id.'), 422, 'unknown-customer']
];

describe('mapping a domain error to a problem', () => {
    it.each(documented)('%s is %i with the type %s', (_name, error, status, slug) => {
        const problem = toProblem(error, correlationId);
        expect(problem.status).toBe(status);
        expect(problem.type).toBe(`${problemTypeBase}/${slug}`);
        expect(problem.title).toBe(error.kind.title);
        expect(problem.correlationId).toBe(correlationId);
        expect(problemResponse(error, correlationId).statusCode).toBe(status);
    });

    it('knows the same statuses the shared spec responses show', () => {
        const kinds = Object.values(problemKinds).map((kind) => [kind.slug, kind.status]);
        expect(kinds).toEqual([
            ['invalid-request', 400],
            ['forbidden', 403],
            ['not-found', 404],
            ['conflict', 409],
            ['service-unavailable', 503],
            ['internal-error', 500]
        ]);
    });

    it('puts the detail in, and leaves it out when there is none', () => {
        expect(toProblem(new NotFoundError('There is no shipment with this id.'), correlationId).detail).toBe('There is no shipment with this id.');
        expect(toProblem(new DomainError(problemKinds.conflict), correlationId)).not.toHaveProperty('detail');
    });

    it('lists the failed fields for a validation error, and only for that', () => {
        const fields = [
            { field: 'items[0].quantity', message: 'must be at least 1' },
            { field: 'currency', message: 'is required' }
        ];
        expect(toProblem(new ValidationError(fields), correlationId).errors).toEqual(fields);
        for (const [, error] of documented.filter(([name]) => name !== 'ValidationError')) {
            expect(toProblem(error, correlationId)).not.toHaveProperty('errors');
        }
    });

    it('keeps the class name and the cause for the logs', () => {
        const cause = new Error('connection refused');
        const error = new ServiceUnavailableError('The customers service did not answer.', 30, { cause });
        expect(error.name).toBe('ServiceUnavailableError');
        expect(error.cause).toBe(cause);
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toBeInstanceOf(Error);
    });
});

describe('an error that is not a domain error', () => {
    it.each([new Error('password=hunter2 for db.internal'), new TypeError('x is undefined'), 'a string', null, undefined])('is a 500 that tells the caller nothing about it (%s)', (error) => {
        const problem = toProblem(error, correlationId);
        expect(problem).toEqual({ type: `${problemTypeBase}/internal-error`, title: 'Internal server error', status: 500, correlationId });
        expect(problemResponse(error, correlationId).body).not.toMatch(/hunter2|undefined/);
    });
});

describe('the error response', () => {
    it('has the status, a JSON body and the correlation id header', () => {
        const response = problemResponse(new NotFoundError(), correlationId);
        expect(response.statusCode).toBe(404);
        expect(response.headers).toEqual({ 'content-type': 'application/json', 'x-correlation-id': correlationId });
        expect(JSON.parse(response.body)).toEqual(toProblem(new NotFoundError(), correlationId));
    });

    it('has Retry-After on a 503 that says how long to wait, and on no other response', () => {
        expect(problemResponse(new ServiceUnavailableError('down', 30), correlationId).headers['retry-after']).toBe('30');
        expect(problemResponse(new ServiceUnavailableError('down', 0), correlationId).headers['retry-after']).toBe('0');
        expect(problemResponse(new ServiceUnavailableError('down'), correlationId).headers).not.toHaveProperty('retry-after');
        expect(problemResponse(new ConflictError(), correlationId).headers).not.toHaveProperty('retry-after');
    });
});

describe('the Problem schema in specs/shared/components.yaml', () => {
    const components = parseYaml(readFileSync(new URL('../../../specs/shared/components.yaml', import.meta.url), 'utf8'));
    // The spec uses OpenAPI keywords (`example`) that JSON Schema does not know, so strict mode is off.
    const ajv = new Ajv({ strict: false, allErrors: true });
    ajv.addSchema(components as object, 'components');
    const validate = ajv.getSchema('components#/components/schemas/Problem');

    function violations(body: unknown): string[] {
        if (!validate) throw new Error('The Problem schema was not found in specs/shared/components.yaml');
        return validate(body) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
    }

    it.each(documented)('accepts the problem for %s', (_name, error) => {
        expect(violations(JSON.parse(problemResponse(error, correlationId).body))).toEqual([]);
    });

    it('accepts the problem for an unexpected error', () => {
        expect(violations(JSON.parse(problemResponse(new Error('boom'), correlationId).body))).toEqual([]);
    });

    it('would reject a problem that is wrong, so the checks above mean something', () => {
        const good = toProblem(new ValidationError([{ field: 'limit', message: 'bad' }]), correlationId);
        const withoutCorrelationId = Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'correlationId'));
        expect(violations(withoutCorrelationId).join()).toMatch(/correlationId/);
        expect(violations({ ...good, status: '400' }).join()).toMatch(/status/);
        expect(violations({ ...good, errors: [{ field: 'limit' }] }).join()).toMatch(/message/);
    });
});
