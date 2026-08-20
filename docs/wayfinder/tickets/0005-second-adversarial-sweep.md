# Ticket 0005: second adversarial sweep on areas not yet targeted

Status: **closed**. Type: `wayfinder:research` (AFK). Resolved by opencode
deepseek-v4-flash-free --variant max, 2026-08-20.

## Resolution

Four areas investigated. Fixed in place (small, unambiguous): a test-suite
hang (booking test files leaked open Redis/BullMQ connections — added
teardown), four weak "logs and drops" assertions in `cdc-consumer.test.ts`
strengthened with real sentinel checks, one weak assertion in
`reserve-seat.usecase.test.ts` strengthened to verify its own premise, one
weak assertion in `booking.controller.test.ts` strengthened to check a row
was actually created, and `k8s/README.md` corrected on 4 points of drift
(the `/health` response shape claim, the harmless `kind-config.yaml` apply
error, the connector-config description, the HPA/limitation note).

Genuine bug caught mid-flight in the concurrently-running hold-expiry work
(ticket 0001): BullMQ rejects `:` in custom job IDs, so
`hold-expiry.queue.ts`'s `hold-expiry:${bookingId}` jobId meant no expiry
job was ever actually scheduled — reported, not touched (file ownership),
handed to ticket 0001's completion pass.

Bigger findings graduated into fresh tickets (0006, 0007) rather than fixed
blind — see map. Full report:
[context/0005-adversarial-sweep-report.md](../context/0005-adversarial-sweep-report.md).

## Question

Four audit passes ran on 2026-08-19 (k8s/Dockerfiles, backend, lb-proxy/
router-core, infra-consistency). Several areas were never specifically
targeted by any of them. Investigate and report — fix only if the bug found
is small and unambiguous; otherwise write it up as a fresh ticket for the
map rather than fixing blind:

- **Three-way schema check**: the prior backend audit compared Drizzle
  schema TS files against `infra/postgres/init.sql` only. Compare both of
  those against any actual Drizzle-generated migration files under
  `backend/` (check `drizzle.config.ts` for the migrations output path) —
  a drift between the migrations Drizzle would generate and the
  hand-written `init.sql` that k8s/compose actually apply could mean a
  future `npm run db:generate` produces a migration that conflicts with
  what's already live.
- **`infra/` shell scripts**: `infra/connector/register-connector.sh` and
  any other scripts under `infra/` — read them adversarially for the same
  class of bug the k8s audit found in the analogous k8s Job (unescaped
  substitution, unquoted variables that break on special characters,
  missing `set -euo pipefail` equivalents).
- **`k8s/README.md` cold-start check**: actually follow it top-to-bottom
  as written (fresh `kind delete cluster` if you need a truly clean slate,
  otherwise reason carefully about what a first-time reader would hit) —
  does it produce a working cluster with no undocumented manual steps or
  stale instructions left over from before this audit's k8s fixes?
- **Test-quality audit of `backend/test/`**: read every test file for
  weak assertions — a test that runs code but doesn't actually assert
  the behavior it claims to (e.g. asserting a call resolved without
  checking what it resolved *to*, or catching an error and asserting only
  that "something was thrown" without checking it's the right error).
  This is explicitly the class of bug the project's standing testing
  philosophy cares about most — a passing test suite that isn't actually
  proving anything.

Report all findings even where nothing was found — a section confirming
"checked X, no drift/weakness found" is exactly as valuable as a bug
report, so the map doesn't get re-audited pointlessly.
