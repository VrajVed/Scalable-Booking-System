Ticket 0006 — Drizzle migrations vs init.sql: resolution report
================================================================

Date: 2026-08-20 (continuation of an aborted overnight dispatch on the same
ticket). Author: opencode deepseek-v4-flash-free. Evidence-first; every claim
below was verified against a live database.

Status: RESOLVED. Option A implemented (baseline migration exists, marked
already-applied on both live databases, zero drift, tooling intact).


What the previous session left
------------------------------

- Confirmed `npx drizzle-kit generate` works (drizzle-kit 0.31.10 installed,
  drizzle-orm 0.45.2; config auto-loads .env).
- Generated `migrations/0000_solid_proemial_gods.sql` + meta/ (untracked).
- Critical unfinished finding: that migration declared 0 indexes but
  `infra/postgres/init.sql` has 2 real indexes:
      idx_seats_event_status  ON seats(event_id, status)
      idx_bookings_seat       ON bookings(seat_id)
  The Drizzle pgTable definitions never declared them, so Drizzle was blind to
  them and would never generate them. Confirmed by reading init.sql directly
  (lines 47-48).


1. Index-drift fix
------------------

Added the missing Drizzle-managed index declarations in the pgTable third
argument (constraints) callback, named to match init.sql exactly:

- backend/src/infrastructure/database/schema/seats.ts
      index("idx_seats_event_status").on(table.eventId, table.status)
- backend/src/infrastructure/database/schema/bookings.ts
      index("idx_bookings_seat").on(table.seatId)
  (bookings got its first third-argument callback, matching the `index` /
  `unique` API shape in drizzle-orm 0.45 / drizzle-kit 0.31.)

Regeneration: the prior base 0000 was never applied anywhere (untracked,
created minutes earlier by the previous session), so it was cleanly replaced —
removed the migrations dir and ran `npx drizzle-kit generate` once, producing a
single complete baseline: `migrations/0000_right_firedrake.sql`.

Its DDL now matches init.sql for everything Drizzle manages:
- 4 tables (venues/events/seats/bookings), same columns, types, NOT NULLs,
  defaults (serial, text, timestamp with time zone default now()).
- Seats UNIQUE(event_id, section, row_label, seat_number) table constraint.
- 3 FKs (seats->events, events->venues, bookings->seats), same behavior
  (ON DELETE/UPDATE no action).
- Both indexes, names identical to init.sql, btree default:
      "idx_bookings_seat" ON "bookings" USING btree ("seat_id")
      "idx_seats_event_status" ON "seats" USING btree ("event_id","status")

Remaining, deliberate, documented differences (nothing Drizzle can express
without NEW drift, so they stay init.sql-only):
- REPLICA IDENTITY FULL on seats — runtime CDC requirement, not schema DDL.
- The 4 status CHECK constraints — Drizzle's `text(col, { enum })` emits plain
  text only; declaring them via check() would generate constraint names that
  never match the auto-named ones init.sql's live DB already has (initial
  damping only created `seats_status_check` etc.), i.e. it would ADD drift.
Both are now called out in the init.sql header so nobody "fixes" them blindly.

Drift-free proof:
- `npx drizzle-kit generate` after the fix reports
  "No schema changes, nothing to migrate" (schema snapshot == committed
  migration SQL).
- A fresh DB built from the migration shows the exact same tables/columns/
  constraints/index set that init.sql declares (see Fresh-DB scenario below).


2. Baseline-marking mechanism (why this one)
--------------------------------------------

drizzle-kit 0.31.10 has NO "already applied"/baseline flag (checked
`--help` on migrate/push/up; migrate accepts only --config). The pragmatic
alternative from the ticket was therefore used: seeded Drizzle's internal
migration-tracking table manually, using the exact bookkeeping the migrator
itself uses (read from the installed source before writing anything):

- node_modules/drizzle-kit uses drizzle-orm/postgres-js/migrator
  (migrator.js -> pg-core/dialect.js PgDialect.migrate).
- Tracking schema/table (defaults, no config override): schema `drizzle`,
  table `drizzle.__drizzle_migrations` with
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint.
- The migrator creates the schema/table with CREATE ... IF NOT EXISTS, reads
  the last row ORDER BY created_at DESC LIMIT 1, and re-applies a migration
  ONLY WHEN  last.created_at < journalEntry.when  — hashes are never compared.
- Migrator row content: hash = sha256 hex of the FULL raw migration .sql file
  text; created_at = the journal entry's `when` (epoch millis).

Confirmed empirically: after letting drizzle-kit apply the migration to a fresh
DB itself, its own tracking row said
  hash ac9baeb6742af0f13e579fab004bd97cad980eb45c00b8285e0cec0a83bfe487
  created_at 1787169402673
which matches sha256sum of 0000_right_firedrake.sql and meta/_journal.json's
`when` 1:1 — so the formula used for both live DBs is byte-identical to what
drizzle-kit would have written.

Marked as already-applied on:
- docker-compose Postgres (booking-system-postgres, localhost:5434,
  db booking_system) — real data: 71 seats / 63 bookings.
- kind cluster postgres-0 (via kubectl exec, db booking_system) — 2 seats /
  2 bookings.
The exact SQL run on each (ON_ERROR_STOP=1):
  CREATE SCHEMA IF NOT EXISTS drizzle;
  CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations
    (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
  INSERT INTO drizzle.__drizzle_migrations ("hash","created_at")
    VALUES ('ac9baeb6742af0f13e579fab004bd97cad980eb45c00b8285e0cec0a83bfe487', 1787169402673);

No tables were created, dropped, or truncated on either real database.
Pre-states verified: neither DB had a drizzle schema before marking.


3. Verification
---------------

Existing populated DB (docker-compose, 5434):
  npm run db:migrate  ->  exit 0, "migrations applied successfully", ONLY the
  two NOTICE-level "already exists, skipping" messages that drizzle-kit's own
  CREATE SCHEMA / CREATE TABLE IF NOT EXISTS emits on every run. NO
  "relation already exists" for any business table, no business-table DDL
  executed (the migrator's created_at gate skipped the single migration).
  Data intact afterward: 71 seats, 63 bookings; both indexes present;
  tracking row present.

Existing populated DB (kind postgres-0, the same via
  DATABASE_URL=postgres://booking_system:booking_system@localhost:15432/...):
  db:migrate -> exit 0, same no-op behavior. Data intact (2 seats / 2 bookings).

Fresh empty DB (true from-scratch scenario, not just by inspection — spun up a
throwaway postgres:16-alpine container, no init.sql):
  npm run db:migrate  ->  exit 0, full CREATE TABLE run; resulting schema has
  the exact table/index/constraint set init.sql declares (4 tables, 7 indexes,
  5 named PK/FK/UNIQUE constraints). Running db:migrate a second time no-ops,
  proving the idempotent behavior the baseline-marking relies on. Container
  was removed afterwards; nothing in the project's databases was touched by
  this test.


4. Making it reproducible for future contributors
-------------------------------------------------

The failure this ticket fixes would recur for anyone who clones the repo
fresh and runs `docker compose up` (init.sql creates the tables on a fresh
volume, leaving no tracking rows) and then `db:migrate`. Two scripts/docs
landed to close that gap:

- backend/scripts/baseline-migrations.ts + `npm run db:baseline`: reads
  meta/_journal.json, computes each migration's sha256 + `when`, and inserts
  the corresponding rows into drizzle.__drizzle_migrations (schema/table
  created if missing), skipping any already present. Same formula as the
  migrator (verified live: on a scratch DB via the script the row came out
  byte-identical to what drizzle-kit itself writes; re-running prints
  "already baselined"; running it against the already-marked 5434 DB no-ops).
- backend/package.json: added `"db:baseline": "tsx --env-file=.env
  scripts/baseline-migrations.ts"`. db:generate / db:migrate / db:studio are
  unchanged — they all work as documented now.
- infra/postgres/init.sql header: states that Drizzle baseline 0000 is the
  schema authority for tables/columns/indexes; that a DB already built by
  init.sql must get `npm run db:baseline` once before the first db:migrate;
  that on an empty DB db:migrate alone creates everything; and that the
  REPLICA IDENTITY and status CHECKs are deliberately init.sql-only.
- CLAUDE.md Commands: the Drizzle migrations line now documents the
  baseline-first step (was the only stale reference; nothing else in
  README/k8s/README references migrations).

Both paths now end correct:
  (a) existing/populated or init.sql-created DB  ->  npm run db:baseline once,
      then db:migrate no-ops cleanly forever after.
  (b) brand-new empty DB (no init.sql)          ->  npm run db:migrate creates
      the whole schema; no baseline step needed.


Scope / hygiene
---------------
Changed files (all verified, `git status`): CLAUDE.md, backend/package.json,
backend/src/infrastructure/database/schema/{bookings,seats}.ts,
backend/src/infrastructure/database/migrations/* (regenerated baseline, still
untracked), backend/scripts/baseline-migrations.ts (new),
infra/postgres/init.sql.
Not touched (hard rules): router-core/, lb-proxy/, k8s/ manifests,
backend/src/config/env.ts, backend/src/index.ts,
backend/src/shared/middleware/rateLimiter.ts, backend/src/modules/booking/.
No git commands ran (read-only `git status`/`git log` for context only); the
report is the only "commit" of authorship this session. `npm run build` passes
after all changes; `npx drizzle-kit generate` reports no schema changes.