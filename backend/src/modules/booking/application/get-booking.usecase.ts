import { and, eq } from "drizzle-orm";
import { db } from "../../../infrastructure/database/db.js";
import { bookings } from "../../../infrastructure/database/schema/index.js";
import { BookingNotFoundError } from "../domain/booking.errors.js";

export interface GetBookingInput {
  bookingId: number;
  userId: number;
}

// Scoped to the caller's own bookings only -- a booking that exists but
// belongs to someone else 404s the same as one that doesn't exist at all
// (see BookingNotFoundError), rather than leaking existence via a 403.
export async function getBooking({ bookingId, userId }: GetBookingInput) {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.userId, userId)));

  if (!booking) {
    throw new BookingNotFoundError(bookingId);
  }

  return booking;
}
