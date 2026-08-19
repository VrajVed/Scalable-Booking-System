import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../../config/env.js";
import * as schema from "./schema/index.js";

const client = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 2,
  ssl: env.NODE_ENV === "production" ? "require" : "prefer",
});

export const db = drizzle(client, { schema });
