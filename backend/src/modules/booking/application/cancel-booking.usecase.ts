import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../infrastructure/database/db.js";
import { bookings } from "../../../infrastructure/database/schema/index.js";
import { publishBookingEvent } from "../../../infrastructure/kafka/producer.js";
import { holdExpiryQueue } from "../../../infrastructure/queue/hold-expiry.queue.js";
import { releaseHeldOrBookedSeatRow } from "../infrastructure/seat.repository.js";
import { BookingNotCancellableError, BookingNotFoundError } from "../domain/booking.errors.js";

export interface CancelBookingInput {
  bookingId: number;
  userId: number;
}

// A booking can be cancelled from either 'pending' (still just a hold) or
// 'confirmed' (the simulated payment step already ran) -- both release the
// seat back to 'available'. Once 'expired' or already 'cancelled', it's not
// cancellable: there's nothing left to release, or it already was.
export async function cancelBooking({ bookingId, userId }: CancelBookingInput) {
  // Ownership check first, outside the transaction -- same reasoning as
  // confirm-booking.usecase.ts: not-found and not-yours must both 404, not
  // 409, or the status code itself would leak whether the id is valid.
  const [existing] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.userId, userId)));

  if (!existing) {
    throw new BookingNotFoundError(bookingId);
  }

  const cancelled = await db.transaction(async (tx) => {
    const [updatedBooking] = await tx
      .update(bookings)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(bookings.id, bookingId), inArray(bookings.status, ["pending", "confirmed"])))
      .returning();

    if (!updatedBooking) {
      return null;
    }

    const seat = await releaseHeldOrBookedSeatRow(updatedBooking.seatId, tx);
    if (!seat) {
      // See confirm-booking.usecase.ts's identical check: the booking side
      // of this transaction won its race, but the seat wasn't in a state
      // this transition expects -- a real invariant violation, not a normal
      // race outcome, so this is thrown rather than swallowed.
      throw new Error(
        `booking ${bookingId} cancelled but its seat ${updatedBooking.seatId} was not held/booked -- state drift`,
      );
    }

    return updatedBooking;
  });

  if (!cancelled) {
    const [current] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    throw new BookingNotCancellableError(bookingId, current?.status ?? "unknown");
  }

  // Best-effort cleanup, not a correctness requirement: expire-hold's own
  // status = 'pending' WHERE clause already makes it a safe no-op if this
  // job still fires later against a now-cancelled booking. But leaving a
  // dead delayed job sitting in Redis until its window elapses is needless
  // clutter, so remove it if it's still there.
  try {
    const job = await holdExpiryQueue.getJob(`hold-expiry-${bookingId}`);
    if (job) {
      await job.remove();
    }
  } catch (err) {
    console.error(
      "[booking] failed to remove hold-expiry job after cancel (non-fatal -- expire-hold will no-op on it anyway)",
      { bookingId, err },
    );
  }

  try {
    await publishBookingEvent("booking.cancelled", {
      bookingId: cancelled.id,
      seatId: cancelled.seatId,
      userId: cancelled.userId,
    });
  } catch (err) {
    console.error("[booking] failed to publish booking.cancelled event after commit", {
      bookingId: cancelled.id,
      err,
    });
  }

  return cancelled;
}
