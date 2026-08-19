import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../infrastructure/database/db.js";
import { seats } from "../../../infrastructure/database/schema/index.js";

// Optimistic concurrency: the UPDATE only succeeds if status is still
// 'available' at the moment it runs. Under flash-sale contention, N
// concurrent requests race this statement — Postgres serializes the row
// lock, exactly one UPDATE returns a row, the rest see zero rows affected
// and the use case surfaces that as SeatUnavailableError. No app-level lock
// needed.
export async function reserveSeatRow(seatId: number) {
  const [row] = await db
    .update(seats)
    .set({ status: "held", version: sql`${seats.version} + 1` })
    .where(and(eq(seats.id, seatId), eq(seats.status, "available")))
    .returning();

  return row ?? null;
}

export async function findSeatById(seatId: number) {
  const [row] = await db.select().from(seats).where(eq(seats.id, seatId));
  return row ?? null;
}
