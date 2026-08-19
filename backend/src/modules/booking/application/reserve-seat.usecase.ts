import { db } from "../../../infrastructure/database/db.js";
import { bookings } from "../../../infrastructure/database/schema/index.js";
import { publishBookingEvent } from "../../../infrastructure/kafka/producer.js";
import { findSeatById, reserveSeatRow } from "../infrastructure/seat.repository.js";
import { SeatNotFoundError, SeatUnavailableError } from "../domain/booking.errors.js";

const HOLD_DURATION_MS = 5 * 60 * 1000;

export interface ReserveSeatInput {
  seatId: number;
  userId: string;
}

export async function reserveSeat({ seatId, userId }: ReserveSeatInput) {
  const existing = await findSeatById(seatId);
  if (!existing) {
    throw new SeatNotFoundError(seatId);
  }

  const seat = await reserveSeatRow(seatId);
  if (!seat) {
    throw new SeatUnavailableError(seatId);
  }

  const holdExpiresAt = new Date(Date.now() + HOLD_DURATION_MS);

  const [booking] = await db
    .insert(bookings)
    .values({ seatId, userId, status: "pending", holdExpiresAt })
    .returning();

  await publishBookingEvent("booking.created", {
    bookingId: booking?.id,
    seatId,
    userId,
    holdExpiresAt: holdExpiresAt.toISOString(),
  });

  return booking;
}
