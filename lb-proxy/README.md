# lb-proxy

Thin reverse proxy that wraps the vendored [`router-core`](../router-core) P2C
load balancer into an actual working proxy. It sits in front of N backend
instances and routes every request using router-core's Power-of-Two-Choices
algorithm with real-time health-signal safety overrides.

It has zero policy of its own — no auth, no rate limiting, no request
rewriting. Backends enforce that. The proxy only:

1. asks `router_core::Router` which backend to use,
2. forwards method / headers / body to that backend (streaming),
3. streams the response back to the caller,
4. records real health signals (latency, 5xx, in-flight) back into router-core's
   scoreboard + the shared health registry so the **next** routing decision
   reflects actual backend health.

The ML layer is intentionally absent — router-core ships without it and this
crate does not reintroduce it (see repo `CLAUDE.md`).

## Running

```bash
cd lb-proxy
BACKEND_POOL=http://localhost:3001,http://localhost:3002,http://localhost:3003 \
  cargo run
```

The proxy listens on port `8080` by default and exposes its own readiness probe:

```bash
curl http://localhost:8080/health
```

```json
{"status":"ok","timestamp_ms":1721,...}
```

## Environment variables

| Variable                 | Required | Default           | Description                                            |
| ------------------------ | -------- | ----------------- | ------------------------------------------------------ |
| `BACKEND_POOL`           | yes      | —                 | Comma-separated upstream URLs (e.g. the Node backend). |
| `LISTEN_ADDR`            | no       | `0.0.0.0:8080`    | Address/port for the proxy's HTTP listener.            |
| `LATENCY_SLO_MS`         | no       | `1000`            | Latency target used to derive the scoreboard risk signal from observed response-head latency. |
| `FIVE_XX_WINDOW_SECS`    | no       | `10`              | Sliding window over which 5xx responses are counted for the fast safety override and scoreboard error rate. |
| `MAX_5XX_COUNT`          | no       | `10`              | 5xx threshold in the window; above it the backend is penalized. |
| `MAX_IN_FLIGHT`          | no       | `500`             | In-flight request threshold; above it the backend is penalized. |
| `MAX_BACKLOG`            | no       | `100`             | Backlog threshold (kept flat at 0 here; a real TCP listener could feed it). |

A quick end-to-end smoke test against the Node backend (see repo README):

```bash
cd backend && npm install && npm run dev    # terminal 1
cd lb-proxy && BACKEND_POOL=http://localhost:3000 cargo run   # terminal 2
curl http://localhost:8080/health          # the proxy's own health (never forwarded)
curl -X POST http://localhost:8080/bookings/reserve \
  -H 'Content-Type: application/json' -d '{"seatId": 1, "userId": "u1"}'
  # ^ forwarded to the backend on :3000
```

## How routing works

Every request triggers:

1. **Snapshot fast signals** — the proxy reads each backend's current in-flight
   count and sliding-window 5xx count from its shared health registry.
2. **P2C decision** — `router.choose_server(&fast_signals)` returns the backend
   index; the cursor's fast-path penalties (backlog/5xx/in-flight overrides)
   are applied here.
3. **Forward & stream** — the request is proxied over a pooled HTTP/1.1 client.
4. **Feedback** — when the response completes, the proxy updates the backend's
   latency EMA and 5xx window, then pushes a `ServerPrediction`
   (`risk_mean` from latency vs SLO, `error_rate` from the 5xx window) into the
   scoreboard via `Scoreboard::update_scores`. router-core's smoothing, shift
   caps and health-memory invariants weight the pool toward healthy backends.

The in-flight count is deferred until the response body finishes streaming,
because the pooled backend connection is held for the whole stream.

## Tests

```bash
cd lb-proxy && cargo test
```

The integration tests spin up fake backends in-process, run the real proxy on
ephemeral ports, and hit it with a real HTTP/1.1 client:

- `distributes_across_healthy_backends` — equal-weight pool gets split traffic.
- `shifts_traffic_away_from_unhealthy_backend` — after a simulated 5xx storm,
  traffic flows almost entirely to the healthy backends.
- `forwards_method_headers_and_body` — method/path/query/headers/body round-trip.
- `proxies_its_own_health_endpoint` — `/health` never routes to a backend.

## Notes / known limitations

- The outbound client is HTTP/1.1 only (hyper-util legacy client, pooled).
- `backlog` is always reported as 0 (`max_backlog` is therefore inert) — the
  proxy holds connections in a pool rather than a listening socket.
- The 5xx/in-flight fast overrides react per-request (no lag). The scoreboard's
  `risk`/`error_rate` weights are reconciled on a slow loop every
  `HEALTH_POLL_MS` (default 500ms) — this mirrors router-core's original
  fast-loop/slow-loop split, just with observed health standing in for the
  shelved ML model.