import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { describeIssues, EventValidationError } from './errors';
import { eventDataSchemas, OrderCancelledDataSchema, OrderPlacedDataSchema, ShipmentCancelledDataSchema, ShipmentCreatedDataSchema, ShipmentDeliveredDataSchema, ShipmentDispatchedDataSchema } from './schemas';

export type EventType = keyof typeof eventDataSchemas;

export const eventTypes = Object.keys(eventDataSchemas) as EventType[];

// The `schemaVersion` every event is built with. A version only changes for a breaking change (see the README).
export const currentSchemaVersion: Record<EventType, number> = {
    OrderPlaced: 1,
    OrderCancelled: 1,
    ShipmentCreated: 1,
    ShipmentDispatched: 1,
    ShipmentDelivered: 1,
    ShipmentCancelled: 1
};

// The service that owns each event. `producer` is `storefront.<service>`, as in docs/conventions.md.
export const eventProducer: Record<EventType, string> = {
    OrderPlaced: 'storefront.orders',
    OrderCancelled: 'storefront.orders',
    ShipmentCreated: 'storefront.shipping',
    ShipmentDispatched: 'storefront.shipping',
    ShipmentDelivered: 'storefront.shipping',
    ShipmentCancelled: 'storefront.shipping'
};

function envelopeSchema<T extends EventType, D extends z.ZodType>(eventType: T, data: D) {
    return z.object({
        eventId: z.uuid(),
        eventType: z.literal(eventType),
        schemaVersion: z.literal(currentSchemaVersion[eventType]),
        occurredAt: z.iso.datetime(),
        correlationId: z.string().min(1),
        producer: z.string().regex(/^storefront\.[a-z]+$/),
        data
    });
}

// One envelope schema per event. Each is also the runtime validator: `OrderPlacedEventSchema.safeParse(value)`.
// Fields that are not in the schema are dropped when parsing, so a consumer ignores what a later, additive version adds.
export const OrderPlacedEventSchema = envelopeSchema('OrderPlaced', OrderPlacedDataSchema);
export const OrderCancelledEventSchema = envelopeSchema('OrderCancelled', OrderCancelledDataSchema);
export const ShipmentCreatedEventSchema = envelopeSchema('ShipmentCreated', ShipmentCreatedDataSchema);
export const ShipmentDispatchedEventSchema = envelopeSchema('ShipmentDispatched', ShipmentDispatchedDataSchema);
export const ShipmentDeliveredEventSchema = envelopeSchema('ShipmentDelivered', ShipmentDeliveredDataSchema);
export const ShipmentCancelledEventSchema = envelopeSchema('ShipmentCancelled', ShipmentCancelledDataSchema);

export const eventSchemas = {
    OrderPlaced: OrderPlacedEventSchema,
    OrderCancelled: OrderCancelledEventSchema,
    ShipmentCreated: ShipmentCreatedEventSchema,
    ShipmentDispatched: ShipmentDispatchedEventSchema,
    ShipmentDelivered: ShipmentDeliveredEventSchema,
    ShipmentCancelled: ShipmentCancelledEventSchema
} as const satisfies Record<EventType, z.ZodType>;

export type OrderPlacedEvent = z.infer<typeof OrderPlacedEventSchema>;
export type OrderCancelledEvent = z.infer<typeof OrderCancelledEventSchema>;
export type ShipmentCreatedEvent = z.infer<typeof ShipmentCreatedEventSchema>;
export type ShipmentDispatchedEvent = z.infer<typeof ShipmentDispatchedEventSchema>;
export type ShipmentDeliveredEvent = z.infer<typeof ShipmentDeliveredEventSchema>;
export type ShipmentCancelledEvent = z.infer<typeof ShipmentCancelledEventSchema>;

export type EventOfType<T extends EventType> = z.infer<(typeof eventSchemas)[T]>;
export type EventData<T extends EventType> = EventOfType<T>['data'];
export type StorefrontEvent = { [T in EventType]: EventOfType<T> }[EventType];

export interface BuildEventOptions {
    correlationId: string;
    // Both default to a new value. Pass them to build an event deterministically, for example in a test.
    eventId?: string;
    occurredAt?: Date;
}

// Builds an envelope around `data`. The result is validated, so a producer that builds a bad event fails here and not at a consumer.
export function buildEvent<T extends EventType>(eventType: T, data: EventData<T>, options: BuildEventOptions): EventOfType<T> {
    const candidate = {
        eventId: options.eventId ?? randomUUID(),
        eventType,
        schemaVersion: currentSchemaVersion[eventType],
        occurredAt: (options.occurredAt ?? new Date()).toISOString(),
        correlationId: options.correlationId,
        producer: eventProducer[eventType],
        data
    };
    const result = eventSchemas[eventType].safeParse(candidate);
    if (!result.success) {
        throw new EventValidationError('malformed_event', `Cannot build ${eventType}`, describeIssues(result.error));
    }
    return result.data as EventOfType<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Parses and validates an incoming event, and throws an EventValidationError when it is not one this package knows.
// Checks, in order: it is an object, `eventType` is a known type, `schemaVersion` is not newer than this package's, then the whole envelope.
export function parseEvent(input: unknown): StorefrontEvent {
    if (!isRecord(input)) {
        throw new EventValidationError('malformed_event', 'An event must be a JSON object');
    }
    const { eventType, schemaVersion } = input;
    if (typeof eventType !== 'string') {
        throw new EventValidationError('malformed_event', 'Malformed event', ['eventType must be a string']);
    }
    if (!Object.hasOwn(eventSchemas, eventType)) {
        throw new EventValidationError('unknown_event_type', `Unknown event type "${eventType}"`);
    }
    const type = eventType as EventType;
    if (typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) && schemaVersion > currentSchemaVersion[type]) {
        throw new EventValidationError('unsupported_schema_version', `${type} has schemaVersion ${schemaVersion}, but this consumer supports up to ${currentSchemaVersion[type]}`);
    }
    const result = eventSchemas[type].safeParse(input);
    if (!result.success) {
        throw new EventValidationError('malformed_event', `Malformed ${type} event`, describeIssues(result.error));
    }
    return result.data as StorefrontEvent;
}

// Like parseEvent, for a consumer that handles one event type and must reject any other.
export function parseEventOfType<T extends EventType>(eventType: T, input: unknown): EventOfType<T> {
    const event = parseEvent(input);
    if (event.eventType !== eventType) {
        throw new EventValidationError('unknown_event_type', `Expected a ${eventType} event, got ${event.eventType}`);
    }
    return event as EventOfType<T>;
}
