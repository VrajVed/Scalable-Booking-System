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

## Not yet specified

- Whether `README.md`'s (repo-root) top-level Status section still
  accurately reflects Phase 3 being done — not charted as a ticket yet
  because it's copy, not a bug, and lower priority than functional gaps.
- `npm run lint` is broken (no eslint config anywhere in the repo) — minor,
  not yet worth a ticket on its own; might fold into whichever ticket next
  touches backend tooling.
- compose's `connect-init` wait loop has no timeout/max-attempts (benign
  today, masked by compose's own `depends_on: condition: service_healthy`)
  — noted, not yet worth a ticket.

## Out of scope

- Wiring the shelved ML/TCN layer into the LB routing path — hard
  constraint, CLAUDE.md.
- Phase 4 (autocannon load testing, P2C vs round-robin numbers) — a
  separate, larger effort or explicitly deferred; not a bug-fix, out of
  scope for this map. If load-test work starts, it gets its own map.
- Pushing to the GitHub remote / resolving the unpushed `ab47712` commit —
  a repo-history decision for the human, not a code-fix ticket.
