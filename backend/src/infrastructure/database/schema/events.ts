import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { venues } from "./venues.js";

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  venueId: integer("venue_id")
    .notNull()
    .references(() => venues.id),
  name: text("name").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["scheduled", "cancelled", "completed"] })
    .notNull()
    .default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
