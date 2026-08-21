import { Worker, type Job } from "bullmq";
import { bullMQConnection } from "../../config/redis.js";
import { expireHold } from "../../modules/booking/application/expire-hold.usecase.js";
import { closeHoldExpiryQueue, HOLD_EXPIRY_QUEUE_NAME, type HoldExpiryJobData } from "./hold-expiry.queue.js";
import { holdExpiryJobsTotal } from "../../shared/metrics/registry.js";

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
        holdExpiryJobsTotal.inc({ outcome: "reverted" });
        console.log("[hold-expiry] reverted abandoned hold", {
          bookingId,
          seatId: result.booking.seatId,
        });
      } else {
        holdExpiryJobsTotal.inc({ outcome: "noop" });
        console.log(
          "[hold-expiry] booking no longer pending at expiry time -- no-op (confirmed/cancelled/already expired)",
          { bookingId },
        );
      }
    },
    { connection: bullMQConnection },
  );

  // BullMQ's 'failed' event fires on EVERY failed attempt, not just once a
  // job gives up -- with the retry/backoff added in hold-expiry.queue.ts, a
  // single transient error now fires this up to 3 times for what's really
  // one logical failure. Only count/escalate the terminal case (retries
  // exhausted); log intermediate retries at a lower severity so they don't
  // read as "a seat is stuck" when BullMQ is about to try again on its own.
  worker.on("failed", (job, err) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts.attempts ?? 1;

    if (attemptsMade >= maxAttempts) {
      holdExpiryJobsTotal.inc({ outcome: "failed" });
      console.error("[hold-expiry] job permanently failed after exhausting retries -- seat may be stuck held", {
        bookingId: job?.data.bookingId,
        attemptsMade,
        err,
      });
    } else {
      console.warn("[hold-expiry] job attempt failed, will retry", {
        bookingId: job?.data.bookingId,
        attemptsMade,
        maxAttempts,
        err,
      });
    }
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
