import { kafka } from "../../config/kafka.js";
import { kafkaProducerConnected, bookingEventsPublishedTotal } from "../../shared/metrics/registry.js";

const producer = kafka.producer();
let connected = false;

export async function connectProducer(): Promise<void> {
  await producer.connect();
  connected = true;
  kafkaProducerConnected.set(1);
}

export function isProducerConnected(): boolean {
  return connected;
}

export async function disconnectProducer(): Promise<void> {
  await producer.disconnect();
  connected = false;
  kafkaProducerConnected.set(0);
}

export async function publishBookingEvent(
  eventType: "booking.created" | "booking.confirmed" | "booking.cancelled",
  payload: Record<string, unknown>,
): Promise<void> {
  await producer.send({
    topic: "booking.events",
    messages: [
      {
        key: String(payload.bookingId ?? ""),
        value: JSON.stringify({ type: eventType, payload, timestamp: new Date().toISOString() }),
      },
    ],
  });
  bookingEventsPublishedTotal.inc({ type: eventType });
}
