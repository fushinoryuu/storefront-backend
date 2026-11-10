import { z } from 'zod';

// The payload of each event. These are first drafts: the owning service may refine them, following the versioning rule in the README.
// An id of an order or a shipment is a plain string, as in the OpenAPI specs. A customer id is a UUID.

const orderId = z.string().min(1);
const shipmentId = z.string().min(1);
const customerId = z.uuid();

const OrderItemData = z.object({
    productId: z.string().min(1),
    quantity: z.int().min(1),
    unitPrice: z.int().min(0)
});

export const OrderPlacedDataSchema = z.object({
    orderId,
    customerId,
    items: z.array(OrderItemData).min(1).max(20),
    currency: z.string().regex(/^[A-Z]{3}$/),
    total: z.int().min(0)
});

export const OrderCancelledDataSchema = z.object({
    orderId,
    customerId
});

export const ShipmentCreatedDataSchema = z.object({
    shipmentId,
    orderId
});

export const ShipmentDispatchedDataSchema = z.object({
    shipmentId,
    orderId,
    carrier: z.string().min(1),
    trackingNumber: z.string().min(1)
});

export const ShipmentDeliveredDataSchema = z.object({
    shipmentId,
    orderId
});

export const ShipmentCancelledDataSchema = z.object({
    shipmentId,
    orderId
});

// What the registry in registry.ts needs to know about each event.
export const eventDataSchemas = {
    OrderPlaced: OrderPlacedDataSchema,
    OrderCancelled: OrderCancelledDataSchema,
    ShipmentCreated: ShipmentCreatedDataSchema,
    ShipmentDispatched: ShipmentDispatchedDataSchema,
    ShipmentDelivered: ShipmentDeliveredDataSchema,
    ShipmentCancelled: ShipmentCancelledDataSchema
} as const;
