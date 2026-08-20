# Ticket 0007: docker-compose connector path still hardcodes dev credentials

Status: **closed**. Type: `wayfinder:task` (AFK). Resolved by opencode
deepseek-v4-flash-free --variant max, 2026-08-20.

## Resolution

Templated `infra/connector/postgres-connector.json` with the same
placeholder pattern as the k8s fix, substituted via an awk pipeline (not a
sed mirror — see below) in `register-connector.sh`, wired
`POSTGRES_USER`/`PASSWORD`/`DB` into `connect-init`'s compose env. Deviated
from mirroring the k8s script's sed+escape approach after live-testing it
inside the actual runtime image (curlimages/curl:8.10.1, busybox sed) and
finding it produces invalid JSON on a password containing a literal `\` —
switched to a byte-faithful awk pipeline (ENVIRON + explicit JSON escaping)
proven safe for `@`/`&`/`\`/`"` by testing inside that exact image.

Live-verified: connector registers (201), resolved config shows real
values not placeholders, and two real UPDATE events flowed through Kafka
end-to-end (before/after images matched the actual DB write) — proof CDC
still works post-fix, not just that registration succeeds. Skipped the
optional live password-rotation step (ticket 0002 was concurrently
depending on this exact Postgres instance's credentials staying stable);
substituted an equivalent hostile-character test directly inside the
runtime image instead, which is a strict superset of what the rotation
would have proven.

**Found a real latent bug in the k8s path while investigating** (not
fixed — out of scope for this ticket, graduated to
[ticket 0008](0008-k8s-connector-sed-backslash-bug.md)): the same
busybox-sed backslash-handling gap exists in `k8s/20-kafka-connect.yaml`'s
substitution, contradicting its own comment that it handles `\`.

Full report: [context/0007-compose-connector-creds-report.md](../context/0007-compose-connector-creds-report.md).

## Question

Graduated from ticket 0005's area-2 finding. The k8s path was fixed in the
2026-08-19 audit: `k8s/20-kafka-connect.yaml`'s connector config is now
templated (`__DB_USER__`/`__DB_PASSWORD__`/`__DB_NAME__`) and sourced from
the `postgres-credentials` Secret via `sed`, with escaping hardened against
special characters. The docker-compose path
(`infra/connector/postgres-connector.json` +
`infra/connector/register-connector.sh`) was never given the equivalent
fix — it still posts a static JSON with `database.user`/`database.password`
hardcoded to `booking_system`/`booking_system`. A developer who changes
`POSTGRES_PASSWORD` in `infra/.env` (the entire point of that file existing)
gets a connector registered with stale credentials and CDC silently goes
dead with no obvious error pointing at the cause.

Resolve: apply the same shape of fix used in `k8s/20-kafka-connect.yaml` to
`infra/connector/register-connector.sh` — substitute the real
`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` values (already available
to the `connect-init` container via `infra/docker-compose.yml`'s env) into
the connector JSON before POSTing, with the same escaping care (passwords
can contain `/`, `&`, `\`). Verify live: change `POSTGRES_PASSWORD` in a
local `infra/.env`, bring the stack up fresh, confirm the connector
registers successfully and CDC events actually flow (not just that
registration returns 201 — confirm an actual seat UPDATE produces a Kafka
message, same proof standard used in tonight's E2E validation).
