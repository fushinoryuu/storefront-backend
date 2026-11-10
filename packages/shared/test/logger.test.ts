import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, redact } from '../src/index';

type Line = Record<string, unknown>;

let written: string[];

beforeEach(() => {
    vi.stubEnv('POWERTOOLS_LOG_LEVEL', 'DEBUG');
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function lines(): Line[] {
    return written
        .join('')
        .split('\n')
        .filter((text) => text.trim() !== '')
        .map((text) => JSON.parse(text) as Line);
}

const context = { correlationId: 'corr-1', requestId: 'req-1' };

function requestLogger() {
    return createLogger({ service: 'orders', stage: 'dev' }).forRequest(context);
}

describe('the standard keys', () => {
    it.each(['debug', 'info', 'warn', 'error'] as const)('are on every %s line', (level) => {
        requestLogger()[level]('something happened');
        expect(lines()).toHaveLength(1);
        expect(lines()[0]).toMatchObject({ message: 'something happened', level: level.toUpperCase(), service: 'orders', stage: 'dev', correlationId: 'corr-1', requestId: 'req-1' });
    });

    it('are on lines that carry fields too, and the fields are kept', () => {
        requestLogger().info('order placed', { orderId: 'ord_1', itemCount: 2 });
        expect(lines()[0]).toMatchObject({ service: 'orders', stage: 'dev', correlationId: 'corr-1', requestId: 'req-1', orderId: 'ord_1', itemCount: 2 });
    });

    it('belong to one request each, so two requests do not mix ids', () => {
        const logger = createLogger({ service: 'shipping', stage: 'prod' });
        const first = logger.forRequest({ correlationId: 'a', requestId: 'r1' });
        const second = logger.forRequest({ correlationId: 'b', requestId: 'r2' });
        first.info('one');
        second.info('two');
        first.info('three');
        expect(lines().map((line) => [line.message, line.correlationId, line.requestId, line.service, line.stage])).toEqual([
            ['one', 'a', 'r1', 'shipping', 'prod'],
            ['two', 'b', 'r2', 'shipping', 'prod'],
            ['three', 'a', 'r1', 'shipping', 'prod']
        ]);
    });
});

describe('redaction', () => {
    it('hides emails and addresses in fields, and logs nothing else of them', () => {
        requestLogger().info('customer created', {
            customerId: 'c-1',
            email: 'ada.lovelace@example.com',
            address: { line1: '12 Analytical Way', city: 'Portland', postalCode: '97201' }
        });
        const [line] = lines();
        expect(line).toMatchObject({ customerId: 'c-1', email: '[REDACTED]', address: '[REDACTED]' });
        expect(JSON.stringify(line)).not.toMatch(/ada\.lovelace|Analytical|Portland|97201/);
    });

    it('hides them deep inside a field, in a list, and under another spelling', () => {
        requestLogger().info('order placed', {
            order: { orderId: 'ord_1', shipping_address: { line1: '12 Analytical Way' }, contacts: [{ Email: 'ada@example.com' }, { emailAddress: 'grace@example.com' }] },
            addresses: [{ line1: '1 Compiler Court' }]
        });
        const text = JSON.stringify(lines()[0]);
        expect(text).not.toMatch(/Analytical|Compiler|ada@|grace@/);
        expect(lines()[0]).toMatchObject({ order: { orderId: 'ord_1' } });
    });

    it('hides an email inside a message and inside an error', () => {
        requestLogger().error('lookup failed for ada.lovelace@example.com', { error: new Error('no row for grace+test@mail.example.org') });
        const text = JSON.stringify(lines()[0]);
        expect(text).not.toMatch(/ada\.lovelace|grace\+test/);
        expect(lines()[0]?.message).toBe('lookup failed for [REDACTED]');
    });

    it('does not hide ids that only look like an address field', () => {
        requestLogger().info('address added', { addressId: 'a-1', customerId: 'c-1', emailCount: 2 });
        expect(lines()[0]).toMatchObject({ addressId: 'a-1', customerId: 'c-1', emailCount: 2 });
    });

    it.each([
        ['email', 'x@y.io', '[REDACTED]'],
        ['EMAIL', 'x@y.io', '[REDACTED]'],
        ['postal_code', '97201', '[REDACTED]'],
        ['phone', '+14155550123', '[REDACTED]'],
        ['phone', null, null],
        ['note', 'write to x@y.io today', 'write to [REDACTED] today'],
        ['note', 'nothing private', 'nothing private'],
        ['count', 3, 3]
    ])('redact(%s, %j) gives %j', (key, value, expected) => {
        expect(redact(key, value)).toEqual(expected);
    });
});

describe('errors', () => {
    it('are logged with their name, message and stack', () => {
        requestLogger().error('write failed', { error: new TypeError('boom') });
        const error = lines()[0]?.error as Line;
        expect(error).toMatchObject({ name: 'TypeError', message: 'boom' });
        expect(String(error.stack)).toContain('TypeError');
    });
});
