import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { catalogRoutes } from "../../src/modules/catalog/interface/catalog.routes.js";
import { errorHandler } from "../../src/shared/middleware/errorHandler.js";
import { closeDb } from "../../src/infrastructure/database/db.js";
import { createTestVenue, createTestEvent, createTestSeat, cleanupTestData } from "../helpers/db.js";

let app: FastifyInstance;
let venueId: number;
let eventId: number;

before(async () => {
  venueId = await createTestVenue();
  eventId = await createTestEvent(venueId);

  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(catalogRoutes, { prefix: "/events" });
  await app.ready();
});

after(async () => {
  await app.close();
  await cleanupTestData(venueId);
  await closeDb();
});

describe("GET /events", () => {
  it("200s with no auth required, including the seeded event", async () => {
    const res = await app.inject({ method: "GET", url: "/events" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    const ids = body.events.map((e: { id: number }) => e.id);
    assert.ok(ids.includes(eventId));
  });

  it("includes the joined venue name/city, not just the venue id", async () => {
    const res = await app.inject({ method: "GET", url: "/events" });
    const event = res.json().events.find((e: { id: number }) => e.id === eventId);
    assert.ok(event, "premise check: the seeded event must be in the list");
    assert.equal(event.venueName, "adversarial-test-venue");
    assert.equal(event.venueCity, "test-city");
  });
});

describe("GET /events/:eventId/seats", () => {
  it("404s with EVENT_NOT_FOUND for a well-formed but nonexistent eventId", async () => {
    const res = await app.inject({ method: "GET", url: "/events/999999999/seats" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, "EVENT_NOT_FOUND");
  });

  it("400s for a non-numeric eventId", async () => {
    const res = await app.inject({ method: "GET", url: "/events/not-a-number/seats" });
    assert.equal(res.statusCode, 400);
  });

  it("lists every seat for the event with no status filter", async () => {
    const availableId = await createTestSeat(eventId, { status: "available" });
    const heldId = await createTestSeat(eventId, { status: "held" });

    const res = await app.inject({ method: "GET", url: `/events/${eventId}/seats` });
    assert.equal(res.statusCode, 200);
    const ids = res.json().seats.map((s: { id: number }) => s.id);
    assert.ok(ids.includes(availableId));
    assert.ok(ids.includes(heldId));
  });

  it("filters by status when ?status= is given", async () => {
    const availableId = await createTestSeat(eventId, { status: "available" });
    const bookedId = await createTestSeat(eventId, { status: "booked" });

    const res = await app.inject({ method: "GET", url: `/events/${eventId}/seats?status=booked` });
    assert.equal(res.statusCode, 200);
    const ids = res.json().seats.map((s: { id: number }) => s.id);
    assert.ok(ids.includes(bookedId), "the booked seat must be in a status=booked filter");
    assert.ok(!ids.includes(availableId), "an available seat must NOT be in a status=booked filter");
  });

  it("400s for an invalid status value", async () => {
    const res = await app.inject({ method: "GET", url: `/events/${eventId}/seats?status=not-a-real-status` });
    assert.equal(res.statusCode, 400);
  });
});
