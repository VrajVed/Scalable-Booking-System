import { env } from "../../../config/env.js";
import { db } from "../../../infrastructure/database/db.js";
import { bookings } from "../../../infrastructure/database/schema/index.js";
import { publishBookingEvent } from "../../../infrastructure/kafka/producer.js";
import { scheduleHoldExpiry } from "../../../infrastructure/queue/hold-expiry.queue.js";
import { findSeatById, reserveSeatRow } from "../infrastructure/seat.repository.js";
import { SeatNotFoundError, SeatUnavailableError } from "../domain/booking.errors.js";

export interface ReserveSeatInput {
  seatId: number;
  userId: number;
}

export async function reserveSeat({ seatId, userId }: ReserveSeatInput) {
  const existing = await findSeatById(seatId);
  if (!existing) {
    throw new SeatNotFoundError(seatId);
  }

  const holdExpiresAt = new Date(Date.now() + env.HOLD_DURATION_MS);

  // The seat UPDATE and the booking INSERT must succeed or fail together.
  // Without a transaction, a failure on the INSERT (constraint violation,
  // connection drop, process crash) after the UPDATE has already flipped
  // the seat to 'held' leaves the seat stuck: neither available nor tied
  // to a real booking. Wrapping both in one transaction guarantees the
  // seat UPDATE rolls back whenever the booking INSERT doesn't commit.
  const booking = await db.transaction(async (tx) => {
    const seat = await reserveSeatRow(seatId, tx);
    if (!seat) {
      throw new SeatUnavailableError(seatId);
    }

    const [inserted] = await tx
      .insert(bookings)
      .values({ seatId, userId, status: "pending", holdExpiresAt })
      .returning();

    return inserted;
  });

  // Schedule the hold-expiry job right after the reservation commits, using
  // the same holdExpiresAt timestamp just written to the booking row --
  // BullMQ computes the delay from it and fires the job exactly once when
  // the hold window closes (see hold-expiry.worker.ts for what runs then).
  // This has to happen after the transaction, not inside it: the job needs
  // the committed booking's id, and scheduling work against a booking that
  // might still roll back would be wasted at best, wrong at worst.
  //
  // Same resilience posture as the Kafka publish below: a scheduling
  // failure (e.g. a Redis hiccup) must not turn a successfully committed
  // reservation into a failed request. The DB commit already happened and
  // is the source of truth, so this is logged and swallowed rather than
  // surfaced as a 500 -- a reservation stuck without an expiry job is a bad
  // outcome, but silently discarding the seat the DB already committed to
  // this user would be worse.
  if (booking) {
    try {
      await scheduleHoldExpiry(booking.id, holdExpiresAt);
    } catch (err) {
      console.error("[booking] failed to schedule hold-expiry job after commit", {
        bookingId: booking.id,
        seatId,
        userId,
        err,
      });
    }
  }

  // Kafka publish stays outside the transaction — it's a side effect, not
  // part of the DB's atomicity boundary, and shouldn't hold the transaction
  // open while waiting on the broker.
  //
  // It must also not be allowed to turn a committed reservation into a
  // failed request. The DB transaction above already committed: the seat is
  // durably 'held' and the booking row exists. If publishBookingEvent threw
  // here unguarded, that exception would propagate out of reserveSeat, the
  // controller would surface a 500, and the client would be told the
  // reservation failed — while the seat is actually stuck 'held' against a
  // real booking it doesn't know about. Worse, the client can't even retry:
  // a retry hits the now-held seat and gets a 409 SeatUnavailableError. The
  // DB is the source of truth for whether the reservation happened, so a
  // broker hiccup is logged and swallowed rather than reported as the
  // request's failure.
  try {
    await publishBookingEvent("booking.created", {
      bookingId: booking?.id,
      seatId,
      userId,
      holdExpiresAt: holdExpiresAt.toISOString(),
    });
  } catch (err) {
    console.error("[booking] failed to publish booking.created event after commit", {
      bookingId: booking?.id,
      seatId,
      userId,
      err,
    });
  }

  return booking;
}
