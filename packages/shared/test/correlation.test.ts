import { describe, expect, it } from 'vitest';
import { buildEvent } from '../../events/src/index';
import { correlationHeaders, correlationIdHeader, getCorrelationId } from '../src/index';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('getCorrelationId', () => {
    it('keeps the id of a request that has one', () => {
        expect(getCorrelationId({ 'x-correlation-id': 'req-123.abc:7' })).toBe('req-123.abc:7');
    });

    it('finds the header whatever its case, because API Gateway passes headers as the client wrote them', () => {
        expect(getCorrelationId({ 'X-Correlation-Id': 'from-client' })).toBe('from-client');
        expect(getCorrelationId({ 'X-CORRELATION-ID': 'from-client' })).toBe('from-client');
    });

    it('trims the value', () => {
        expect(getCorrelationId({ 'x-correlation-id': '  padded  ' })).toBe('padded');
    });

    it.each([
        ['no headers', undefined],
        ['null headers', null],
        ['empty headers', {}],
        ['other headers only', { 'x-api-key': 'abc' }],
        ['an undefined value', { 'x-correlation-id': undefined }]
    ])('generates a new UUID for %s', (_name, headers) => {
        expect(getCorrelationId(headers)).toMatch(uuid);
    });

    it('generates a different id each time', () => {
        expect(getCorrelationId({})).not.toBe(getCorrelationId({}));
    });

    it.each([
        ['an empty value', ''],
        ['only spaces', '   '],
        ['spaces inside', 'two words'],
        ['a line break, which could forge a log line', 'abc\n{"level":"ERROR"}'],
        ['markup', '<script>'],
        ['more than 128 characters', 'a'.repeat(129)]
    ])('replaces a header with %s', (_name, value) => {
        const id = getCorrelationId({ 'x-correlation-id': value });
        expect(id).toMatch(uuid);
        expect(id).not.toBe(value);
    });

    it('accepts 128 characters', () => {
        const value = 'a'.repeat(128);
        expect(getCorrelationId({ 'x-correlation-id': value })).toBe(value);
    });
});

describe('carrying the id on', () => {
    it('responses and downstream calls, with the header the requests use', () => {
        expect(correlationHeaders('abc')).toEqual({ [correlationIdHeader]: 'abc' });
        expect(correlationIdHeader).toBe('x-correlation-id');
    });

    it('event envelopes, so one request can be followed from the API into the events it causes', () => {
        const correlationId = getCorrelationId({ 'x-correlation-id': 'trace-me' });
        const event = buildEvent('OrderCancelled', { orderId: 'ord_1', customerId: '3f6f6f64-6a0e-4a53-9c58-0c1f6c2f6a11' }, { correlationId });
        expect(event.correlationId).toBe('trace-me');
    });
});
