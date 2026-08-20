import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../../config/env.js";
import * as schema from "./schema/index.js";

// "require" assumed NODE_ENV=production implies a TLS-terminated Postgres
// endpoint (e.g. a managed cloud DB) — but this project's own Postgres is a
// self-hosted in-cluster StatefulSet with no TLS certs configured, so
// "require" hard-fails every connection in k8s ("Client network socket
// disconnected before secure TLS connection was established"). "prefer"
// still uses TLS opportunistically when the server offers it, without
// assuming a specific deployment topology.
const client = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 2,
  ssl: "prefer",
});

export const db = drizzle(client, { schema });

// Exposed only so tests (and graceful-shutdown hooks, if added later) can
// close the pool explicitly instead of leaving open handles that keep the
// process alive.
export const closeDb = () => client.end();
