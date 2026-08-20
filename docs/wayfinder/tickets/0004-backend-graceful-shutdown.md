# Ticket 0004: backend has no SIGTERM handling

Status: **closed**. Type: `wayfinder:task` (AFK). Resolved by opencode
deepseek-v4-flash-free --variant max, 2026-08-20 (killed once by an
infra hiccup mid-task, real work survived on disk, continuation finished
it — twice: once by direct inspection fixing 3 test-file bugs, once by a
further dispatch fixing the one genuine implementation bug that remained).

## Resolution

`backend/src/shutdown.ts` implements `gracefulShutdown()` +
`registerShutdownHandlers()`: fixed drain order (http-server → kafka-producer
→ kafka-cdc-consumer → hold-expiry-worker → postgres-pool), bounded 25s
budget under k8s's 30s grace period, double-signal escalation to exit(1),
per-step error isolation. Wired into `index.ts`.

Found and fixed a real, non-obvious production bug during verification:
Node's `http.Server.close()` calls `closeIdleConnections()` exactly
**once**, synchronously, at close-time — a request that's mid-flight at
that exact moment is skipped (unfinished response), and when it finishes
moments later its now-idle keep-alive socket is never reaped again. Any
real client (including k8s health probes) holding a keep-alive connection
during a SIGTERM could deadlock the drain until the 25s force-exit budget.
Root-caused by reading Node v24's `_http_server.js` source directly and
reproducing the exact socket behavior with an isolated probe. Fixed with a
per-server `request`/`finish` event reaper (attached at bootstrap, before
`listen()`, so it never misses an already-in-flight request) that calls
`closeIdleConnections()` the moment each drained response actually
finishes — event-driven, no polling.

Also found and fixed 3 test-file bugs unrelated to the implementation (a
`noopDeps()` helper defaulting `closeServer` to a silent no-op unless
explicitly overridden, missed in 3 test cases) and one log-text mismatch —
these were caught and fixed directly by inspection when the first
continuation attempt revealed test failures that traced back to test setup,
not the (already-correct) implementation.

Live-verified on the kind cluster: rebuilt + reloaded the backend image,
hammered ~872k requests through the real P2C load balancer during a full
3-pod rolling restart — 0 failures, 0 dropped connections, 0 unexpected
pod restarts, and terminating-pod logs confirm the drain sequence now
actually completes (`closed http-server` no longer hangs).

Full suite: 55/55 passing (was 44 at session start; +11 across tickets
0001, 0003, 0004 combined), ~3.7s (was ~75s before this fix, due to the
hang). `npm run build` clean throughout.

Full report: [context/0004-backend-shutdown-report.md](../context/0004-backend-shutdown-report.md).

## Question

`backend/src/index.ts` has no `SIGTERM`/`SIGINT` handler. When k8s kills a
pod (rolling update, scale-down, node drain) it sends SIGTERM, and with no
handler the process dies immediately mid-request, mid-DB-transaction, or
mid-Kafka-publish, instead of draining cleanly. lb-proxy already got this
exact fix in the prior audit pass (`hyper_util::GracefulShutdown`, 25s
drain budget under k8s's 30s default `terminationGracePeriodSeconds`) —
mirror that shape here for the backend's own lifecycle.

Resolve:
- Add a SIGTERM/SIGINT handler in `index.ts` that: stops accepting new
  connections (Fastify has a `close()` that drains in-flight requests),
  closes the Kafka producer/consumer connections cleanly
  (`disconnectProducer()`/CDC consumer disconnect — both already exist as
  exports from a prior audit pass, check `producer.ts` and
  `cdc-consumer.ts`), and closes the DB pool (`closeDb()` already exists in
  `db.ts`).
- Bound the drain with a timeout so a stuck connection can't block shutdown
  forever, matching lb-proxy's 25s-under-30s-grace-period reasoning.
- If ticket 0001 (hold-expiry / BullMQ worker) lands first, this needs to
  also shut that worker down cleanly — check whether that ticket already
  covered it before duplicating.
- Test: a process-level test (or as close as `tsx --test` allows) proving
  in-flight work isn't dropped on SIGTERM, following the same "prove it
  actually blocks, don't just trust that it looks right" standard the
  lb-proxy graceful-shutdown test used (temporarily break the fix, watch
  the test correctly fail, then restore it — that was the actual technique
  used there, worth repeating).
- Live verification: `kubectl rollout restart statefulset/booking-backend`
  while a slow-ish request is in flight (or simulate), confirm no dropped
  connections/500s during the rollout, zero unexpected restarts.
