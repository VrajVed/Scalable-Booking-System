# AI-Powered Scalable Booking System

A scalable event-ticketing backend (Postgres → Debezium → Kafka → Node/Fastify → Redis)
built to demonstrate distributed-systems fundamentals: CDC-driven cache invalidation,
optimistic-concurrency seat reservation, and a Rust P2C load balancer in front of
multiple backend instances. See `idea.md` for the pitch and `context.md` for full
background — this file is just "how do I run it."

## Architecture

```
         client
           │
           ▼
    ┌─────────────┐
    │  lb-proxy   │   Rust — P2C routing (router-core) + real-time
    └──────┬──────┘   health-signal overrides, routes every request independently
           │
           ▼
    booking-backend (× N)   Fastify + TypeScript, DDD/hexagonal, optimistic-
           │                concurrency seat reservation
           ▼
    ┌──────────────────────────────────────────┐
    │  Postgres ──► Debezium ──► Kafka          │
    │                               │           │
    │                               └──► CDC consumer ──► Redis
    │                                    (cache invalidation, zero polling)
    └──────────────────────────────────────────┘
```

## Status

Phase 1 (Kafka + CDC wired into the backend) and Phase 2 (Rust reverse-proxy LB) are
done and tested end-to-end. Phase 3 (k8s) manifests are in `k8s/` — kind/manifests
for a full cluster with nginx ingress, HPA, and P2C lb-proxy. Phase 4 (load testing)
is done: `load-test/` contains autocannon scripts (`reserve-auth-load-test.js`,
`p2c-uniform.json`, etc.) and verified results.

## What's here

- `infra/` — Docker Compose: Postgres 16 (logical replication) + Kafka (KRaft) +
  Kafka Connect/Debezium + Redis + Prometheus + Grafana. Connector auto-registers on
  `docker compose up`; Prometheus scrapes backend + lb-proxy; Grafana auto-provisions
  its Prometheus datasource.
- `backend/` — Node.js + Fastify + TypeScript. DDD/hexagonal vertical slices.
  Booking module with optimistic-concurrency seat reservation flow, a Kafka producer
  for `booking.events`, and a Kafka consumer that maps Debezium's CDC envelope on the
  `seats` table to Redis cache invalidation — zero polling.
- `router-core/` — vendored Rust library crate (P2C routing + ArcSwap scoreboard +
  safety overrides), 15 passing tests.
- `lb-proxy/` — Rust reverse proxy wrapping router-core: routes each request via
  P2C, feeds real latency/5xx/in-flight signals back into the scoreboard. 4 passing
  integration tests (real sockets, fake backends). See `lb-proxy/README.md`.
- `k8s/` — Kubernetes manifests (kind cluster with nginx ingress, HPA, P2C lb-proxy,
  6 YAML files covering postgres/kafka/redis/connect/backends/ingress). Load test
  scripts verified on real kind cluster.
- `docs/adr/` — 3 accepted ADRs: 0001 (k8s headless backend), 0002 (local JWT auth
  instead of Clerk), 0003 (Prometheus + Grafana observability).

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
docker exec booking-system-postgres psql -U booking_system -d booking_system -c \
  "INSERT INTO venues (name, city) VALUES ('Wankhede Stadium', 'Mumbai');"
docker exec booking-system-postgres psql -U booking_system -d booking_system -c \
  "INSERT INTO events (venue_id, name, starts_at) VALUES (1, 'IPL Final', now() + interval '7 days');"
docker exec booking-system-postgres psql -U booking_system -d booking_system -c \
  "INSERT INTO seats (event_id, section, row_label, seat_number) VALUES (1, 'A', '1', 1);"

# reserve a seat via JWT auth (ADR 0002):
# 1) Register a user and get a token
TOKEN=$(curl -s http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' -d '{"email":"demo@example.com","password":"correct-horse-battery"}' \
  | jq -r .token)
# 2) Reserve a seat using the token via Authorization header
curl -X POST http://localhost:3000/bookings/reserve \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"seatId": 1}'
```

A second reservation attempt on the same seat returns `409 SEAT_UNAVAILABLE`. Watch
the backend logs for `[kafka] invalidated cache seats:availability:event:<id>` — that
line firing without any polling loop is the whole point of the CDC pipeline.

## Rust load balancer

```bash
cd router-core && cargo test   # the P2C/scoreboard library, 15 tests

cd lb-proxy
BACKEND_POOL=http://localhost:3000 cargo run   # proxy in front of the backend
cargo test                                     # 4 integration tests
```

See `lb-proxy/README.md` for env vars and how the routing/feedback loop works. The
ML layer from the source repo was intentionally left out of both crates; see
`CLAUDE.md` for why.

## Observability

Backend `/metrics` and lb-proxy `/metrics` are Prometheus scrape targets. Running
`docker compose up -d` also brings up Prometheus (:9090) and Grafana (:3001) with the
datasource auto-provisioned. See ADR 0003 for detail.