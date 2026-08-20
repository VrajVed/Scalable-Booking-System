import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// passwordHash stores scrypt output as `${saltHex}:${hashHex}` (see
// shared/crypto/password.ts) -- never a plaintext or reversibly-encrypted
// password.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
