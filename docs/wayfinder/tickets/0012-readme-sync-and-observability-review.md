# 0012 — root README sync + observability code review

## Context

Two threads from tonight's overnight session, recorded together since both closed
out around the same time:

1. `README.md` (repo root) was stale — written before Phase 3 (k8s), Phase 4 (load
   testing), and the JWT auth migration (ADR 0002) landed. It also never had an
   architecture diagram, despite idea.md listing that as a success criterion.
2. Tonight's new observability instrumentation (ADR 0003, commit `3f24e19`) hadn't
   been adversarially reviewed yet — it was written and smoke-tested, not audited.

## Resolution

**README sync** — dispatched to `opencode run --model opencode/nemotron-3.5-lightning-free
--auto` (deepseek-v4-flash-free was silently removed from OpenCode's free catalog
tonight — `opencode models` no longer lists it at all, confirmed via `opencode models
--verbose`; switched to this model for small dispatches for the rest of the session).
Content-wise it did the job correctly: fixed the stale Phase 3/4 status, fixed the
`k8s/`/`docs/adr/` "empty" claim, fixed the `POST /bookings/reserve` curl example to
use the JWT flow instead of a body `userId` (invalid since ADR 0002), added a short
Observability section. **But it also broke two things structurally**: the ASCII
architecture diagram it generated was genuinely garbled (misaligned boxes, a stray
"round-robin" label that directly contradicts the P2C-only messaging this whole repo
is built around), and it left a malformed code fence around the seed-data commands
(closed a fence early, then left several `curl`/`docker exec` commands sitting outside
any fence with a dangling unmatched closing fence after them). Both fixed directly
by hand afterward — rewrote the diagram in the simpler single-column top-to-bottom
style `k8s/README.md`'s (already-verified-legible) diagram uses instead of attempting
a multi-branch box layout, and re-merged the split code block. Verified fence balance
afterward (`grep -n '^```' README.md` — 4 matched pairs).

**Lesson for tonight's remaining dispatches** (recorded in map.md's Notes): this
small free-tier model produces accurate *content* reliably but is not trustworthy for
*structural* correctness (ASCII art alignment, markdown fence balance) without a
manual quality-control read afterward — don't skip that read just because the model's
own final summary claims success.

**Observability code review** — dispatched to a Sonnet subagent scoped to exactly the
6 files changed in commit `3f24e19` (not a full-repo audit), pointed at ADR 0003 for
context instead of re-explaining it. Findings:

1. **[Real bug, fixed]** `http_requests_in_flight` could leak upward: Fastify's
   `onResponse` hook only fires on `reply.raw`'s `finish`/`error` events
   (`fastify/lib/reply.js`'s `setupResponseListeners`, confirmed by reading the
   installed package source directly, not just trusting the finding) — a client
   that aborts mid-request before either fires means `onResponse` never runs, so the
   gauge's decrement never happens. Fixed in `backend/src/index.ts` +
   `backend/src/shared/metrics/registry.ts`: added a `request.raw.once("close", ...)`
   fallback guarded by a per-request `inFlightAccountedFor` flag so the decrement
   happens exactly once regardless of which path fires first — mirrors lb-proxy's
   `TrackedBody` exactly-once-release pattern (`lb-proxy/src/proxy.rs`), which was
   already explicitly tested for this same class of bug on the Rust side.
2. **[Real gap, fixed]** `kafka_producer_connected` only updated from the explicit
   `connectProducer`/`disconnectProducer` call sites, so an unexpected mid-session
   drop (broker restart, network blip) would leave it falsely reporting `1` forever.
   Fixed `backend/src/infrastructure/kafka/producer.ts` to drive both the `connected`
   flag and the gauge from kafkajs's own `producer.events.CONNECT`/`DISCONNECT`
   events instead — mirrors `cdc-consumer.ts`'s existing pattern (producer has no
   `CRASH` event to also listen to, unlike the consumer).
3. **[Real gap, fixed]** `/metrics` and `/health` sat behind the same global
   Redis-backed rate limiter as business routes. Not urgent at current scrape
   cadence/limits, but during an actual Redis outage this would 500 both ops
   endpoints via an unbounded `redisConnection.incr()` throw *before* `/health`'s
   own carefully-bounded (2s race, clean 503) Redis check ever got to run —
   defeating the point of that existing handling. Fixed with a small exemption set
   in `backend/src/shared/middleware/rateLimiter.ts`.
4. Cardinality, lb-proxy panic paths, dead code — all checked, all clean, no changes
   needed.

Full backend suite re-run after all three fixes: 64/64 passing, `npm run build`
clean. `cargo build`/`cargo test` not needed — nothing in `lb-proxy/` changed in this
ticket's fixes.
