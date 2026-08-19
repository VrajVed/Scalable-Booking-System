import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { seats } from "./seats.js";

export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  seatId: integer("seat_id")
    .notNull()
    .references(() => seats.id),
  userId: text("user_id").notNull(),
  status: text("status", { enum: ["pending", "confirmed", "cancelled", "expired"] })
    .notNull()
    .default("pending"),
  holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
