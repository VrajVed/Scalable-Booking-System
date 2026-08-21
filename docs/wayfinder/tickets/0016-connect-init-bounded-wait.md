# 0016 — connect-init's wait loop is now bounded, not infinite

## Context

Flagged in `docs/wayfinder/map.md`'s "Not yet specified" for a while as low-priority
("benign today, masked by compose's own `depends_on: condition: service_healthy`").
Revisited during a quiet standby tick tonight since nothing higher-value was queued
and this was already fully scoped from an earlier pass (deliberately not dispatched —
it touches two files, `infra/connector/register-connector.sh` and the embedded copy
in `k8s/20-kafka-connect.yaml`, that this repo has a documented history of drifting
apart — tickets 0007/0008 — so doing it directly, carefully, beat risking a
small-model dispatch getting only one of the two in sync).

## Resolution

Both scripts' `until curl -sf ... ; do sleep 2; done` loop now bails out after 150
attempts (5 minutes) with a loud, diagnosable failure instead of waiting silently
forever with a single "Waiting for Kafka Connect..." log line as the only signal.

- **Compose path**: genuinely just a safety net — `depends_on: condition:
  service_healthy` already means `kafka-connect` passed its own healthcheck before
  this container starts, so the loop rarely runs more than once or twice in
  practice. On timeout it now exits 1 loudly (no compose-level retry configured on
  this one-shot container, matching its existing behavior on any other failure).
- **k8s path**: the Job already has an outer `activeDeadlineSeconds: 600` and
  `backoffLimit: 30` (each retry a fresh pod), so this doesn't change the real
  worst-case ceiling — it just makes a stuck Kafka Connect fail loudly at 5 minutes
  per attempt instead of the Job's own 600s deadline being the only thing that ever
  notices.

Verified both scripts pass `sh -n` syntax checking, and diffed them against each
other (ignoring the pre-existing, intentional differences — different env var names
per each path's own credential source, one log-message wording difference) to
confirm the new bounded-wait logic is byte-identical between the two, not just
similar.

**Live-verified on the compose path**: `docker compose up -d --force-recreate
connect-init` — real container, real run, not simulated. Registered the loop, hit
the already-healthy `kafka-connect`, got `HTTP 409` (connector already existed from
earlier tonight, handled as success by the script's existing logic), exit code 0.

**Not verified**: the k8s copy — bringing up a kind cluster is explicitly out of
scope tonight (RAM). Syntax-checked and diff-confirmed identical logic to the
live-verified compose path, but not run against a real Job. Worth a real live check
next time a cluster is up for an unrelated reason.
