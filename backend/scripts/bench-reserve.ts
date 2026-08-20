import { reserveSeat } from "../src/modules/booking/application/reserve-seat.usecase.js";
import { hashPassword } from "../src/shared/crypto/password.js";
import { db, closeDb } from "../src/infrastructure/database/db.js";
import { users } from "../src/infrastructure/database/schema/index.js";
import { connectProducer, disconnectProducer } from "../src/infrastructure/kafka/producer.js";
import { redisConnection } from "../src/config/redis.js";
import { closeHoldExpiryQueue } from "../src/infrastructure/queue/hold-expiry.queue.js";

// Isolates the booking write path from EVERY HTTP-layer cost: no Fastify
// routing, no JWT verification, no rate limiter, no JSON (de)serialization
// over a socket. Calls reserveSeat() directly, in-process, the same
// function booking.controller.ts calls after requireAuth already ran. This
// is what's left once you subtract "HTTP + auth" from the measured
// end-to-end req/s -- the actual DB-transaction + Kafka-publish +
// BullMQ-schedule ceiling.
//
// Usage: tsx --env-file=.env scripts/bench-reserve.ts
// Env: CONCURRENCY (default 50), DURATION_MS (default 8000), SEAT_ID_START (default 300000)

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const DURATION_MS = Number(process.env.DURATION_MS ?? 8000);
const SEAT_ID_START = Number(process.env.SEAT_ID_START ?? 300000);

async function createBenchUser(): Promise<number> {
  const passwordHash = await hashPassword("bench-only-not-a-real-password");
  const [row] = await db
    .insert(users)
    .values({ email: `bench-${Date.now()}@example.com`, passwordHash })
    .returning();
  if (!row) throw new Error("failed to create bench user");
  return row.id;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

async function main() {
  await connectProducer();
  const userId = await createBenchUser();

  let seatCursor = SEAT_ID_START;
  let success = 0;
  let failure = 0;
  const latencies: number[] = [];

  const deadline = Date.now() + DURATION_MS;

  async function worker() {
    while (Date.now() < deadline) {
      const seatId = seatCursor++;
      const start = performance.now();
      try {
        await reserveSeat({ seatId, userId });
        success++;
      } catch {
        // SeatNotFoundError / SeatUnavailableError are expected outcomes at
        // this concurrency, not bench failures -- still counted so the
        // final throughput number reflects real attempted-request volume.
        failure++;
      }
      latencies.push(performance.now() - start);
    }
  }

  console.log(
    `running ${CONCURRENCY} concurrent workers for ${DURATION_MS}ms against seatId ${SEAT_ID_START}+ (userId=${userId}) ...`,
  );
  const wallStart = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wallMs = performance.now() - wallStart;

  const total = success + failure;
  const sorted = [...latencies].sort((a, b) => a - b);

  console.log(`\n${total} requests in ${(wallMs / 1000).toFixed(2)}s`);
  console.log(`  success (201-equivalent): ${success}`);
  console.log(`  failure (404/409-equivalent): ${failure}`);
  console.log(`  req/s: ${(total / (wallMs / 1000)).toFixed(1)}`);
  console.log(
    `  latency p50=${percentile(sorted, 50).toFixed(2)}ms p95=${percentile(sorted, 95).toFixed(2)}ms ` +
      `p99=${percentile(sorted, 99).toFixed(2)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(2)}ms`,
  );

  await disconnectProducer();
  await redisConnection.quit();
  await closeHoldExpiryQueue();
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
