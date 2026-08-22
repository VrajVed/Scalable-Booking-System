import { and, eq } from "drizzle-orm";
import { db } from "../../../infrastructure/database/db.js";
import { bookings } from "../../../infrastructure/database/schema/index.js";
import { publishBookingEvent } from "../../../infrastructure/kafka/producer.js";
import { confirmSeatRow } from "../infrastructure/seat.repository.js";
import { BookingNotConfirmableError, BookingNotFoundError } from "../domain/booking.errors.js";

export interface ConfirmBookingInput {
  bookingId: number;
  userId: number;
}

// Stands in for the "Payment" step in idea.md's Booking -> Payment ->
// Confirmation flow -- there's no real payment gateway (explicit non-goal),
// so this endpoint IS the confirmation: the caller is asserting payment
// succeeded. A real gateway integration would sit in front of this call,
// not replace it -- the pending -> confirmed transition and its seat-side
// effect stay the same either way.
export async function confirmBooking({ bookingId, userId }: ConfirmBookingInput) {
  // Ownership check first, outside the transaction: a booking that exists
  // but belongs to someone else must 404 (BookingNotFoundError), not 409 --
  // 409 would leak that the id is valid. Only bookings this user owns ever
  // reach the state-transition logic below.
  const [existing] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.userId, userId)));

  if (!existing) {
    throw new BookingNotFoundError(bookingId);
  }

  // The booking UPDATE's WHERE clause (status = 'pending') is the race
  // arbiter, same pattern as expire-hold.usecase.ts: if the hold already
  // expired (or this booking was already confirmed/cancelled) between the
  // read above and this UPDATE, zero rows match and that's reported as
  // BookingNotConfirmableError with the state actually observed, not a
  // stale guess from the read.
  const confirmed = await db.transaction(async (tx) => {
    const [updatedBooking] = await tx
      .update(bookings)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(and(eq(bookings.id, bookingId), eq(bookings.status, "pending")))
      .returning();

    if (!updatedBooking) {
      return null;
    }

    const seat = await confirmSeatRow(updatedBooking.seatId, tx);
    if (!seat) {
      // The booking UPDATE won its race but the seat didn't still have a
      // matching row -- would mean the booking/seat states had already
      // drifted out of sync before this call, which reserveSeat's and
      // expire-hold's own transactions should never allow. Surfacing this
      // loudly (not swallowing it) rather than silently confirming a
      // booking whose seat didn't actually move to 'booked'.
      throw new Error(
        `booking ${bookingId} confirmed but its seat ${updatedBooking.seatId} was not 'held' -- state drift`,
      );
    }

    return updatedBooking;
  });

  if (!confirmed) {
    // Re-read to report the real current status in the error rather than a
    // generic message -- the transaction above only tells us it wasn't
    // 'pending' anymore, not what it became.
    const [current] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    throw new BookingNotConfirmableError(bookingId, current?.status ?? "unknown");
  }

  // Same resilience posture as reserveSeat's own Kafka publish: the DB
  // commit is the source of truth, a broker hiccup here must not turn a
  // committed confirmation into a failed request the client might retry
  // into a 409.
  try {
    await publishBookingEvent("booking.confirmed", {
      bookingId: confirmed.id,
      seatId: confirmed.seatId,
      userId: confirmed.userId,
    });
  } catch (err) {
    console.error("[booking] failed to publish booking.confirmed event after commit", {
      bookingId: confirmed.id,
      err,
    });
  }

  return confirmed;
}
