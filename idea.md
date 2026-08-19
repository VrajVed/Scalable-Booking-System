# AI-Powered Scalable Booking System — Event Ticketing Platform

## The Pitch

A production-grade, scalable backend system for live event ticketing (concerts, movies, sports).
Built to handle flash-sale traffic spikes where 100K+ users compete for 500 seats in 30 seconds.

Every infrastructure choice is justified by the domain — nothing is bolted on for resume padding.

## Why This Domain

- **Flash sales** = massive, unpredictable traffic spikes → intelligent load balancer earns its keep
- **Booking → Payment → Confirmation** = multi-step event flows → Kafka as event backbone
- **Seat availability across instances** = cache consistency problem → CDC (Postgres WAL → Debezium → Kafka → Redis cache invalidation)
- **Multiple services** (booking, payment, notification, search) → Kubernetes orchestration
- **Indian recruiters** instantly relate to BookMyShow / Ticketmaster / Paytm Insider

## What Makes It Cool

1. **Intelligent load balancer** (Rust) — Power of Two Choices + real-time health signal overrides. No ML hand-waving — proven algorithms with measurable P95/P99 improvement over round-robin.
2. **Real CDC pipeline** — Postgres WAL → Debezium → Kafka → cache invalidation. Zero polling. A database write flows through the WAL to every consumer.
3. **Production architecture** — DDD + Hexagonal, background jobs with retry/DLQ, rate limiting, auth, security headers.
4. **Load-tested** — autocannon benchmarks proving the system handles flash-sale traffic with graceful degradation.
5. **Kubernetes-deployed** — real manifests, HPA, ingress, CI/CD pipeline.

## Components (Merging 3 Existing Projects)

### From CDC Pipeline (~/Programming/PracticePrograms/CDC_pipeline/)
- Docker Compose: Postgres 16 (wal_level=logical) + Debezium + Kafka (KRaft) + Kafka Connect
- Debezium connector config, auto-registration
- Node.js KafkaJS consumer + Debezium envelope mapper
- SSE event streaming pattern (reused for real-time seat updates)

### From Predictive Load Balancer (~/Programming/PersonalProjects/loadBalancingPredictive/)
- Rust router-core: P2C routing (< 1µs per decision), ArcSwap lock-free scoreboard
- Fast safety overrides: backlog / 5xx / in-flight penalties (multiplicative)
- 7 safety invariants: smoothing, shift cap, domain cap, exploration floor, normalization
- ML layer: SHELVED (synthetic data, not trusted). P2C + health signals stand alone.

### From Scalable Backend System (~/Programming/Scalable-Backend-System/)
- Node.js + Fastify + TypeScript runtime (ported from the source repo's Bun runtime)
- Drizzle ORM + PostgreSQL
- BullMQ + Redis (background jobs: email, notifications, payment processing)
- Clerk authentication
- DDD + Hexagonal vertical slice architecture
- 10 ADRs documenting decisions
- Redis rate limiting, security headers, request IDs
- DLQ monitoring, Bull Board admin UI

## Services (Target Architecture)

```
                    ┌──────────────────────────────────┐
                    │     Rust Load Balancer (P2C)      │
                    │   ArcSwap scoreboard + overrides   │
                    └──────────┬───────────┬───────────┘
                               │           │
                    ┌──────────▼──┐  ┌─────▼────────┐
                    │ Booking API │  │ Payment API  │
                    │  (Fastify)  │  │  (Fastify)   │
                    └──────┬──────┘  └──────┬───────┘
                           │                │
                    ┌──────▼────────────────▼───────┐
                    │         Kafka (KRaft)          │
                    │  booking.events | payment.events│
                    └──────┬────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
     ┌────────▼───┐  ┌────▼─────┐  ┌───▼──────────┐
     │  Debezium  │  │  Worker  │  │ Notification │
     │  (CDC)     │  │ (BullMQ) │  │   Service    │
     └────────┬───┘  └──────────┘  └──────────────┘
              │
     ┌────────▼───────────────────┐
     │  PostgreSQL 16 (logical)    │
     │  REPLICA IDENTITY FULL      │
     └────────────────────────────┘
```

## Non-Goals (For Now)

- ML-based predictive routing (shelved until validated on real telemetry)
- Mobile app / frontend SPA (API-first; frontend is a thin demo)
- Multi-tenant SaaS
- Payment gateway integration (simulate payment flow, don't process real money)
- Search service (Elasticsearch) — Phase 2

## Success Criteria

- `kubectl apply -f k8s/` brings up the full system on a local cluster (kind/minikube)
- autocannon load test shows P2C LB outperforming round-robin under flash-sale pattern
- CDC pipeline demonstrates cache invalidation with zero polling
- README has an architecture diagram that a recruiter can understand in 30 seconds
