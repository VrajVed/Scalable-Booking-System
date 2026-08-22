import { and, eq, inArray, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { db } from "../../../infrastructure/database/db.js";
import { seats } from "../../../infrastructure/database/schema/index.js";
import * as schema from "../../../infrastructure/database/schema/index.js";

// Anything with the same query-builder surface as `db` — either the pool
// itself or a `tx` handed in by db.transaction(...). Letting callers pass a
// transaction through is what lets reserveSeat() wrap the seat UPDATE and
// the booking INSERT in one atomic unit instead of two independent writes.
// `typeof db` alone isn't enough here: a transaction handle is missing the
// `$client` property the full `PostgresJsDatabase` type carries, so it
// fails structural typing against `typeof db` even though it supports every
// query-builder method actually used below.
type Transaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type DbExecutor = typeof db | Transaction;

// Optimistic concurrency: the UPDATE only succeeds if status is still
// 'available' at the moment it runs. Under flash-sale contention, N
// concurrent requests race this statement — Postgres serializes the row
// lock, exactly one UPDATE returns a row, the rest see zero rows affected
// and the use case surfaces that as SeatUnavailableError. No app-level lock
// needed.
export async function reserveSeatRow(seatId: number, executor: DbExecutor = db) {
  const [row] = await executor
    .update(seats)
    .set({ status: "held", version: sql`${seats.version} + 1` })
    .where(and(eq(seats.id, seatId), eq(seats.status, "available")))
    .returning();

  return row ?? null;
}

export async function findSeatById(seatId: number, executor: DbExecutor = db) {
  const [row] = await executor.select().from(seats).where(eq(seats.id, seatId));
  return row ?? null;
}

// Sibling of reserveSeatRow for the hold-expiry path: only releases the seat
// if it is still 'held' at the moment this runs. If the seat has already
// moved on (e.g. a confirm flow bumped it to 'booked' between the booking
// being read as 'pending' and this UPDATE executing), zero rows match and
// the caller sees that as a no-op rather than clobbering a state a
// concurrent request already advanced past.
export async function releaseSeatRow(seatId: number, executor: DbExecutor = db) {
  const [row] = await executor
    .update(seats)
    .set({ status: "available", version: sql`${seats.version} + 1` })
    .where(and(eq(seats.id, seatId), eq(seats.status, "held")))
    .returning();

  return row ?? null;
}

// The confirm-booking path's seat transition: only succeeds if the seat is
// still 'held' at the moment this runs -- same optimistic-concurrency shape
// as every other transition here. A seat that's already 'booked' (double
// confirm) or 'available' (hold already expired/released) means zero rows
// match, and confirm-booking.usecase.ts's own booking-status WHERE clause is
// the real race arbiter anyway; this is the seat-side half of that same
// atomicity guarantee.
export async function confirmSeatRow(seatId: number, executor: DbExecutor = db) {
  const [row] = await executor
    .update(seats)
    .set({ status: "booked", version: sql`${seats.version} + 1` })
    .where(and(eq(seats.id, seatId), eq(seats.status, "held")))
    .returning();

  return row ?? null;
}

// Cancel-booking's seat transition. A booking being cancelled can have been
// either 'pending' (seat 'held') or 'confirmed' (seat 'booked') -- and by
// the time this runs inside the transaction, an earlier read of the
// booking's status is no longer trustworthy (it could have changed between
// that read and this UPDATE). Rather than pick releaseSeatRow vs a
// booked-only variant based on a possibly-stale status, this matches EITHER
// prior state in one race-free statement: whichever it actually was at the
// moment this runs, it becomes 'available'.
export async function releaseHeldOrBookedSeatRow(seatId: number, executor: DbExecutor = db) {
  const [row] = await executor
    .update(seats)
    .set({ status: "available", version: sql`${seats.version} + 1` })
    .where(and(eq(seats.id, seatId), inArray(seats.status, ["held", "booked"])))
    .returning();

  return row ?? null;
}
