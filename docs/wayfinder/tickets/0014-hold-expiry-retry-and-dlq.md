# 0014 — hold-expiry jobs had no retry, deleted themselves on failure

## Context

Third adversarial sweep of the night, dispatched to a Sonnet subagent scoped to two
areas no prior sweep (0005, 0009, 0012) had covered: `debezium-mapper.ts`/
`cdc-consumer.ts`, and the hold-expiry queue/worker/usecase chain.

## Resolution

**CDC mapper: clean.** All four Debezium op types (c/r/u/d) handled correctly, every
null-before/after case per op already covered by `test/kafka/debezium-mapper.test.ts`,
`handleCdcMessage`'s generic try/catch already catches more than just the
`SyntaxError` its own comment mentions (a `TypeError` from a non-object payload is
caught too). No changes needed.

**Real bug found and fixed:** `hold-expiry.queue.ts`'s `scheduleHoldExpiry` enqueued
every job with no `attempts`/`backoff` (BullMQ default: 1 attempt, no retry) and
`removeOnFail: true`. Since this queue is the *only* mechanism that ever reverts an
abandoned hold — the whole architecture is zero-polling, nothing else sweeps the
`bookings` table — a single transient failure in `expireHold` (DB pool exhaustion, a
brief connection blip) permanently stranded that seat as `held` forever, with the job
deleted outright so there wasn't even a record it happened. Fixed:
- `attempts: 3`, `backoff: { type: "exponential", delay: 5000 }` — retries a real
  transient error instead of giving up after one attempt.
- `removeOnFail: { count: 200 }` instead of `true` — a job that exhausts all retries
  now stays around (bounded, not unbounded growth) as a lightweight DLQ instead of
  vanishing.
- `hold-expiry.worker.ts`'s `failed` handler: BullMQ fires this event on *every*
  failed attempt, not just the final one — with retries added, a single transient
  failure now fires it up to 3 times. Split into `console.warn` for a retryable
  attempt vs `console.error` + the `holdExpiryJobsTotal{outcome="failed"}` metric only
  once retries are actually exhausted (`job.attemptsMade >= job.opts.attempts`), so
  the metric means what it says instead of over-counting.
- Added a regression test (`test/booking/hold-expiry.test.ts`) asserting the real
  enqueued job's own `opts` directly — not just the source config — so a future
  change can't silently drop this without failing a test.

**Also confirmed clean during the same review** (not bugs, but worth recording since
they were genuinely checked, not assumed): the confirm-vs-expire race is correctly
arbitrated by the `UPDATE ... WHERE status = 'pending'` in `expire-hold.usecase.ts`
(proven by an existing test, not just trusted from a comment); `expire-hold` never
publishes to Kafka directly (only `reserve-seat.usecase.ts` does), so
`shutdown.ts`'s producer-before-worker teardown order can't strand an in-flight
publish; `scheduleHoldExpiry`'s own `.add()` failure path (a *different* failure mode
— the job never gets enqueued in the first place) was already correctly guarded with
a try/catch in `reserve-seat.usecase.ts`, an intentional, already-reasoned-about
tradeoff, not an oversight.

**Also caught, unrelated to this ticket's actual fix:** running the new/existing
hold-expiry tests with the backend dev server left running (from ticket 0011's
bring-up) reproduced the exact same shared-BullMQ-worker contention pattern
documented earlier tonight — the dev server's own worker steals jobs from the test
suite's worker on the same queue+Redis, so the "race against a concurrent confirm"
test failed with "job never fired" until the dev server was stopped for the run.
Confirms (again) that's an environment issue, not a code bug — not re-documenting the
root cause in full here, see the earlier finding this session.

Full suite re-run with the dev server stopped: 64/64 passing, `npm run build` clean.
