# CLAUDE.md

Read `context.md` and `idea.md` first if you haven't — this file is
working-in-this-repo instructions, not project background.

## What's here right now

`idea.md` (the pitch + architecture), `context.md` (the full project context, what
exists, what needs building), this file, and the initial scaffold: `backend/` (Node +
Fastify + TypeScript), `infra/` (Docker Compose + Debezium connector + Postgres init),
`router-core/` (vendored Rust crate), `k8s/` and `docs/adr/` (empty, Phase 3+).

This project merges three existing repos into one unified system:
- CDC pipeline: ~/Programming/PracticePrograms/CDC_pipeline/
- Rust load balancer: ~/Programming/PersonalProjects/loadBalancingPredictive/
- Scalable backend: ~/Programming/Scalable-Backend-System/

## Commands

- Bring up infra: `cd infra && docker compose up -d` (Postgres + Kafka KRaft +
  Kafka Connect/Debezium + Redis; connector auto-registers via `connect-init`)
- Backend dev server: `cd backend && npm install && npm run dev` (tsx watch)
- Backend build/typecheck: `cd backend && npm run build`
- Drizzle migrations: `cd backend && npm run db:generate` / `npm run db:migrate`
- Rust LB: not yet wired into a runnable proxy — `router-core/` is a library crate only
  (`cd router-core && cargo test`). The reverse-proxy binary is Phase 2.
- k8s / load tests: not built yet (Phase 3/4)

## Architecture Decisions

### Load Balancer — P2C only, no ML
The Rust router-core uses Power of Two Choices with real-time health signal overrides
(backlog, 5xx, in-flight). The ML layer (TCN model, MC Dropout) is SHELVED. Do not
wire ML inference into the routing path. The model was trained on synthetic M/M-1
queuing data (AUROC 0.999) but that doesn't prove real-world generalization. P2C +
safety overrides stand on their own as a legitimate intelligent load balancer.

### Backend — Node.js + Fastify + TypeScript
Node was chosen over Bun for its longer production track record (Bun is younger,
written in Zig — fine for a portfolio piece but Node's Node API compat is more
battle-tested). Keep the rest of the Scalable-Backend-System stack: DDD + Hexagonal
vertical slices, Drizzle ORM, BullMQ for background jobs, Clerk for auth, Redis for
cache + rate limiting. Dev loop runs on `tsx --watch` instead of `bun --watch`.

### CDC — Postgres WAL → Debezium → Kafka
Reuse the CDC pipeline's docker-compose, connector config, and init.sql directly.
The pattern: database write → WAL → Debezium → Kafka topic → consumer → Redis cache
invalidation. Zero polling. This is the real production CDC pattern.

### Message Broker — Apache Kafka (KRaft mode)
No Zookeeper. Kafka in KRaft mode (already configured in the CDC pipeline's
docker-compose). Topics: booking.events, payment.events, cdc.public.seats, etc.

### Deployment — Kubernetes
Target: kind or minikube for local dev, AWS EKS or GCP GKE for production demo.
Manifests in k8s/ directory. HPA for booking service pods. Ingress via nginx.

## Conventions

- TypeScript strict mode, ESM modules, .js extensions on relative imports (NodeNext)
- DDD vertical slices: domain/ application/ infrastructure/ interface/ per module
- Every infrastructure decision gets an ADR in docs/adr/
- Rust code in router-core/ stays as a library crate — no business logic in it
- Docker Compose for infra, Dockerfiles for app services
- One command to bring up dev: `docker compose up -d` + `npm run dev`

## Working with subagents

For token-heavy but well-scoped work (broad codebase search, multi-file research,
running a review pass), dispatch a Sonnet 5 medium-effort subagent instead of doing
it inline — it's more token-efficient than burning the main context on raw search
output. For a task with a specific evaluative angle (e.g. reviewing the Rust safety
invariants, auditing Kafka consumer error handling, checking k8s manifests against
the hard constraints above), spin up a subagent scoped to that specific reviewer role
rather than a generic one — a narrow brief produces a sharper review than a general
"look this over."

## Hard constraints — do not violate

- **Do not wire ML inference into the load balancer routing path.** P2C + safety
  overrides only. The ML layer is shelved until validated on real telemetry data.
- **Do not use polling for cache invalidation.** The whole point of the CDC pipeline
  is zero-polling event-driven cache sync. If you add a setInterval to refresh cache,
  you've broken the architecture.
- **Do not skip the Rust load balancer and use a standard nginx round-robin.** The
  P2C + safety override LB is the differentiator. Nginx can be the ingress, but the
  Rust LB sits between ingress and backend pods.
- **Do not fabricate load test results.** Run autocannon for real. Record actual
  numbers. If P2C doesn't beat round-robin in a scenario, report that honestly.

## When something breaks

- Check docker-compose logs for infra issues: `docker compose logs -f`
- Check Kafka connector status: `curl http://localhost:8083/connectors`
- Check Rust LB health endpoint (when it exists)
- Check BullMQ queues via Bull Board at `/admin/queues`
