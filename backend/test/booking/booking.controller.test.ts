import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { bookingRoutes } from "../../src/modules/booking/interface/booking.routes.js";
import { errorHandler } from "../../src/shared/middleware/errorHandler.js";
import { signAuthToken } from "../../src/shared/auth/jwt.js";
import { connectProducer, disconnectProducer } from "../../src/infrastructure/kafka/producer.js";
import { closeHoldExpiryQueue } from "../../src/infrastructure/queue/hold-expiry.queue.js";
import { redisConnection } from "../../src/config/redis.js";
import { closeDb } from "../../src/infrastructure/database/db.js";
import {
  createTestVenue,
  createTestEvent,
  createTestSeat,
  createTestUser,
  deleteTestUser,
  getBookingsForSeat,
  cleanupTestData,
} from "../helpers/db.js";

let app: FastifyInstance;
let venueId: number;
let eventId: number;
let userId: number;
let authHeader: string;

before(async () => {
  await connectProducer();
  venueId = await createTestVenue();
  eventId = await createTestEvent(venueId);
  userId = await createTestUser();
  authHeader = `Bearer ${signAuthToken({ userId })}`;

  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(bookingRoutes, { prefix: "/bookings" });
  await app.ready();
});

after(async () => {
  await app.close();
  await cleanupTestData(venueId);
  await deleteTestUser(userId);
  // Importing the hold-expiry queue module pulls in src/config/redis.ts,
  // whose module-level ioredis client connects on import and (like the
  // BullMQ queue's own connection) otherwise keeps the event loop alive —
  // tsx --test then hangs after the tests finish instead of exiting.
  await redisConnection.quit();
  await closeHoldExpiryQueue();
  await closeDb();
});

describe("POST /bookings/reserve — auth", () => {
  it("401s with UNAUTHORIZED when no Authorization header is sent", async () => {
    const seatId = await createTestSeat(eventId);
    const res = await app.inject({ method: "POST", url: "/bookings/reserve", payload: { seatId } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "UNAUTHORIZED");
  });

  it("401s when the Authorization header isn't a Bearer token", async () => {
    const seatId = await createTestSeat(eventId);
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
      payload: { seatId },
    });
    assert.equal(res.statusCode, 401);
  });

  it("401s when the JWT is signed with a different secret", async () => {
    const seatId = await createTestSeat(eventId);
    const jwt = await import("jsonwebtoken");
    const forgedToken = jwt.default.sign({ userId }, "wrong-secret-not-the-real-one");
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: `Bearer ${forgedToken}` },
      payload: { seatId },
    });
    assert.equal(res.statusCode, 401);
  });
});

describe("POST /bookings/reserve — request validation", () => {
  it("400s when seatId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "VALIDATION_ERROR");
  });

  it("400s when seatId is 0", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: { seatId: 0 },
    });
    assert.equal(res.statusCode, 400);
  });

  it("400s when seatId is negative", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: { seatId: -5 },
    });
    assert.equal(res.statusCode, 400);
  });

  it("400s when seatId is a non-integer number", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: { seatId: 1.5 },
    });
    assert.equal(res.statusCode, 400);
  });

  it("400s when seatId is a non-numeric string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: { seatId: "not-a-number" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("silently strips unexpected extra fields (including a body-supplied userId) rather than trusting them", async () => {
    const seatId = await createTestSeat(eventId);
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: { seatId, userId: 999_999_999, isAdmin: true, __proto__: { polluted: true } },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(
      res.json().booking.userId,
      userId,
      "the booking must be attributed to the authenticated user from the JWT, not the spoofed body userId",
    );
    const bookingsForSeat = await getBookingsForSeat(seatId);
    assert.equal(bookingsForSeat.length, 1, "a booking row must actually be created by the reserve");
  });

  it("404s with SEAT_NOT_FOUND for a well-formed but nonexistent seatId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: { seatId: 999_999_999 },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, "SEAT_NOT_FOUND");
  });

  it("409s with SEAT_UNAVAILABLE for an already-held seat", async () => {
    const seatId = await createTestSeat(eventId, { status: "held" });
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: { seatId },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, "SEAT_UNAVAILABLE");
  });

  it("201s with a booking on a valid request, and the response never contains a stack trace", async () => {
    const seatId = await createTestSeat(eventId);
    const res = await app.inject({
      method: "POST",
      url: "/bookings/reserve",
      headers: { authorization: authHeader },
      payload: { seatId },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.booking.seatId, seatId);
    assert.equal(body.booking.userId, userId);
    assert.ok(!res.body.includes(".ts:"), "response body must not contain stack-trace-shaped file:line text");
  });
});
