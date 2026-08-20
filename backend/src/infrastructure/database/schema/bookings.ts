import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { seats } from "./seats.js";
import { users } from "./users.js";

export const bookings = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),
    seatId: integer("seat_id")
      .notNull()
      .references(() => seats.id),
    // Ex-Clerk-ID free text field, now a real FK (ADR 0002). userId comes
    // from the verified JWT, never the request body -- see requireAuth.
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    status: text("status", { enum: ["pending", "confirmed", "cancelled", "expired"] })
      .notNull()
      .default("pending"),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // matches infra/postgres/init.sql: idx_bookings_seat
    index("idx_bookings_seat").on(table.seatId),
  ],
);
