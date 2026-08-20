# Ticket 0008: k8s connector credential substitution mishandles a literal backslash

Status: **closed**. Type: `wayfinder:task` (AFK). Resolved by opencode
deepseek-v4-flash-free --variant max, 2026-08-20.

## Resolution

Ported ticket 0007's byte-faithful awk pipeline from
`infra/connector/register-connector.sh` into `k8s/20-kafka-connect.yaml`'s
`register-connector.sh` ConfigMap entry (adapted to this Job's
DB_USER/DB_PASSWORD/DB_NAME Secret env names). Image-level test inside the
actual `curlimages/curl:8.10.1` image with hostile values (`@ & \ "` all at
once): JSON parses and round-trips byte-for-byte — while the removed sed
path, re-run in the same image, reproduces the reported `Invalid \escape`
failure. Live kind cluster verified end-to-end: connect-init Job recreated
(only that Job touched), connector registered with resolved (placeholder-free)
values, and a real seats UPDATE flowed as a Kafka change event with correct
before/after. Full report:
[context/0008-k8s-connector-sed-report.md](../context/0008-k8s-connector-sed-report.md)

## Question

Graduated from ticket 0007. `k8s/20-kafka-connect.yaml`'s `register-connector.sh`
substitutes real Postgres credentials into the connector JSON via a sed
pipeline with an `escape_for_sed` helper (`s/[\&@]/\\&/g`), with a comment
claiming it's hardened against `/`, `&`, and `\` in passwords. Ticket 0007
(fixing the equivalent docker-compose path) empirically tested this exact
sed pattern inside the actual runtime image used by both paths
(`curlimages/curl:8.10.1`, busybox `sed`) and found it does NOT correctly
escape a literal backslash — a password containing `\` produces invalid
JSON (confirmed via `python3 json.load` raising `Invalid \escape`), which
would make the k8s `connect-init` Job POST a broken payload (a loud 400,
not silent drift, but still a real bug contradicting the comment's claim).

Ticket 0007 fixed the equivalent bug in the compose path by replacing the
sed approach with a byte-faithful awk pipeline (`ENVIRON` + explicit JSON
string escaping via `index()`/`substr()`, no metacharacter interpretation
at any layer) — verified safe for `@`, `&`, `\`, and `"` by testing inside
the same busybox image. Port that same awk pipeline (or an equally-proven
alternative) into `k8s/20-kafka-connect.yaml`'s `register-connector.sh`
ConfigMap entry.

Resolve: read `infra/connector/register-connector.sh`'s now-fixed awk
substitution block (ticket 0007's change) and `k8s/20-kafka-connect.yaml`'s
current sed block side by side, port the awk approach into the k8s
manifest's script, and verify inside the actual `curlimages/curl:8.10.1`
image (not just "looks right") with a hostile test password containing
`@`, `&`, `\`, and `"` all at once, same proof standard ticket 0007 used.
If a live kind cluster is up, verify end-to-end: the connector registers
with resolved (not placeholder) values and CDC events still flow. This
ticket only touches `k8s/20-kafka-connect.yaml` — do not touch `infra/`
(already fixed by ticket 0007) or anything else.
