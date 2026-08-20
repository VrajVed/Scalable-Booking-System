import { eq } from "drizzle-orm";
import { db } from "../../../infrastructure/database/db.js";
import { users } from "../../../infrastructure/database/schema/index.js";

export async function findUserByEmail(email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row ?? null;
}

export async function createUser(input: { email: string; passwordHash: string }) {
  const [row] = await db.insert(users).values(input).returning();
  if (!row) throw new Error("failed to create user");
  return row;
}
