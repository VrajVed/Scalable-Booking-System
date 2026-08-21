import { kafka } from "../../config/kafka.js";
import { kafkaProducerConnected, bookingEventsPublishedTotal } from "../../shared/metrics/registry.js";

const producer = kafka.producer();
let connected = false;

// Driven by kafkajs's own CONNECT/DISCONNECT events, not just the
// connectProducer/disconnectProducer call sites below -- an unexpected
// mid-session drop (broker restart, network blip) fires DISCONNECT too, so
// both `connected` and the gauge stay accurate instead of only reflecting
// the last explicit connect/disconnect call. Mirrors cdc-consumer.ts's
// CONNECT/DISCONNECT/CRASH wiring; producer has no CRASH event to listen to.
producer.on(producer.events.CONNECT, () => {
  connected = true;
  kafkaProducerConnected.set(1);
});

producer.on(producer.events.DISCONNECT, () => {
  connected = false;
  kafkaProducerConnected.set(0);
});

export async function connectProducer(): Promise<void> {
  await producer.connect();
}

export function isProducerConnected(): boolean {
  return connected;
}

export async function disconnectProducer(): Promise<void> {
  await producer.disconnect();
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
