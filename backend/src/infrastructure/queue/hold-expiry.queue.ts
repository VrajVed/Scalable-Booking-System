import { Queue } from "bullmq";
import { bullMQConnection } from "../../config/redis.js";

export const HOLD_EXPIRY_QUEUE_NAME = "hold-expiry";

export interface HoldExpiryJobData {
  bookingId: number;
}

// BullMQ delayed job, not a poller: one job is scheduled per reservation at
// the exact moment holdExpiresAt is set, and BullMQ fires it exactly once
// when the delay elapses -- nothing is sweeping the bookings table on an
// interval. See reserve-seat.usecase.ts for where this gets scheduled and
// hold-expiry.worker.ts for what runs when it fires.
export const holdExpiryQueue = new Queue<HoldExpiryJobData>(HOLD_EXPIRY_QUEUE_NAME, {
  connection: bullMQConnection,
});

// jobId is deterministic per booking so re-scheduling the same booking
// (shouldn't happen in practice -- a booking is created once -- but this
// keeps the call idempotent rather than relying on that never changing)
// upserts the delayed job instead of stacking a duplicate.
export async function scheduleHoldExpiry(bookingId: number, holdExpiresAt: Date): Promise<void> {
  const delay = Math.max(0, holdExpiresAt.getTime() - Date.now());

  await holdExpiryQueue.add(
    "expire-hold",
    { bookingId },
    {
      delay,
      jobId: `hold-expiry-${bookingId}`,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

export async function closeHoldExpiryQueue(): Promise<void> {
  await holdExpiryQueue.close();
}
