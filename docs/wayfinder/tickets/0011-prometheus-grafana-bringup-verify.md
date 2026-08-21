# 0011 — Prometheus/Grafana compose bring-up, verify end-to-end

## Context

ADR 0003 (docs/adr/0003-observability-prometheus-grafana.md) added `prometheus` +
`grafana` services to `infra/docker-compose.yml` earlier tonight, but they'd never
actually been brought up — only the backend/lb-proxy `/metrics` endpoints themselves
were smoke-tested directly. Host RAM was tight at session start (~700Mi free, 5.7Gi
already swapped), so this needed to be done carefully, checking `free -h` before and
after rather than just firing `docker compose up -d` blind.

## Resolution

VERIFIED PASS.

- `free -h` before: 438Mi free / 6.2Gi available. `docker compose up -d prometheus
  grafana` (targeted, not a full `up -d` — didn't touch the already-running
  postgres/redis/kafka/kafka-connect). After both containers were up and had scraped
  once: 187Mi free / 6.0Gi available — a small, acceptable dip, nothing alarming.
- `lb-proxy` target was initially `down` (`connection refused`) — the smoke-test
  lb-proxy instance from earlier in the session was bound to `127.0.0.1:14000`
  (chosen because port 4000 was taken by an unrelated process), not the default
  `:8080` `prometheus.yml` expects. Restarted that same throwaway instance (not the
  real dev server — nothing user-facing) bound to `0.0.0.0:8080` instead. Confirmed
  port 8080 was actually free first (`ss -ltnp`) before doing so.
- After that: both Prometheus targets report `up` — `booking-backend` at
  `host.docker.internal:3000`, `lb-proxy` at `host.docker.internal:8080`. Confirmed
  `host.docker.internal:host-gateway` (the Linux-only `extra_hosts` mapping ADR 0003
  called out as needed) actually works in this environment.
- Grafana's datasource provisioning confirmed via its own API
  (`GET /api/datasources`): the `Prometheus` datasource auto-registered at
  `http://prometheus:9090`, `isDefault: true` — zero manual setup, as intended.
- End-to-end proof, not just "both processes are up": queried Prometheus directly
  (`up` metric) and got `1` for both jobs.

**Not done / left for later:** no Grafana dashboards (ADR 0003 already scoped this
out — better to build them once there's real traffic to shape panels around).
Grafana is on its default `admin`/`admin` credentials, consistent with this repo's
existing "committed plain secrets are fine for a local-dev demo" stance (see
`k8s/README.md`'s note on the Postgres Secret).
