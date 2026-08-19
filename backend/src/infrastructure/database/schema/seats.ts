import { integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { events } from "./events.js";

// version supports optimistic-concurrency reservation: UPDATE ... WHERE
// id = $1 AND version = $2. status flows available -> held -> booked; the
// CDC consumer watches this table for zero-polling cache invalidation.
export const seats = pgTable(
  "seats",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    section: text("section").notNull(),
    rowLabel: text("row_label").notNull(),
    seatNumber: integer("seat_number").notNull(),
    status: text("status", { enum: ["available", "held", "booked"] })
      .notNull()
      .default("available"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.eventId, table.section, table.rowLabel, table.seatNumber)],
);
