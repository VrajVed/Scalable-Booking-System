import { Worker, type Job } from "bullmq";
import { bullMQConnection } from "../../config/redis.js";
import { expireHold } from "../../modules/booking/application/expire-hold.usecase.js";
import { closeHoldExpiryQueue, HOLD_EXPIRY_QUEUE_NAME, type HoldExpiryJobData } from "./hold-expiry.queue.js";

let worker: Worker<HoldExpiryJobData> | null = null;

// Named, callable start/stop pair (mirrors connectProducer/disconnectProducer
// and startCdcConsumer's shape elsewhere in this codebase) so the process
// lifecycle wiring in index.ts stays a one-line call, and so a later
// SIGTERM handler (ticket 0004) has an obvious single function to call
// during graceful shutdown instead of reaching into this module's internals.
export function startHoldExpiryWorker(): Worker<HoldExpiryJobData> {
  if (worker) return worker;

  worker = new Worker<HoldExpiryJobData>(
    HOLD_EXPIRY_QUEUE_NAME,
    async (job: Job<HoldExpiryJobData>) => {
      const { bookingId } = job.data;
      const result = await expireHold(bookingId);

      if (result) {
        console.log("[hold-expiry] reverted abandoned hold", {
          bookingId,
          seatId: result.booking.seatId,
        });
      } else {
        console.log(
          "[hold-expiry] booking no longer pending at expiry time -- no-op (confirmed/cancelled/already expired)",
          { bookingId },
        );
      }
    },
    { connection: bullMQConnection },
  );

  worker.on("failed", (job, err) => {
    console.error("[hold-expiry] job failed", { bookingId: job?.data.bookingId, err });
  });

  return worker;
}

// Stops the worker (waits for any in-flight job to finish, per BullMQ's
// Worker#close semantics) and closes the scheduling queue's Redis
// connection. This is the single call a graceful-shutdown handler needs --
// it does not install any signal handlers itself, that's ticket 0004's
// concern.
export async function stopHoldExpiryWorker(): Promise<void> {
  if (worker) {
    const w = worker;
    worker = null;
    await w.close();
  }
  await closeHoldExpiryQueue();
}
