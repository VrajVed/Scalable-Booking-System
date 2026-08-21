import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { db, closeDb } from "../../src/infrastructure/database/db.js";
import { seats, bookings } from "../../src/infrastructure/database/schema/index.js";
import {
  scheduleHoldExpiry,
  holdExpiryQueue,
  type HoldExpiryJobData,
} from "../../src/infrastructure/queue/hold-expiry.queue.js";
import { startHoldExpiryWorker, stopHoldExpiryWorker } from "../../src/infrastructure/queue/hold-expiry.worker.js";
import { redisConnection } from "../../src/config/redis.js";
import { reserveSeat } from "../../src/modules/booking/application/reserve-seat.usecase.js";
import { connectProducer, disconnectProducer } from "../../src/infrastructure/kafka/producer.js";
import {
  createTestVenue,
  createTestEvent,
  createTestSeat,
  createTestBooking,
  createTestUser,
  deleteTestUser,
  getSeat,
  getBookingById,
  cleanupTestData,
} from "../helpers/db.js";

let venueId: number;
let eventId: number;
let userId: number;
let worker: ReturnType<typeof startHoldExpiryWorker>;

// Jobs the real worker has actually finished processing (fired by BullMQ's
// "completed" event), keyed by BullMQ job id. Waiting for a job's id to show
// up here -- instead of blindly sleeping past the delay -- is what lets
// these tests prove the worker actually ran the job, not just that nothing
// visibly changed within an arbitrary window.
const completedJobIds = new Set<string>();

// Bounded poll instead of a blind sleep: resolves true as soon as the
// predicate is satisfied, false if the deadline passes first. Every use
// below asserts on the boolean return, so a job that never fires fails
// loudly and quickly (well under the suite's own timeout) rather than the
// test just happening to pass because it waited long enough.
async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

before(async () => {
  await connectProducer();
  venueId = await createTestVenue();
  eventId = await createTestEvent(venueId);
  userId = await createTestUser();

  worker = startHoldExpiryWorker();
  worker.on("completed", (job: Job<HoldExpiryJobData>) => {
    if (job.id) completedJobIds.add(job.id);
  });
});

after(async () => {
  await cleanupTestData(venueId);
  await deleteTestUser(userId);
  // Same leaked-handle class of bug the existing booking test files already
  // had to fix: without closing the worker, the queue, ioredis's own
  // connection, the Kafka producer, and the Postgres pool, tsx --test hangs
  // after the last test instead of exiting.
  await stopHoldExpiryWorker();
  await redisConnection.quit();
  await disconnectProducer();
  await closeDb();
});

describe("scheduleHoldExpiry — jobId fix (was: 'Custom Id cannot contain :')", () => {
  it("reserveSeat's post-commit scheduling no longer fails, and a real BullMQ job is enqueued under the fixed id", async () => {
    const seatId = await createTestSeat(eventId);

    const errorCalls: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    let booking: Awaited<ReturnType<typeof reserveSeat>>;
    try {
      booking = await reserveSeat({ seatId, userId });
    } finally {
      console.error = originalConsoleError;
    }

    const scheduleFailureLog = errorCalls.find(
      (args) => typeof args[0] === "string" && args[0].includes("failed to schedule hold-expiry job"),
    );
    assert.equal(
      scheduleFailureLog,
      undefined,
      `scheduleHoldExpiry must succeed now that the jobId no longer contains ':' -- but the schedule-failure ` +
        `warning fired: ${JSON.stringify(scheduleFailureLog)}`,
    );

    // Positive proof, not just the absence of a warning: the job must
    // actually be sitting in BullMQ under the id scheduleHoldExpiry uses.
    assert.ok(booking, "premise check: reserveSeat must have returned a committed booking");
    const jobId = `hold-expiry-${booking!.id}`;
    const job = await holdExpiryQueue.getJob(jobId);
    assert.ok(job, `expected a real BullMQ job enqueued under id '${jobId}' -- the pre-fix ':' jobId never enqueued at all`);

    // Housekeeping: this job carries the real (long) HOLD_DURATION_MS delay
    // since it went through reserveSeat's normal path, so it won't fire
    // during this test run -- remove it explicitly rather than leaving a
    // multi-minute delayed job sitting in the shared dev Redis.
    await job!.remove();
  });
});

describe("hold-expiry worker — abandoned hold reverts", () => {
  it("reverts an abandoned hold once the delayed job actually fires: seat -> available, booking -> expired", async () => {
    const seatId = await createTestSeat(eventId, { status: "held" });
    const holdExpiresAt = new Date(Date.now() + 1200);
    const booking = await createTestBooking(seatId, userId, holdExpiresAt);

    await scheduleHoldExpiry(booking.id, holdExpiresAt);

    const jobId = `hold-expiry-${booking.id}`;
    const fired = await waitFor(() => completedJobIds.has(jobId), 10_000);
    assert.ok(
      fired,
      `expected the hold-expiry job '${jobId}' to complete within 10s of a 1.2s delay -- it never fired`,
    );

    const seat = await getSeat(seatId);
    const updatedBooking = await getBookingById(booking.id);

    assert.equal(
      seat?.status,
      "available",
      "seat must be released back to available once the hold-expiry job fires",
    );
    assert.equal(
      updatedBooking?.status,
      "expired",
      "booking must flip to expired once the hold-expiry job fires",
    );
  });
});

describe("hold-expiry worker — race against a concurrent confirm", () => {
  it("does not clobber a booking confirmed just before the expiry job fires; the job loses the race cleanly", async () => {
    const seatId = await createTestSeat(eventId, { status: "held" });
    const holdExpiresAt = new Date(Date.now() + 1200);
    const booking = await createTestBooking(seatId, userId, holdExpiresAt);

    await scheduleHoldExpiry(booking.id, holdExpiresAt);

    // Simulate a real confirm flow winning the race by flipping the
    // booking/seat exactly as a confirm usecase would (none exists in this
    // codebase yet -- the ticket explicitly calls for simulating it this
    // way), and doing it immediately after scheduling so it lands well
    // before the 1.2s delay elapses.
    await db.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, booking.id));
    await db.update(seats).set({ status: "booked" }).where(eq(seats.id, seatId));

    const jobId = `hold-expiry-${booking.id}`;
    const fired = await waitFor(() => completedJobIds.has(jobId), 10_000);
    assert.ok(
      fired,
      `expected the hold-expiry job '${jobId}' to actually run (and lose the race) within 10s -- it never fired, ` +
        `so this test would prove nothing about the race outcome`,
    );

    const seat = await getSeat(seatId);
    const finalBooking = await getBookingById(booking.id);

    assert.equal(
      finalBooking?.status,
      "confirmed",
      "the expiry job must lose the race cleanly (its UPDATE ... WHERE status = 'pending' matches zero rows) " +
        "and must not overwrite a booking that was confirmed in the meantime",
    );
    assert.equal(
      seat?.status,
      "booked",
      "the expiry job must not touch the seat once the booking it was guarding is no longer pending",
    );
  });
});
