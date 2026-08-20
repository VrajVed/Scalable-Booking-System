# Ticket 0006: no Drizzle migrations exist; db:generate will conflict with init.sql

Status: **closed**. Type: `wayfinder:task` (AFK). Resolved by opencode
deepseek-v4-flash-free --variant max, 2026-08-20 (two sessions — first hit
its limit mid-investigation, continuation finished it).

## Resolution

Option A (baseline migration + mark-as-applied), as CLAUDE.md documents
`db:generate`/`db:migrate` as working commands. Along the way found and
fixed a real index-drift bug the first session surfaced: the Drizzle
schema was missing 2 indexes `init.sql` actually has
(`idx_seats_event_status`, `idx_bookings_seat`) — added them to the
`pgTable` definitions so the generated baseline now matches `init.sql`
exactly (verified: `drizzle-kit generate` reports "no schema changes"
after the fix).

`drizzle-kit 0.31.10` has no "mark as applied" flag, so the resolution
reverse-engineered the migrator's own bookkeeping from
`node_modules/drizzle-kit` source (a `drizzle.__drizzle_migrations` table,
row = sha256 of the migration file + the journal's `when` timestamp) and
verified the hand-inserted row is byte-identical to what drizzle-kit
itself would write, by letting it apply to a scratch DB and diffing.
Applied to both the docker-compose Postgres (71 seats/63 bookings, data
untouched) and the kind cluster's Postgres (2 seats/2 bookings, data
untouched) — both now `db:migrate` cleanly as a no-op.

Tested the actual failure mode too: spun up a genuinely fresh
`postgres:16-alpine` container with no `init.sql`, confirmed `db:migrate`
creates the full correct schema from scratch and is idempotent on rerun.

Built `backend/scripts/baseline-migrations.ts` (+ `npm run db:baseline`)
so a future contributor cloning fresh and running `docker compose up` (init.sql
creates the schema, leaving no tracking rows) has a one-command fix instead
of hitting the original bug — documented in `infra/postgres/init.sql`'s
header and `CLAUDE.md`'s Commands section.

Full report: [context/0006-drizzle-migrations-report.md](../context/0006-drizzle-migrations-report.md).

## Question

Graduated from ticket 0005's area-1 finding. `backend/drizzle.config.ts`
configures a migrations output dir
(`src/infrastructure/database/migrations/`) that has never been generated —
nothing has run `npm run db:generate`. The schema TypeScript files and
`infra/postgres/init.sql` are in sync today (verified column-for-column),
but the moment someone runs `npm run db:generate`, Drizzle will emit a full
baseline `CREATE TABLE` migration with no prior snapshot, and
`npm run db:migrate` against a database `init.sql` already created will
fail with "relation already exists" on every table.

Resolve by picking one of these (or a better option) and implementing it:
- **Option A**: generate a baseline migration now, then mark it as already
  applied against any existing database (Drizzle supports a "baseline"/
  already-applied marking — check current drizzle-kit version's mechanism)
  so `init.sql` and the migration history agree from this point forward.
- **Option B**: drop the migration tooling entirely — remove
  `db:generate`/`db:migrate` from `package.json`, keep `init.sql` as the
  single source of truth, document why (a single-service portfolio project
  may not need migration history at all).
- Whichever you choose, the two must not both claim authority — pick one
  and make the other clearly deprecated/removed, not silently ignored.

Live verification: after implementing, actually run whichever command
remains meaningful against a fresh Postgres (or the live kind cluster's)
and confirm it does what it now claims to do.
