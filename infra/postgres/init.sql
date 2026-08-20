-- Runs once via /docker-entrypoint-initdb.d/ on first container start.
-- Schema authority: this file bootstraps the schema, and Drizzle's baseline
-- migration (backend/src/infrastructure/database/migrations/0000_*.sql)
-- reproduces it 1:1 for tables/columns/constraints/indexes. If you run
-- `npm run db:migrate` against a DB this file already created, it must be
-- marked as already-applied FIRST or it fails with "relation already exists":
--   cd backend && npm run db:baseline   (then db:migrate no-ops cleanly)
-- On a brand-new empty database (no init.sql), db:migrate alone creates the
-- whole schema — no baseline step needed. Things init.sql adds that Drizzle
-- does not manage (do not declare in backend/src/.../schema/): REPLICA
-- IDENTITY FULL on seats (Debezium "before" image) and the status CHECK
-- constraints (Drizzle's text-enum emits plain text only).
-- REPLICA IDENTITY FULL on seats is required so Debezium can emit the full
-- "before" image on UPDATE/DELETE (the default identity only includes the
-- PK) — the cache-invalidation consumer needs the old status to reason about
-- what changed.

CREATE TABLE IF NOT EXISTS venues (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seats (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  section TEXT NOT NULL,
  row_label TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, section, row_label, seat_number)
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  hold_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE seats REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_seats_event_status ON seats(event_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_seat ON bookings(seat_id);
