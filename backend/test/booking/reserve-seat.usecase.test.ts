import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { reserveSeat } from "../../src/modules/booking/application/reserve-seat.usecase.js";
import { SeatNotFoundError, SeatUnavailableError } from "../../src/modules/booking/domain/booking.errors.js";
import {
  connectProducer,
  disconnectProducer,
  isProducerConnected,
  publishBookingEvent,
} from "../../src/infrastructure/kafka/producer.js";
import { closeHoldExpiryQueue } from "../../src/infrastructure/queue/hold-expiry.queue.js";
import { redisConnection } from "../../src/config/redis.js";
import { closeDb } from "../../src/infrastructure/database/db.js";
import {
  createTestVenue,
  createTestEvent,
  createTestSeat,
  createTestUser,
  deleteTestUser,
  getSeat,
  getBookingsForSeat,
  cleanupTestData,
} from "../helpers/db.js";

let venueId: number;
let eventId: number;
let userId: number;

before(async () => {
  await connectProducer();
  venueId = await createTestVenue();
  eventId = await createTestEvent(venueId);
  userId = await createTestUser();
});

after(async () => {
  await cleanupTestData(venueId);
  await deleteTestUser(userId);
  // Close the Kafka producer connection, the ioredis client pulled in via
  // the hold-expiry queue module (see booking.controller.test.ts), the
  // BullMQ hold-expiry queue, and the Postgres pool explicitly -- otherwise
  // their open handles keep the process alive and `tsx --test` hangs
  // indefinitely after the last test finishes instead of exiting.
  await disconnectProducer();
  await redisConnection.quit();
  await closeHoldExpiryQueue();
  await closeDb();
});

describe("reserveSeat — happy path", () => {
  it("holds the seat and creates a pending booking", async () => {
    const seatId = await createTestSeat(eventId);

    const booking = await reserveSeat({ seatId, userId });

    assert.equal(booking?.status, "pending");
    assert.equal(booking?.seatId, seatId);

    const seat = await getSeat(seatId);
    assert.equal(seat?.status, "held");
  });
});

describe("reserveSeat — error paths", () => {
  it("throws SeatNotFoundError (404) when the seat does not exist", async () => {
    await assert.rejects(
      () => reserveSeat({ seatId: 999_999_999, userId }),
      (err: unknown) => {
        assert.ok(err instanceof SeatNotFoundError);
        assert.equal((err as SeatNotFoundError).statusCode, 404);
        assert.equal((err as SeatNotFoundError).code, "SEAT_NOT_FOUND");
        return true;
      },
    );
  });

  it("throws SeatUnavailableError (409) when the seat is already held", async () => {
    const seatId = await createTestSeat(eventId, { status: "held" });

    await assert.rejects(
      () => reserveSeat({ seatId, userId }),
      (err: unknown) => {
        assert.ok(err instanceof SeatUnavailableError);
        assert.equal((err as SeatUnavailableError).statusCode, 409);
        assert.equal((err as SeatUnavailableError).code, "SEAT_UNAVAILABLE");
        return true;
      },
    );
  });

  it("throws SeatUnavailableError (409) when the seat is already booked", async () => {
    const seatId = await createTestSeat(eventId, { status: "booked" });

    await assert.rejects(
      () => reserveSeat({ seatId, userId }),
      (err: unknown) => err instanceof SeatUnavailableError,
    );
  });
});

describe("reserveSeat — transactional integrity", () => {
  it("does not leave the seat stuck in 'held' when the booking insert fails after the seat UPDATE", async () => {
    const seatId = await createTestSeat(eventId);

    // Force the INSERT half of the operation to fail on a NOT NULL
    // constraint (bookings.user_id) *after* reserveSeatRow has already
    // flipped the seat to 'held'. If reserveSeat isn't wrapping both
    // statements in one transaction, the seat is left held forever with
    // no booking row pointing at it -- neither available nor genuinely
    // reserved. That's exactly the "stuck" state the system must never
    // produce.
    await assert.rejects(() =>
      reserveSeat({ seatId, userId: null as unknown as number }),
    );

    const seat = await getSeat(seatId);
    assert.equal(
      seat?.status,
      "available",
      `seat ${seatId} must roll back to 'available' when the booking insert fails, but was '${seat?.status}'`,
    );

    const seatBookings = await getBookingsForSeat(seatId);
    assert.equal(seatBookings.length, 0, "no orphaned booking row should exist");
  });
});

describe("reserveSeat — kafka publish failure resilience", () => {
  it("still returns the committed booking when the Kafka publish fails after the DB transaction commits", async () => {
    // The DB transaction (seat UPDATE + booking INSERT) is the atomicity
    // boundary and the source of truth. Disconnecting the shared producer
    // deterministically reproduces a post-commit publish failure (kafkajs
    // rejects producer.send() with "The producer is disconnected" once
    // disconnected) without needing to fake a broker outage.
    //
    // The premise of this test — that a publish against the disconnected
    // producer really does fail — is verified explicitly below (assert.rejects
    // on the real publishBookingEvent) rather than assumed, so the test can't
    // silently stop exercising the failure path if kafkajs's disconnected
    // behavior ever changes.
    await disconnectProducer();
    assert.equal(
      isProducerConnected(),
      false,
      "premise check: the producer must be disconnected before the failure-path assertions",
    );
    await assert.rejects(
      () =>
        publishBookingEvent("booking.created", {
          bookingId: 424_242,
          seatId: 0,
          userId: "premise-check",
          holdExpiresAt: new Date().toISOString(),
        }),
      "premise check: publishing against the disconnected producer must actually fail — " +
        "if this unexpectedly succeeds, this test is not exercising the failure path it claims to",
    );

    const seatId = await createTestSeat(eventId);
    let booking: Awaited<ReturnType<typeof reserveSeat>>;
    try {
      booking = await reserveSeat({ seatId, userId });
    } finally {
      // Reconnect so later suites (and this file's own `after` hook, which
      // calls disconnectProducer()) don't operate on an already-dead producer.
      await connectProducer();
    }

    assert.equal(
      booking?.status,
      "pending",
      "reserveSeat must resolve with the committed booking, not reject, when only the publish step fails",
    );
    assert.equal(booking?.seatId, seatId);

    const seat = await getSeat(seatId);
    assert.equal(
      seat?.status,
      "held",
      "the DB commit is the source of truth: the seat must be held regardless of publish failure",
    );

    const seatBookings = await getBookingsForSeat(seatId);
    assert.equal(seatBookings.length, 1, "exactly one booking row must exist despite the publish failure");
  });
});

describe("reserveSeat — real concurrency", () => {
  it("exactly one of N genuinely concurrent requests for the same seat succeeds", async () => {
    const seatId = await createTestSeat(eventId);
    const N = 25;

    const results = await Promise.allSettled(
      Array.from({ length: N }, () => reserveSeat({ seatId, userId })),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, `expected exactly 1 success, got ${fulfilled.length}`);
    assert.equal(rejected.length, N - 1);

    for (const r of rejected) {
      if (r.status === "rejected") {
        assert.ok(
          r.reason instanceof SeatUnavailableError,
          `expected SeatUnavailableError, got ${String(r.reason)}`,
        );
      }
    }

    const seat = await getSeat(seatId);
    assert.equal(seat?.status, "held");

    const seatBookings = await getBookingsForSeat(seatId);
    assert.equal(seatBookings.length, 1, "exactly one booking row must exist for the seat");
  });
});
