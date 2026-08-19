# FlashSeat — Project Context

## What This Is

A scalable event ticketing backend built to impress Indian recruiters who filter for
distributed systems / backend infrastructure skills. The AI agentic work (harnesses,
cloud agents, Athena) is genuinely impressive but doesn't register with most Indian
recruiters. This project speaks their language: Kafka, Kubernetes, CDC, load balancing,
scalable backends, AWS/GCP.

## Why It Exists

Vraj has already built every component needed:

1. **CDC Pipeline** — A working Postgres → Debezium → Kafka → Node.js → React pipeline
   with zero polling. Real WAL, real Kafka, real SSE. Dockerized.
   Location: ~/Programming/PracticePrograms/CDC_pipeline/

2. **Predictive Load Balancer** — Rust router-core with P2C routing (<1µs per decision),
   lock-free ArcSwap scoreboard, 7 safety invariants, fast health-signal overrides.
   15 Rust tests pass. ML layer exists but is shelved (trained on synthetic data,
   not trusted for production claims).
   Location: ~/Programming/PersonalProjects/loadBalancingPredictive/

3. **Scalable Backend System** — Node + Fastify + Drizzle + BullMQ + Redis + Clerk auth.
   DDD + Hexagonal architecture, 10 ADRs, rate limiting, DLQ monitoring, security headers.
   Originally built on Bun; flashseat ports the same stack onto Node for a more
   battle-tested runtime. Early stage — only users module built so far.
   Location: ~/Programming/Scalable-Backend-System/ (GitHub: VrajVed/Scalable-Backend-System)

4. **Go Backend Skeleton** — Config loading (koanf), observability config, go.mod.
   Barely started. Available if we want a Go service alongside the TS one.
   Location: ~/Programming/PracticePrograms/prod-backend-go/

## The Gap

These are three disconnected demos. A recruiter looking at any one sees a cool project
but not a system. The gap is integration + deployment:
- No Kubernetes manifests
- No cloud deployment
- No load testing proving the LB works under real traffic
- CDC pipeline runs standalone, not feeding a real backend
- Rust LB has no real backends to route to

## The Merge Plan

### Phase 1 — Wire Kafka + CDC into the Backend
- Move CDC pipeline's docker-compose (Postgres + Debezium + Kafka) into flashseat
- Add Kafka producer to backend: booking/payment events → Kafka topics
- Add Kafka consumer: consume CDC events for Redis cache invalidation
- Result: Postgres → Debezium → Kafka → Backend → Redis cache invalidation

### Phase 2 — Integrate Rust Load Balancer
- Build a thin reverse proxy using the Rust router-core crate
- Sits in front of multiple backend instances, routes using P2C + health signals
- Backend instances report health (backlog, 5xx, in-flight) to the scoreboard
- k8s: 3+ backend pods, 1 LB pod

### Phase 3 — Kubernetes + Cloud Deploy
- Kubernetes manifests: Deployments, Services, ConfigMaps, Secrets, HPA
- Ingress controller (nginx or traefik)
- Deploy to AWS EKS or GCP GKE (local kind/minikube for dev/demo)
- GitHub Actions CI/CD: build → push to ECR/GCR → deploy

### Phase 4 — Load Test + Demo
- autocannon flash-sale simulation (burst traffic pattern)
- Compare P2C LB vs round-robin: P95/P99 latency, error rate
- Grafana dashboard showing real-time metrics
- Architecture diagram in README
- One-command deploy: `kubectl apply -f k8s/`

## Tech Stack Summary

| Layer | Technology |
|---|---|
| Load Balancer | Rust (P2C + ArcSwap + safety overrides) |
| API Services | Node.js + Fastify + TypeScript |
| ORM | Drizzle |
| Database | PostgreSQL 16 (logical replication) |
| CDC | Debezium (Kafka Connect) |
| Message Broker | Apache Kafka (KRaft mode) |
| Cache | Redis |
| Job Queue | BullMQ |
| Auth | Clerk |
| Container Orchestration | Kubernetes |
| Cloud | AWS EKS or GCP GKE (TBD) |
| Load Testing | autocannon |
| Monitoring | Grafana + Prometheus |
| CI/CD | GitHub Actions |

## Existing Work That Can Be Reused Directly

- CDC docker-compose.yml, connector config, init.sql, postgresql.conf
- Rust router-core crate (router.rs, scoreboard.rs, types.rs, lib.rs) — as-is, no ML
- Scalable Backend's DDD structure, BullMQ setup, rate limiter, error handler, security headers
- Drizzle schema + migration setup

## What Needs To Be Built Fresh

- Event/venue/seat schema (Drizzle models)
- Booking flow (reserve seat → hold → payment → confirm)
- Payment simulation service
- Kafka producer/consumer integration in the backend
- Rust reverse proxy wrapping router-core
- Kubernetes manifests
- CI/CD pipeline
- Load test scripts
- Grafana dashboards
