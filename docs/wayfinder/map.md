# Map: harden the booking system to zero known bugs

Local-markdown tracker. Status: `open`. Label: `wayfinder:map`.

## Destination

Every piece of the AI-Powered Scalable Booking System (backend, lb-proxy,
router-core, k8s manifests, infra) has been adversarially re-checked at least
once, every genuine bug found is fixed and verified live against the kind
cluster (not just unit-tested in isolation), and every gap that's deliberately
left unfixed is documented with why. No new functionality beyond what's
already scoped in CLAUDE.md/context.md — this map closes gaps in what exists,
it doesn't grow the feature set except where a ticket explicitly says a
missing mechanism (e.g. hold-expiry) is the gap being closed.

## Notes

- **Execution override**: unlike a normal Wayfinder map, tickets here are
  fix-and-verify work, not open decisions — the destination is already
  specified from four completed audit passes (2026-08-19 night session).
  Resolving a ticket means: dispatch a subagent, get a real fix, verify it
  (tests + build + live cluster where applicable), record it.
- Standing project rules (from CLAUDE.md, non-negotiable for every ticket):
  no ML inference in the LB routing path, no polling for cache invalidation,
  no swapping the Rust LB for plain nginx round-robin, no fabricated load
  test numbers, no `Co-Authored-By: Claude` in any commit, no git commands
  run by any dispatched subagent (an opencode dispatch violated this once
  already — commit `ab47712` — never again).
- Standing testing philosophy: adversarial, evidence-based, source of truth
  is tests/build/live output — not code that merely looks right. Report
  "not a bug" as readily as "found a bug." Never weaken a test to pass it.
- Dispatch mix: Sonnet subagents for judgment-heavy tickets (design choices,
  multi-file wiring); opencode `deepseek-v4-flash-free --variant max`
  (managed directly via the `opencode` CLI, not the Agent tool) for
  mechanical, well-scoped, single-concern fixes.
- Live cluster `kind-booking-system` may still be running — reuse it for
  verification rather than tearing down/recreating unless something requires
  a clean slate.
- **Context management (2026-08-20)**: every subagent/opencode dispatch's
  full report is a persisted file under `docs/wayfinder/context/`, named
  `<ticket-number>-<short-name>-report.md`, linked from the ticket's
  Resolution section — never left only in `/tmp` (ephemeral, gone by
  morning) and never pasted in full onto the map or ticket body (keeps
  those skimmable). Prompts sent to opencode are persisted alongside as
  `<ticket-number>-<short-name>-prompt.md` for auditability.
- **AFK-only for the rest of this run (2026-08-20, ~4-5hr overnight
  window)**: no HITL tickets, no pausing to ask the user anything — make
  the reasonable call and record the reasoning in the ticket's resolution
  instead of blocking on it. No destructive operations anywhere (no
  `kubectl delete` on stateful resources, no cluster teardown, no
  `git reset`/force-push/`rm -rf`, no dropping the live Postgres data) —
  additive/rolling changes only. Bias dispatch toward opencode
  deepseek-v4-flash-free --variant max for test-writing and audit-type
  work specifically (per explicit user instruction); Sonnet for the
  judgment-heavy design tickets. Keep the loop moving — verify and record
  a resolution the moment a dispatch completes, then immediately claim and
  dispatch the next frontier ticket, don't idle.
- **Incident (2026-08-20, ~02:05)**: 2 concurrent opencode dispatches
  (0003, 0004) were killed mid-task (not completed, not crashed — the
  background bash processes were terminated) while 3 dispatches were
  running at once and swap was at ~81%. No OOM-killer evidence in dmesg,
  cause unconfirmed, but real work survived on disk both times (files
  written before the kill are intact) — a continuation dispatch with the
  partial context already established worked cleanly both times (mirrors
  what already worked for tickets 0001 and 0006, whose first attempts also
  got cut short, by an unrelated Anthropic session-limit that time). If
  this recurs, prefer 2 concurrent opencode dispatches over 3, and always
  check for partial work on disk before concluding a ticket needs a
  from-scratch retry.
- **Token/session conservation (2026-08-20, ~1am, user went to sleep)**:
  Sonnet subagents share the same Anthropic session-limit pool that already
  failed ticket 0001's first attempt once tonight — reserve Sonnet only for
  tickets that genuinely need Claude-specific judgment. Default the rest of
  tonight's dispatches to opencode: `opencode/deepseek-v4-flash-free
  --variant max` for mechanical/well-scoped work (unchanged), and
  `opencode-go/kimi-k2.6` or `opencode-go/glm-5.2` (paid, separate from the
  Anthropic pool) for judgment-heavier tickets that would otherwise go to
  Sonnet. Keep my own context lean: don't re-read full opencode reports
  into my context, skim+verify+link instead.
- **Session gap (2026-08-21, evening)**: a separate same-day session (not
  this map) did a full local-JWT-auth migration (Clerk → JWT, ADR 0002),
  seed data, load testing (autocannon, P2C vs round-robin — Phase 4, closes
  the "Out of scope" note below), a real 8-replica scaled-up k8s test, and
  got 47 uncommitted files from across multiple sessions into 5 commits.
  Tickets 0009 (post-JWT audit) and 0010 (kafka-connect exec→httpGet probe
  fix) were filed and resolved under *this* map's numbering during that
  session but hadn't been indexed here yet — backfilled below. Phase 4 load
  testing is therefore done, not deferred; leaving the original "Out of
  scope" bullet below as-written (historical record of that day's call) and
  noting the update here instead of editing it.
- **Overnight session (2026-08-21/22)**: user handed off "work on the next
  thing" + explicit RAM caution (~700Mi free / 5.7Gi swapped at start — see
  new incident precedent above from 2026-08-20 under similar pressure).
  Picked up observability (ADR 0003: prom-client on backend, hand-rolled
  Prometheus text on lb-proxy, compose-only) as the next concrete gap per
  CLAUDE.md's roadmap (needs real telemetry before the shelved ML question
  can be responsibly revisited), plus resolving test-suite flakiness caused
  by a leftover dev server sharing the same Redis/BullMQ instance as the
  test suite. No new kind cluster tonight — RAM. Continuing this map's
  dispatch-mix and AFK-only conventions from 2026-08-20 rather than
  reinventing them.
- **Dispatch-model update (2026-08-22, ~00:30)**: `opencode/deepseek-v4-flash-free`
  is gone from OpenCode's free catalog entirely (not a rename — `opencode models`
  doesn't list it, confirmed via `--verbose`). Switched small/mechanical dispatches
  to `opencode/nemotron-3.5-lightning-free` for the rest of this session (also
  `"variants": {}`, same no-reasoning-tier shape as the old default — omit
  `--variant` same as before). **Lesson from the first dispatch** (ticket 0012):
  this tier of free model gets *content* right reliably but is not trustworthy for
  *structural* correctness unsupervised — it produced an accurate README update but
  also a garbled ASCII diagram and a broken/split code fence, both silently, while
  its own final summary claimed full success. Always do a manual read-through after
  a small-model dispatch touching prose/formatting, not just a diff skim.

## Decisions so far

*(carried in from the pre-map audit session, 2026-08-19, for context — not
formal tickets, but the baseline this map builds on)*

- Kafka-publish-after-commit could 500 a durable reservation — wrapped in
  try/catch, DB commit is the source of truth (`reserve-seat.usecase.ts`)
- HPA could scale past lb-proxy's static 3-entry backend pool — capped
  `maxReplicas: 3`
- Kafka Connect connector config had hardcoded Postgres creds drifted from
  the Secret — templated + sourced from the same Secret
- No securityContext on backend/lb-proxy pods — added explicit non-root +
  capability-drop
- lb-proxy had zero SIGTERM handling — added graceful shutdown with a
  25s drain budget
- `requests_total` was dead code — wired into `/health`
- 2 clippy warnings — fixed, 0 warnings
- Infra consistency (compose vs k8s vs .env vs connector config) — audited
  field-by-field, zero drift found
- [Rate limiter trusts a spoofable client IP](tickets/0002-rate-limiter-trust-proxy.md) —
  fixed at the edge: lb-proxy now overwrites (not appends) X-Forwarded-For
  with the real TCP peer IP; backend trusts exactly that one hop via
  Fastify's `trustProxy`. Live-verified: a 105-request spoofed-header flood
  went from 105/105 unlimited to exactly 100-then-429
- [Implement seat hold-expiry](tickets/0001-hold-expiry-mechanism.md) —
  BullMQ delayed-job design was already solid; fixed a real jobId bug
  (`:` rejected by BullMQ, meant zero expiry jobs were ever scheduled),
  added 3 real tests (event-driven, not sleep-based), live-verified an
  actual expiry firing end-to-end on the kind cluster
- [Backend has no SIGTERM handling](tickets/0004-backend-graceful-shutdown.md) —
  built the drain sequence, then found a real production bug during
  verification: Node's `http.Server.close()` only reaps idle keep-alive
  sockets once, synchronously, at close-time — a request finishing just
  after that moment leaves its socket unreaped forever, deadlocking the
  drain. Fixed with an event-driven per-server reaper. Live-verified:
  ~872k requests through a real rolling restart, 0 failures, 0 restarts
- [/health doesn't check Redis](tickets/0003-health-endpoint-redis-check.md) —
  bounded-timeout Redis PING, 503 on failure, resolved the pre-existing
  rateLimiter `it.todo`. k8s readinessProbe needed no changes — plain
  httpGet already fails on non-2xx
- [k8s connector sed backslash bug](tickets/0008-k8s-connector-sed-backslash-bug.md) —
  ported ticket 0007's awk substitution into the k8s path; proved the sed
  approach it replaced really did fail on a literal backslash (reproduced
  the failure in the same removed code, for the record) and that the awk
  version round-trips it correctly. Live-verified on the kind cluster
  (recreated only the connect-init Job — no stateful workload touched)
- [Drizzle migrations vs init.sql](tickets/0006-drizzle-migrations-vs-init-sql.md) —
  found + fixed a real index-drift bug (2 indexes init.sql had that Drizzle
  didn't know about), reverse-engineered drizzle-kit's baseline-tracking
  format to mark the schema as already-applied on both live databases
  without touching data, built `npm run db:baseline` so future clones don't
  hit the same trap
- [Docker-compose connector credential drift](tickets/0007-compose-connector-credential-drift.md) —
  templated the connector JSON + wired real creds through an awk-based
  substitution (safer than a sed mirror — found the k8s sed approach
  breaks on a literal backslash, graduated to ticket 0008). Live-verified:
  registers correctly, real CDC events still flow post-fix
- [Second adversarial sweep](tickets/0005-second-adversarial-sweep.md) —
  fixed a test-suite hang (leaked Redis/BullMQ connections in booking
  tests), strengthened 6 weak test assertions, corrected 4 points of drift
  in `k8s/README.md`; caught the hold-expiry jobId bug (ticket 0001) and
  the migrations/connector-cred gaps (graduated to tickets 0006, 0007)
- [Post-JWT-migration audit](tickets/0009-post-jwt-migration-audit.md) —
  found + fixed a real HIGH-severity timing side-channel in
  `login.usecase.ts` (email enumeration via response latency), fixed a
  stale `k8s/README.md` smoke-test example; everything else checked out
  clean (JWT alg-confusion, userId-spoofing, register race, config drift)
- [kafka-connect exec→httpGet probe fix](tickets/0010-kafka-connect-probe-fix.md) —
  exec-probe subprocess-spawn overhead under CPU contention was causing
  restart-looping; switched to httpGet, live-verified 0 restarts over an
  8-minute window on a real kind cluster with the REST API responsive
  throughout and CDC registration intact
- [Observability: Prometheus + Grafana](../adr/0003-observability-prometheus-grafana.md) —
  prom-client `/metrics` on the backend (HTTP histogram, process metrics,
  CDC/Kafka connection gauges, booking-event + hold-expiry counters), a
  hand-rolled Prometheus-text `/metrics` on lb-proxy off the existing
  `ServerHealth` struct (per-backend request count doubles as the P2C
  selection count), both wired into compose. DB-level metrics explicitly
  deferred (postgres.js doesn't expose pool internals cleanly)
- [Prometheus/Grafana bring-up, verified](tickets/0011-prometheus-grafana-bringup-verify.md) —
  brought the two new compose services up for real (RAM checked before/after,
  small acceptable dip), both scrape targets confirmed `up`, Grafana's
  datasource auto-provisioning confirmed via its own API, `up{job=...}`
  queried directly through Prometheus as end-to-end proof
- [README sync + observability code review](tickets/0012-readme-sync-and-observability-review.md) —
  root README.md brought current (Phase 3/4 status, JWT curl example, new
  Architecture diagram, Observability section); a Sonnet review of commit
  `3f24e19` found + fixed 3 real gaps: an in-flight-gauge leak on client-aborted
  requests, a stale `kafka_producer_connected` gauge on unexpected disconnects,
  and `/metrics`+`/health` being blockable by the same Redis-backed rate limiter
  they're meant to help diagnose. 64/64 tests passing after fixes
- [eslint flat-config setup](tickets/0013-eslint-flat-config-setup.md) —
  `npm run lint` had been broken since ESLint v9 (no flat config anywhere);
  fixed with `typescript-eslint`'s `tseslint.config()` helper + an
  `argsIgnorePattern`/`varsIgnorePattern: "^_"` addition so the codebase's
  existing intentionally-unused-param convention isn't flagged as noise.
  4 real dead-code findings surfaced and fixed (unused imports/params in
  test files). 64/64 tests still passing after
- [hold-expiry retry + DLQ](tickets/0014-hold-expiry-retry-and-dlq.md) — third
  adversarial sweep (debezium-mapper.ts + hold-expiry chain, neither covered by
  0005/0009/0012). Mapper: clean. Real bug found: hold-expiry jobs had no retry
  (BullMQ default 1 attempt) and `removeOnFail: true` — since this queue is the
  *only* thing that ever reverts an abandoned hold (zero polling), a single
  transient DB error permanently stranded a `held` seat with zero trace. Fixed
  with `attempts: 3` + exponential backoff + a bounded `removeOnFail: {count:
  200}` DLQ, a corrected `failed`-event handler (was about to over-count the
  metric 3x per real failure since BullMQ fires it per attempt, not once), and
  a regression test asserting the real enqueued job's own opts. Confirm/expire
  race, producer-shutdown ordering, and the schedule-failure path all confirmed
  already-correct, not just assumed. 64/64 tests passing (dev-server-vs-test
  BullMQ contention reproduced again mid-verification, same root cause as
  earlier tonight — confirmed environment, not code, by rerunning isolated)
- [In-flight-gauge regression test](tickets/0015-metrics-inflight-gauge-regression-test.md) —
  ticket 0012's fix had no dedicated test (the one real gap in an otherwise
  test-everything session). Extracted the onRequest/onResponse pair from
  index.ts into an exported `registerHttpMetricsHooks()` so a test exercises
  the *real* hooks, not a re-implementation that could drift; new
  `test/shared/metrics.test.ts` proves a client-aborted request still
  releases the gauge. Verified the test actually catches the bug: temporarily
  neutered the fix, watched it fail (`1 !== 0`), restored it, watched it pass.
  66/66 tests passing
- **End-to-end real-traffic validation (2026-08-22, ~00:41)** — not a ticket,
  a sanity check on tonight's observability work: ran a small real (not
  fabricated) smoke test against the live backend using existing seed data —
  register, login, 5 real seat reservations, a deliberate 409 double-book, a
  401 no-auth attempt, a 404 — and confirmed `/metrics` showed the honest
  resulting status-code spread, `booking_events_published_total` incremented
  for real, and the backend log showed 5 fresh
  `[kafka] invalidated cache seats:availability:event:7` lines — the whole
  WAL→Debezium→Kafka→consumer→Redis path fired live, not just at boot.

**Status at this point (2026-08-22, ~00:45)**: 5 commits since the RAM caution
kicked off this session (observability, README+3-real-bugs, hold-expiry
retry/DLQ, in-flight regression test), all verified with real builds/tests/
live traffic, none pushed (per instruction). No further adversarial sweep
queued right now — 3 independent ones tonight (this map's own history plus
0012 and 0014) have covered auth, booking-flow, k8s/infra consistency, the
CDC mapper, and the hold-expiry chain; a 4th right now risks manufacturing
findings rather than finding real ones. Shifting to a lighter health-check
cadence rather than inventing more changes; will pick up real work again if
something concrete surfaces (a genuine gap, or user direction in the
morning) rather than padding this map for its own sake.

## Not yet specified

- compose's `connect-init` wait loop has no timeout/max-attempts (benign
  today, masked by compose's own `depends_on: condition: service_healthy`)
  — noted, not yet worth a ticket.
- Whether/how Prometheus+Grafana get wired into `k8s/` — deferred in ADR
  0003, RAM-gated tonight too.
- No Grafana dashboards yet (ADR 0003) — deliberately deferred until there's
  real traffic to shape panels around, not charted as a ticket.

## Out of scope

- Wiring the shelved ML/TCN layer into the LB routing path — hard
  constraint, CLAUDE.md.
- Phase 4 (autocannon load testing, P2C vs round-robin numbers) — a
  separate, larger effort or explicitly deferred; not a bug-fix, out of
  scope for this map. If load-test work starts, it gets its own map.
- Pushing to the GitHub remote / resolving the unpushed `ab47712` commit —
  a repo-history decision for the human, not a code-fix ticket.
- New kind clusters / k8s load tests tonight (2026-08-21/22) — RAM.
- Frontend work — idea.md non-goal (API-first, thin demo at most).
- Payment/notification services from idea.md's target architecture — in
  scope eventually, not started, not scoped for tonight.
