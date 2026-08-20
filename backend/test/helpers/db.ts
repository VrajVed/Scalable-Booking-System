import { randomUUID } from "node:crypto";
import { db } from "../../src/infrastructure/database/db.js";
import { seats } from "../../src/infrastructure/database/schema/seats.js";
import { events } from "../../src/infrastructure/database/schema/events.js";
import { venues } from "../../src/infrastructure/database/schema/venues.js";
import { bookings } from "../../src/infrastructure/database/schema/bookings.js";
import { users } from "../../src/infrastructure/database/schema/users.js";
import { eq } from "drizzle-orm";

// Test fixtures live under a dedicated venue/event so they never collide
// with whatever data is already sitting in the shared dev database, and are
// cleanly removable afterward.
export async function createTestVenue(): Promise<number> {
  const [venue] = await db
    .insert(venues)
    .values({ name: "adversarial-test-venue", city: "test-city" })
    .returning();
  if (!venue) throw new Error("failed to create test venue");
  return venue.id;
}

export async function createTestEvent(venueId: number): Promise<number> {
  const [event] = await db
    .insert(events)
    .values({ venueId, name: "adversarial-test-event", startsAt: new Date() })
    .returning();
  if (!event) throw new Error("failed to create test event");
  return event.id;
}

export async function createTestSeat(
  eventId: number,
  overrides: Partial<{ section: string; rowLabel: string; seatNumber: number; status: "available" | "held" | "booked" }> = {},
): Promise<number> {
  const [seat] = await db
    .insert(seats)
    .values({
      eventId,
      section: overrides.section ?? "A",
      rowLabel: overrides.rowLabel ?? "1",
      seatNumber: overrides.seatNumber ?? Math.floor(Math.random() * 1_000_000),
      status: overrides.status ?? "available",
    })
    .returning();
  if (!seat) throw new Error("failed to create test seat");
  return seat.id;
}

// bookings.user_id is a real FK now (ADR 0002) -- tests need an actual
// users row to point at, not just any string.
export async function createTestUser(): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({ email: `test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  return user.id;
}

export async function deleteTestUser(userId: number): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

export async function getSeat(seatId: number) {
  const [row] = await db.select().from(seats).where(eq(seats.id, seatId));
  return row ?? null;
}

export async function getBookingsForSeat(seatId: number) {
  return db.select().from(bookings).where(eq(bookings.seatId, seatId));
}

export async function getBookingById(bookingId: number) {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  return row ?? null;
}

// Inserts a booking row directly in 'pending' status with a caller-supplied
// holdExpiresAt, bypassing reserveSeat's transaction. Used by hold-expiry
// tests that need a short holdExpiresAt (so the delayed BullMQ job fires
// quickly) rather than the real HOLD_DURATION_MS window reserveSeat uses.
export async function createTestBooking(
  seatId: number,
  userId: number,
  holdExpiresAt: Date,
  status: "pending" | "confirmed" | "cancelled" | "expired" = "pending",
): Promise<typeof bookings.$inferSelect> {
  const [booking] = await db
    .insert(bookings)
    .values({ seatId, userId, status, holdExpiresAt })
    .returning();
  if (!booking) throw new Error("failed to create test booking");
  return booking;
}

export async function cleanupTestData(venueId: number): Promise<void> {
  const eventRows = await db.select().from(events).where(eq(events.venueId, venueId));
  for (const event of eventRows) {
    const seatRows = await db.select().from(seats).where(eq(seats.eventId, event.id));
    for (const seat of seatRows) {
      await db.delete(bookings).where(eq(bookings.seatId, seat.id));
    }
    await db.delete(seats).where(eq(seats.eventId, event.id));
  }
  await db.delete(events).where(eq(events.venueId, venueId));
  await db.delete(venues).where(eq(venues.id, venueId));
}
