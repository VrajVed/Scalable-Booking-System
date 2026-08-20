import { and, eq, sql, type ExtractTablesWithRelations } from "drizzle-orm";
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
