import { kafka } from "../../config/kafka.js";
import { env } from "../../config/env.js";
import { redisConnection } from "../../config/redis.js";
import { mapDebeziumMessage } from "./debezium-mapper.js";

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

function seatAvailabilityCacheKey(eventId: unknown): string {
  return `seats:availability:event:${eventId}`;
}

export async function startCdcConsumer(): Promise<void> {
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    connected = false;
    console.error("[kafka] cdc consumer crashed", payload);
  });

  consumer.on(consumer.events.CONNECT, () => {
    connected = true;
    console.log("[kafka] cdc consumer connected");
  });

  consumer.on(consumer.events.DISCONNECT, () => {
    connected = false;
  });

  await consumer.connect();
  await consumer.subscribe({ topic: env.KAFKA_CDC_TOPIC, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;

      try {
        const event = mapDebeziumMessage(message.value.toString());
        if (!event) return;

        const key = seatAvailabilityCacheKey(event.data.event_id);
        await redisConnection.del(key);
        console.log("[kafka] invalidated cache", key, event.type);
      } catch (err) {
        console.error("[kafka] failed to process cdc message", err);
      }
    },
  });
}
