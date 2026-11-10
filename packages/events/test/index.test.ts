import { describe, expect, it } from 'vitest';
import { buildEvent, currentSchemaVersion, EventValidationError, eventDataSchemas, eventProducer, eventSchemas, eventTypes, parseEvent, parseEventOfType, type EventData, type EventType, type OrderPlacedEvent, type StorefrontEvent } from '../src/index';

const customerId = '3f6f6f64-6a0e-4a53-9c58-0c1f6c2f6a11';

const samples: { [T in EventType]: EventData<T> } = {
    OrderPlaced: { orderId: 'ord_1', customerId, items: [{ productId: 'p1', quantity: 2, unitPrice: 500 }], currency: 'USD', total: 1000 },
    OrderCancelled: { orderId: 'ord_1', customerId },
    ShipmentCreated: { shipmentId: 'shp_1', orderId: 'ord_1' },
    ShipmentDispatched: { shipmentId: 'shp_1', orderId: 'ord_1', carrier: 'Acme Freight', trackingNumber: 'TRK123' },
    ShipmentDelivered: { shipmentId: 'shp_1', orderId: 'ord_1' },
    ShipmentCancelled: { shipmentId: 'shp_1', orderId: 'ord_1' }
};

const options = { correlationId: 'corr-1' };

function placed(): OrderPlacedEvent {
    return buildEvent('OrderPlaced', samples.OrderPlaced, options);
}

function expectRejected(input: unknown, code: EventValidationError['code'], message?: string | RegExp) {
    try {
        parseEvent(input);
    } catch (error) {
        expect(error).toBeInstanceOf(EventValidationError);
        expect((error as EventValidationError).code).toBe(code);
        if (message) expect((error as EventValidationError).message).toMatch(message);
        return;
    }
    expect.unreachable('parseEvent should have thrown');
}

describe('the event registry', () => {
    it('has a sample, a data schema, an envelope schema, a version and a producer for the six events', () => {
        expect([...eventTypes].sort()).toEqual(['OrderCancelled', 'OrderPlaced', 'ShipmentCancelled', 'ShipmentCreated', 'ShipmentDelivered', 'ShipmentDispatched']);
        for (const type of eventTypes) {
            expect(samples[type], type).toBeDefined();
            expect(eventDataSchemas[type], type).toBeDefined();
            expect(eventSchemas[type], type).toBeDefined();
            expect(currentSchemaVersion[type], type).toBe(1);
            expect(eventProducer[type], type).toMatch(/^storefront\.[a-z]+$/);
        }
    });

    it('names the owner of each event as storefront.<service>', () => {
        expect(eventProducer.OrderPlaced).toBe('storefront.orders');
        expect(eventProducer.ShipmentCreated).toBe('storefront.shipping');
    });
});

describe('buildEvent and parseEvent', () => {
    it.each(eventTypes)('round-trips %s', (type) => {
        const built = buildEvent(type, samples[type] as never, options);
        const parsed = parseEvent(JSON.parse(JSON.stringify(built)));
        expect(parsed).toEqual(built);
        expect(parsed.eventType).toBe(type);
        expect(parsed.data).toEqual(samples[type]);
    });

    it.each(eventTypes)('validates %s with its own envelope schema', (type) => {
        expect(eventSchemas[type].safeParse(buildEvent(type, samples[type] as never, options)).success).toBe(true);
    });

    it('fills in the envelope', () => {
        const event = placed();
        expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(event.schemaVersion).toBe(1);
        expect(event.producer).toBe('storefront.orders');
        expect(event.correlationId).toBe('corr-1');
        expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
    });

    it('gives each event a new id, unless one is passed', () => {
        expect(placed().eventId).not.toBe(placed().eventId);
        const fixed = buildEvent('OrderPlaced', samples.OrderPlaced, { ...options, eventId: '0b0c8d3e-1c5a-4a52-a2c4-7c1d54a1f3aa', occurredAt: new Date('2026-11-09T12:00:00Z') });
        expect(fixed.eventId).toBe('0b0c8d3e-1c5a-4a52-a2c4-7c1d54a1f3aa');
        expect(fixed.occurredAt).toBe('2026-11-09T12:00:00.000Z');
    });

    it('refuses to build an event with a bad payload', () => {
        expect(() => buildEvent('OrderPlaced', { ...samples.OrderPlaced, total: -1 }, options)).toThrow(/Cannot build OrderPlaced: data\.total/);
    });

    it('refuses to build an event with an empty correlation id', () => {
        expect(() => buildEvent('OrderCancelled', samples.OrderCancelled, { correlationId: '' })).toThrow(/correlationId/);
    });
});

describe('parseEvent rejects', () => {
    it.each(['eventId', 'eventType', 'schemaVersion', 'occurredAt', 'correlationId', 'producer', 'data'])('a missing %s', (field) => {
        const event: Record<string, unknown> = { ...placed() };
        delete event[field];
        expect(() => parseEvent(event)).toThrow(EventValidationError);
        if (field !== 'eventType') expectRejected(event, 'malformed_event', new RegExp(field));
    });

    it('a missing required field in the payload, and names the field', () => {
        const event = { ...placed(), data: { ...samples.OrderPlaced, customerId: undefined } };
        expectRejected(event, 'malformed_event', /data\.customerId/);
    });

    it('a wrong type in the envelope', () => {
        expectRejected({ ...placed(), occurredAt: 12345 }, 'malformed_event', /occurredAt/);
        expectRejected({ ...placed(), eventId: 'not-a-uuid' }, 'malformed_event', /eventId/);
    });

    it('a wrong type in the payload', () => {
        expectRejected({ ...placed(), data: { ...samples.OrderPlaced, total: '1000' } }, 'malformed_event', /data\.total/);
        expectRejected({ ...placed(), data: { ...samples.OrderPlaced, items: [{ productId: 'p1', quantity: 0, unitPrice: 1 }] } }, 'malformed_event', /data\.items\.0\.quantity/);
    });

    it('reports every problem, not just the first', () => {
        try {
            parseEvent({ ...placed(), eventId: 'x', correlationId: '' });
        } catch (error) {
            expect((error as EventValidationError).issues).toHaveLength(2);
            return;
        }
        expect.unreachable('parseEvent should have thrown');
    });

    it('an unknown eventType', () => {
        expectRejected({ ...placed(), eventType: 'OrderShipped' }, 'unknown_event_type', /Unknown event type "OrderShipped"/);
        expectRejected({ ...placed(), eventType: 'toString' }, 'unknown_event_type');
    });

    it('an eventType that is not a string', () => {
        expectRejected({ ...placed(), eventType: 7 }, 'malformed_event', /eventType/);
    });

    it.each([null, undefined, 'OrderPlaced', 42, [], '{"eventType":"OrderPlaced"}'])('input that is not an object (%j)', (input) => {
        expectRejected(input, 'malformed_event', /JSON object/);
    });

    it('an event whose producer is not storefront.<service>', () => {
        expectRejected({ ...placed(), producer: 'orders' }, 'malformed_event', /producer/);
    });
});

describe('what a consumer sees when the producer is ahead or behind', () => {
    it('ignores extra fields, in the envelope and in the payload (additive changes keep the version)', () => {
        const event = { ...placed(), traceHeader: 'abc', data: { ...samples.OrderPlaced, giftWrap: true } };
        const parsed = parseEvent(event);
        expect(parsed.data).toEqual(samples.OrderPlaced);
        expect(parsed).not.toHaveProperty('traceHeader');
        expect(parsed.data).not.toHaveProperty('giftWrap');
    });

    it('rejects a newer schemaVersion, even when the payload also has a new shape', () => {
        expectRejected({ ...placed(), schemaVersion: 2 }, 'unsupported_schema_version', /schemaVersion 2.*up to 1/);
        expectRejected({ ...placed(), schemaVersion: 2, data: { something: 'new' } }, 'unsupported_schema_version');
    });

    it('rejects a schemaVersion that is not a whole number as malformed', () => {
        expectRejected({ ...placed(), schemaVersion: 1.5 }, 'malformed_event', /schemaVersion/);
        expectRejected({ ...placed(), schemaVersion: '1' }, 'malformed_event', /schemaVersion/);
        expectRejected({ ...placed(), schemaVersion: 0 }, 'malformed_event', /schemaVersion/);
    });
});

describe('parseEventOfType', () => {
    it('returns the typed event when the type matches', () => {
        const event: OrderPlacedEvent = parseEventOfType('OrderPlaced', placed());
        expect(event.data.items[0]?.quantity).toBe(2);
    });

    it('rejects another known event type', () => {
        const cancelled: StorefrontEvent = buildEvent('OrderCancelled', samples.OrderCancelled, options);
        expect(() => parseEventOfType('OrderPlaced', cancelled)).toThrow(/Expected a OrderPlaced event, got OrderCancelled/);
    });

    it('still rejects a malformed event', () => {
        expect(() => parseEventOfType('OrderPlaced', { eventType: 'OrderPlaced' })).toThrow(EventValidationError);
    });
});
