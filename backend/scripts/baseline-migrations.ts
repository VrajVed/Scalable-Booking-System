import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Marks every migration in meta/_journal.json as already-applied in the
// connected database, using exactly the same bookkeeping drizzle-orm's
// postgres-js migrator uses (see node_modules/drizzle-orm/migrator.js
// + pg-core/dialect.js): one row per migration in drizzle.__drizzle_migrations
// keyed on (sha256 of the raw .sql file, journal `when` millis). The
// migrator re-applies a migration only when the last recorded created_at is
// older than the journal's `when`, so marking 0000 makes `db:migrate` a no-op
// against databases whose tables were created by infra/postgres/init.sql
// instead of by the migration itself.
//
// Usage: npm run db:baseline  (DATABASE_URL wins over backend/.env)

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "infrastructure",
  "database",
  "migrations",
);

const journal = JSON.parse(
  readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
) as { entries: { tag: string; when: number }[] };

const client = postgres(process.env.DATABASE_URL!, { max: 5, connect_timeout: 5 });

try {
  await client`
    CREATE SCHEMA IF NOT EXISTS drizzle
  `;
  await client`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  for (const entry of journal.entries) {
    const sql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const inserted = await client`
      INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")
      SELECT ${hash}, ${entry.when}
      WHERE NOT EXISTS (
        SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash}
      )
    `;
    console.log(
      inserted.count === 1
        ? `baselined ${entry.tag} (already-applied)`
        : `already baselined: ${entry.tag}`,
    );
  }
} finally {
  await client.end();
}