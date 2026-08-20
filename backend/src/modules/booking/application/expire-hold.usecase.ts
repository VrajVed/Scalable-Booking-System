import { and, eq } from "drizzle-orm";
import { db } from "../../../infrastructure/database/db.js";
import { bookings } from "../../../infrastructure/database/schema/index.js";
import { releaseSeatRow } from "../infrastructure/seat.repository.js";

export interface ExpireHoldResult {
  booking: typeof bookings.$inferSelect;
  seat: Awaited<ReturnType<typeof releaseSeatRow>>;
}

// Fired by the hold-expiry BullMQ worker once a booking's holdExpiresAt
// delay elapses. This is the mirror image of reserveSeat's transaction: the
// same optimistic-concurrency shape (only touch rows still in the expected
// state), just running in the opposite direction.
//
// The booking UPDATE's WHERE clause (status = 'pending') is the race
// arbiter. If the user confirmed (or cancelled) in the window between the
// job being scheduled and it firing, the booking is no longer 'pending' and
// this UPDATE matches zero rows -- the expiry job loses the race cleanly
// and returns null without touching the seat at all. If it's still
// 'pending', this job is the one legitimately reclaiming an abandoned hold,
// and the seat is released inside the same transaction so a partial
// booking-expired/seat-still-held state can never be observed.
export async function expireHold(bookingId: number): Promise<ExpireHoldResult | null> {
  return db.transaction(async (tx) => {
    const [expiredBooking] = await tx
      .update(bookings)
      .set({ status: "expired" })
      .where(and(eq(bookings.id, bookingId), eq(bookings.status, "pending")))
      .returning();

    if (!expiredBooking) {
      // Booking was already confirmed/cancelled/expired by something else --
      // the expiry job arrived too late (or twice) and that's fine: losing
      // this race is the correct outcome, not an error.
      return null;
    }

    const seat = await releaseSeatRow(expiredBooking.seatId, tx);
    return { booking: expiredBooking, seat };
  });
}
