# AI-Powered Scalable Booking System

A full-stack, event-ticketing platform built to show what production-grade
distributed systems design actually looks like — not a CRUD app with extra
steps. It handles the two hard problems every ticketing site has: **seats
selling out in real time under concurrent demand**, and **keeping every
browser's seat map in sync without hammering the server**.

## What it does

- Browse events, pick seats on a live seat map, and book them — with the
  same optimistic-concurrency guarantees that stop two people from ever
  buying the same seat, even under simultaneous load.
- Watch seats grey out **live** the instant someone else books them — no
  page refresh, no polling loop burning server cycles. A change hits the
  database and is on every other open browser tab within milliseconds.
- Traffic is spread across backend instances by a **custom-built load
  balancer written in Rust**, using the Power of Two Choices algorithm with
  real-time health signals (latency, errors, in-flight requests) — not a
  generic round-robin.

## How it works

```
                        ┌──────────────┐
                        │  web client  │   React + TypeScript, browses events, picks
                        └──────┬───────┘   seats, watches them update live
                     HTTP + WS │
                                ▼
                        ┌─────────────┐
                        │  lb-proxy   │   Rust — smart traffic routing with
                        └──────┬──────┘   real-time backend health awareness
                                │
                                ▼
                  booking-backend (× N)   Node.js + TypeScript, concurrency-safe
                        │                 seat reservations, live WebSocket updates
                        ▼
    ┌──────────────────────────────────────────────────────────┐
    │  Postgres ──► Debezium ──► Kafka                          │
    │                               │                           │
    │                               └──► change-data-capture consumer
    │                                          │
    │                                          ├──► Redis (cache invalidation)
    │                                          └──► live push to every browser
    │                                               watching that event —
    │                                               zero polling, end to end
    └──────────────────────────────────────────────────────────┘
```

Every database write is picked up straight off Postgres's replication
stream and streamed out to Kafka, then fanned out to caches and open
browser tabs — the same event-driven pattern used by companies running
real-time systems at scale, instead of the common (and much weaker)
approach of polling the database on a timer.

## Tech stack

**Backend:** Node.js, TypeScript, Fastify, PostgreSQL, Redis
**Real-time data pipeline:** Kafka, Debezium (CDC), WebSockets
**Load balancing:** Rust
**Frontend:** React, TypeScript, Tailwind CSS
**Auth:** JWT
**Infra:** Docker Compose, Kubernetes
**Observability:** Prometheus, Grafana

## Running it locally

```bash
cd infra
cp .env.example .env
docker compose up -d
# wait for connect-init to log "Connector registered"

cd ../backend
cp .env.example .env
npm install
npm run dev
```

```bash
cd frontend
cp .env.example .env
npm install
npm run dev              # http://localhost:5173
```

Open two browser tabs on the same event's seat picker, reserve a seat in
one, and watch it grey out in the other — instantly, with no refresh.

## Under the hood

- **Concurrency-safe seat reservation** — seat state (available → held →
  booked) transitions with a single atomic database update, so two
  simultaneous requests for the same seat can't both succeed.
- **Custom Rust load balancer** — routes every request using Power of Two
  Choices plus live health-signal overrides (latency, error rate, in-flight
  count), tested with real integration tests against real sockets.
- **Zero-polling real-time sync** — a database write flows through
  Postgres's write-ahead log → Debezium → Kafka → a consumer that
  invalidates Redis cache *and* pushes a WebSocket update to every
  connected client — nothing on a timer, anywhere.
- **Kubernetes-ready** — manifests for a full cluster (ingress, autoscaling,
  the Rust load balancer in front of backend pods), load-tested with
  real traffic generation, not simulated numbers.
- **Stateless JWT auth** — any backend instance can verify a request with
  no shared session store, which matters because the load balancer routes
  every request independently with no sticky sessions.
