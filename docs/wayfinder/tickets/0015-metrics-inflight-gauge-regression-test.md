# 0015 — regression test for the in-flight-gauge leak (ticket 0012's finding #1)

## Context

Ticket 0012 fixed a real bug (a Sonnet review finding, verified by reading Fastify's
own source): `http_requests_in_flight` could leak upward forever if a client aborted
a request before Fastify's `onResponse` hook ever fired (it only fires on
`reply.raw`'s `finish`/`error` events, not on the underlying connection closing
early). The fix was applied and the full suite stayed green, but — unlike every
other real bug found this session (ticket 0001's jobId bug, ticket 0009's timing
side-channel, ticket 0014's hold-expiry retry gap) — no dedicated regression test was
added at the time. `backend/test/` had zero test files for the metrics module at all.
Ticket 0012's own Sonnet review had explicitly flagged this as worth doing ("a
Node-side equivalent test... would have real value").

## Resolution

Two changes:

1. **Refactor, not just a test addition**: extracted the `onRequest`/`onResponse`
   hook pair from inline closures in `index.ts` into an exported
   `registerHttpMetricsHooks(app)` in `backend/src/shared/metrics/registry.ts`.
   Without this, a test would have had to re-implement the same hook logic to
   exercise it, risking silent drift between what's tested and what production
   actually runs (the exact failure mode a regression test exists to prevent).
   `index.ts` now just calls the same function.
2. **New test file `backend/test/shared/metrics.test.ts`**: spins up a throwaway
   Fastify instance with the real `registerHttpMetricsHooks`, a route that never
   resolves (simulating a slow in-flight request), makes a real HTTP request via
   `node:http`, destroys the client socket mid-request, and asserts
   `httpRequestsInFlight` returns to its starting value via `prom-client`'s own
   `.get()` API (async in this installed version, v15 — not the sync API older
   versions have).

**Verified this is a real regression test, not just a green checkmark**: temporarily
neutered the `request.raw.once("close", ...)` fallback (commented out its body),
re-ran the test, watched it fail exactly as expected (`1 !== 0`, "the in-flight gauge
must be released once the client aborts, even though the response never completed"),
then restored the real fix and confirmed it passes again. This mirrors ticket 0009's
own verification discipline for its timing-side-channel test.

Full suite (dev server stopped for the run): 66/66 passing (was 64; +2 for the two
new `it()` blocks in this file). `npm run build`/`npm run lint` both clean.
