# Ticket 0001: implement seat hold-expiry

Status: **closed**. Type: `wayfinder:task` (AFK). Resolved by Sonnet
subagent, 2026-08-20.

## Resolution

Design (BullMQ delayed job scheduled at reservation time; optimistic-
concurrency expiry transaction mirroring `reserveSeat`'s shape; named
start/stop worker lifecycle for ticket 0004 to hook into) was already
solid from the first attempt. Finishing pass fixed the jobId bug ticket
0005's audit caught (`hold-expiry:${bookingId}` → `hold-expiry-${bookingId}`
— BullMQ rejects `:` in custom job IDs, so no expiry job was ever actually
scheduled before this fix), and added `backend/test/booking/hold-expiry.test.ts`:
a regression test proving jobs now actually enqueue, a fire-and-revert test
that waits on the worker's real `"completed"` event (not a sleep) before
asserting seat/booking state, and a race test proving a confirmed booking
beats a concurrently-firing expiry job.

Also added `HOLD_DURATION_MS` as an overridable env var (defaults to the
real 5-minute window; used to speed up live verification without editing
k8s manifests).

Live-verified on the kind cluster: temporarily set a 20s hold via
`kubectl set env`, reserved a real seat through lb-proxy, watched Postgres
flip the booking `pending`→`expired` and the seat `held`→`available` with
zero manual intervention, confirmed via pod logs
(`[hold-expiry] reverted abandoned hold`), then reverted the env override.

Tests: 45→50 (49 pass, 1 pre-existing todo), reproduced stable across 5
consecutive runs. `npm run build` clean throughout.

Full report captured in this file (no separate context/ doc needed — the
subagent's report was concise enough to fold in directly).

## Question

No mechanism exists anywhere in `backend/src` to flip a `held` seat back to
`available` (or a `pending` booking to `expired`) once its `holdExpiresAt`
passes. `bullmq` isn't even an installed dependency despite
`config/redis.ts` exporting an unused `bullMQConnection`, and CLAUDE.md
names BullMQ as the intended background-jobs mechanism for this stack.

Resolve by implementing it:
- Add `bullmq` as a real dependency.
- A delayed job scheduled at reservation time (`reserveSeat` in
  `reserve-seat.usecase.ts`) for `holdExpiresAt`, which — if the booking is
  still `pending` at run time — flips the seat back to `available` and the
  booking to `expired` in one transaction (mirror the existing optimistic
  concurrency pattern: only touch rows still in the expected state, so a
  user who confirms in the meantime wins the race cleanly).
- A worker process/entry point wired into the app's lifecycle (start on
  boot, shut down cleanly — note ticket 0004 also wants graceful shutdown
  in the backend, coordinate so this doesn't duplicate that work).
- Tests: a fast-forwarded/mocked-clock test proving an abandoned hold
  actually reverts, and a race test proving a booking confirmed just before
  expiry is NOT clobbered by the expiry job.
- Live verification once merged: reserve a seat with a short hold TTL
  (temporarily override via env if needed, then revert), watch it actually
  flip back to `available` in Postgres without any manual intervention.

Do not weaken this to a cron/polling loop — CLAUDE.md's zero-polling
constraint is about cache invalidation specifically (CDC-driven), but a
polling-based expiry sweep would be a real architectural regression for a
project whose whole pitch is event-driven design. A delayed BullMQ job (or
equivalent one-shot scheduled work) is the correct shape.
