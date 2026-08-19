# FlashSeat

A scalable event-ticketing backend (Postgres → Debezium → Kafka → Node/Fastify → Redis)
built to demonstrate distributed-systems fundamentals: CDC-driven cache invalidation,
optimistic-concurrency seat reservation, and (eventually) a Rust P2C load balancer in
front of multiple backend instances. See `idea.md` for the pitch and `context.md` for
full background — this file is just "how do I run it."

## Status

Phase 1 (Kafka + CDC wired into the backend) is done and tested end-to-end. Phase 2
(Rust reverse-proxy LB), Phase 3 (k8s), and Phase 4 (load testing) are not built yet.

## What's here

- `infra/` — Docker Compose: Postgres 16 (logical replication) + Kafka (KRaft) +
  Kafka Connect/Debezium + Redis. Connector auto-registers on `docker compose up`.
- `backend/` — Node.js + Fastify + TypeScript. DDD/hexagonal vertical slices.
  Booking module with an optimistic-concurrency seat reservation flow, a Kafka
  producer for `booking.events`, and a Kafka consumer that maps Debezium's CDC
  envelope on the `seats` table to Redis cache invalidation — zero polling.
- `router-core/` — vendored Rust crate (P2C routing + ArcSwap scoreboard + safety
  overrides), 15 passing tests. Not yet wrapped in a runnable reverse proxy.
- `k8s/`, `docs/adr/` — empty, later phases.

## Running it

Ports are chosen to avoid colliding with other local projects — check
`infra/.env.example` if you already run Postgres/Redis/Kafka locally on the
defaults (5432/6379/29092) and adjust as needed.

```bash
cd infra
cp .env.example .env
docker compose up -d
# wait for connect-init to log "Connector registered"

cd ../backend
cp .env.example .env    # match ports to infra/.env if you changed them
npm install
npm run dev
```

Then:

```bash
curl http://localhost:3000/health

# seed a venue/event/seat directly (no admin API yet)
docker exec flashseat-postgres psql -U flashseat -d flashseat -c \
  "INSERT INTO venues (name, city) VALUES ('Wankhede Stadium', 'Mumbai');"
docker exec flashseat-postgres psql -U flashseat -d flashseat -c \
  "INSERT INTO events (venue_id, name, starts_at) VALUES (1, 'IPL Final', now() + interval '7 days');"
docker exec flashseat-postgres psql -U flashseat -d flashseat -c \
  "INSERT INTO seats (event_id, section, row_label, seat_number) VALUES (1, 'A', '1', 1);"

curl -X POST http://localhost:3000/bookings/reserve \
  -H 'Content-Type: application/json' \
  -d '{"seatId": 1, "userId": "user_test123"}'
```

A second reservation attempt on the same seat returns `409 SEAT_UNAVAILABLE`. Watch
the backend logs for `[kafka] invalidated cache seats:availability:event:<id>` — that
line firing without any polling loop is the whole point of the CDC pipeline.

## Rust load balancer

```bash
cd router-core && cargo test
```

Library only for now — no reverse-proxy binary yet, so nothing to run against
traffic. The ML layer from the source repo was intentionally left out; see
`CLAUDE.md` for why.
