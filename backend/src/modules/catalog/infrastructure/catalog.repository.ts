import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../infrastructure/database/db.js";
import { events, seats, venues } from "../../../infrastructure/database/schema/index.js";

// Read-only browse path: no auth needed to see what's on sale, same as any
// real ticketing site. Only reserveSeat (and everything past it) requires a
// logged-in user.
export async function listEvents() {
  return db
    .select({
      id: events.id,
      name: events.name,
      startsAt: events.startsAt,
      status: events.status,
      venueId: venues.id,
      venueName: venues.name,
      venueCity: venues.city,
    })
    .from(events)
    .innerJoin(venues, eq(events.venueId, venues.id))
    .orderBy(asc(events.startsAt));
}

export async function findEventById(eventId: number) {
  const [row] = await db.select().from(events).where(eq(events.id, eventId));
  return row ?? null;
}

// Uses idx_seats_event_status (see schema/seats.ts) -- this is the exact
// (eventId, status) lookup that index exists for.
//
// limit is optional and defaults to unbounded (existing callers/tests keep
// getting every row) -- added after a real event turned up with ~400k
// seats (leftover load-test seed data): fetching and rendering all of them
// isn't just a load-test-data quirk, it's a genuine scalability gap any
// large real venue would also hit.
export async function listSeatsForEvent(eventId: number, status?: "available" | "held" | "booked", limit?: number) {
  const query = db
    .select()
    .from(seats)
    .where(status ? and(eq(seats.eventId, eventId), eq(seats.status, status)) : eq(seats.eventId, eventId))
    .orderBy(asc(seats.section), asc(seats.rowLabel), asc(seats.seatNumber));

  return limit ? query.limit(limit) : query;
}
