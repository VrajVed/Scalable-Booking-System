import { kafka } from "../../config/kafka.js";
import { env } from "../../config/env.js";
import { redisConnection } from "../../config/redis.js";
import { mapDebeziumMessage } from "./debezium-mapper.js";
import { cdcConsumerConnected } from "../../shared/metrics/registry.js";

// Consumes Debezium's CDC envelope for the seats table and invalidates the
// per-event seat-availability cache key. This is the whole point of wiring
// Postgres WAL -> Debezium -> Kafka in: a write to `seats` propagates here
// with zero polling, instead of the cache entry sitting stale on a TTL.
const consumer = kafka.consumer({
  groupId: env.KAFKA_CDC_GROUP_ID,
  sessionTimeout: 6000,
  heartbeatInterval: 2000,
});

let connected = false;

export function isCdcConsumerConnected(): boolean {
  return connected;
}

// Teardown counterpart to startCdcConsumer, called by the graceful-shutdown
// handler (ticket 0004) after the HTTP layer has drained: stops consuming
// and closes the Kafka connection. No-op if the consumer never connected
// (boot failure path) — matching the module's own 'connected' flag.
export async function stopCdcConsumer(): Promise<void> {
  if (!connected) return;
  await consumer.disconnect();
}

function seatAvailabilityCacheKey(eventId: number | string): string {
  return `seats:availability:event:${eventId}`;
}

// Extracted from the eachMessage callback so it can be exercised directly in
// tests without a live Kafka consumer. Handles every failure mode a raw CDC
// message can throw: malformed JSON, an unrecognized op, and — the one the
// original inline version got wrong — a payload whose 'after'/'before' image
// doesn't carry an event_id. Building the cache key from an undefined value
// silently produces "seats:availability:event:undefined" and issues a no-op
// DEL against a key nothing ever reads or writes; that hides a real data
// problem instead of surfacing it, so we log and skip instead.
export async function handleCdcMessage(rawValue: Buffer | string | null | undefined): Promise<void> {
  if (!rawValue) return;

  try {
    const event = mapDebeziumMessage(rawValue.toString());
    if (!event) return;

    const eventId = event.data.event_id;
    if (typeof eventId !== "number" && typeof eventId !== "string") {
      console.error(
        "[kafka] cdc event missing event_id — skipping cache invalidation instead of building a garbage key",
        { type: event.type, data: event.data },
      );
      return;
    }

    const key = seatAvailabilityCacheKey(eventId);
    await redisConnection.del(key);
    console.log("[kafka] invalidated cache", key, event.type);
  } catch (err) {
    console.error("[kafka] failed to process cdc message", err);
  }
}

export async function startCdcConsumer(): Promise<void> {
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    connected = false;
    cdcConsumerConnected.set(0);
    console.error("[kafka] cdc consumer crashed", payload);
  });

  consumer.on(consumer.events.CONNECT, () => {
    connected = true;
    cdcConsumerConnected.set(1);
    console.log("[kafka] cdc consumer connected");
  });

  consumer.on(consumer.events.DISCONNECT, () => {
    connected = false;
    cdcConsumerConnected.set(0);
  });

  await consumer.connect();
  await consumer.subscribe({ topic: env.KAFKA_CDC_TOPIC, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      await handleCdcMessage(message.value);
    },
  });
}
