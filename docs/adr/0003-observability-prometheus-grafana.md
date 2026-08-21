# ADR 0003 — Prometheus + Grafana for observability

- Status: accepted
- Date: 2026-08-21
- Deciders: Vraj

## Context

Before Phase 5 (frontend) and before responsibly revisiting the shelved predictive-LB
question, the system needed real telemetry — CLAUDE.md's ML hard constraint exists
specifically because the shelved model was only validated on synthetic queuing data,
and the only way to validate it (or decide it's not worth reviving) on real traffic is
to actually collect real traffic metrics first. Until this ADR, there was zero
observability tooling anywhere in the stack: no `prom-client` in the backend, no
metrics endpoint on `lb-proxy`, nothing scraping either.

## Decision

- **Backend** (`backend/src/shared/metrics/registry.ts`): `prom-client`, a `/metrics`
  route, default Node process metrics (CPU/memory/event-loop lag/GC), an HTTP request
  duration histogram + in-flight gauge (Fastify `onRequest`/`onResponse` hooks, labeled
  by route pattern — not raw URL — to keep cardinality bounded), and gauges/counters
  for the signals that were previously only point-in-time booleans on `/health`:
  CDC-consumer-connected, Kafka-producer-connected, booking-events-published (by
  type), hold-expiry-job outcomes.
- **lb-proxy** (`lb-proxy/src/proxy.rs`): a hand-rolled Prometheus text-exposition
  `/metrics` route (not a crate — every value already lives in the existing
  `ServerHealth` struct that feeds router-core's scoreboard, so a crate would only
  buy a text format producible in a dozen `format!` calls). Exposes per-backend
  request count (which doubles as the P2C/round-robin selection count — direct
  evidence of whether P2C is actually spreading load), in-flight, 5xx-in-window,
  error rate, and latency EMA — the exact inputs router-core's risk prediction is
  derived from, now externally observable.
- **Infra**: `prometheus` + `grafana` services added to `infra/docker-compose.yml`,
  scraping the backend and lb-proxy over `host.docker.internal` (both still run on
  the host via `npm run dev` / `cargo run`, not as compose services). Grafana
  auto-provisions the Prometheus datasource (`infra/grafana/provisioning/`) so
  `docker compose up -d` still requires zero manual setup, per this repo's existing
  "one command to bring up dev" convention.

## Consequences

- Positive: `POST /bookings/reserve` throughput, latency, and error rate — and
  whether P2C is really distributing load across backends — are now scrapeable
  instead of only inferable from ad-hoc load-test runs and manual `/health` polling.
- Positive: a real (not fabricated, per CLAUDE.md's load-testing constraint) telemetry
  substrate now exists for the eventual, still-not-started decision on the shelved
  ML layer.
- Negative / explicitly out of scope for this pass: no DB-level metrics (query
  duration, pool usage). `postgres.js`'s connection pool isn't introspectable through
  its public API, and wrapping every Drizzle call site to hand-time queries was judged
  too invasive for what this pass is trying to establish. Worth a dedicated follow-up
  if DB latency turns out to be the thing worth watching most closely (load testing
  earlier this project already found Postgres, not auth, is the real bottleneck).
- Negative: no Grafana dashboards provisioned yet, only the datasource. Building
  dashboards before there's real traffic to shape them around would mean guessing at
  panel layout — better to build them once there's a real workload to look at.
- Negative: k8s manifests (`k8s/`) don't yet run Prometheus/Grafana in-cluster — this
  ADR only covers the docker-compose dev path.

## Alternatives considered

- **OpenTelemetry + a managed backend (Grafana Cloud, Honeycomb, etc.)**: rejected for
  now — adds an external-service dependency and auth/API-key management for a
  portfolio project whose whole point on this axis is demonstrating the pipeline
  locally end-to-end. Revisit if this ever needs to run somewhere Prometheus/Grafana
  containers aren't practical.
- **`prometheus` Rust crate on lb-proxy instead of hand-rolled text output**: rejected
  — the crate's registry/collector abstractions would just be indirection around
  values `ServerHealth` already computes; hand-rolling keeps lb-proxy's stated "no
  business logic beyond the proxy itself" footprint honest and avoids a new dependency
  for ~50 lines of `format!`.
