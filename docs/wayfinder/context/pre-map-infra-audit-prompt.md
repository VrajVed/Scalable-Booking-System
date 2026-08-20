You are auditing the repo at /home/vraj/Programming/flashseat ("AI-Powered Scalable Booking System", a portfolio project). Your ONLY job is a cross-file infra consistency audit — find drift between config files that must agree, and fix any genuine mismatches you find directly in the files.

Compare these sources of truth against each other, field by field:
1. infra/docker-compose.yml (local dev stack: Postgres, Kafka KRaft, Kafka Connect/Debezium, Redis)
2. infra/.env.example
3. backend/.env.example
4. infra/connector/postgres-connector.json (Debezium connector config used by BOTH docker-compose's connect-init container AND k8s/20-kafka-connect.yaml's ConfigMap — check both copies match)
5. k8s/00-postgres.yaml, k8s/10-kafka.yaml, k8s/20-kafka-connect.yaml, k8s/30-redis.yaml, k8s/40-backend.yaml, k8s/50-lb-proxy.yaml (the k8s manifests — a parallel deployment path to docker-compose, meant to be operationally equivalent)

Specifically check for drift in:
- Postgres user/password/db name (booking_system / booking_system / booking_system) — must be identical across infra/.env.example, backend/.env.example, k8s/00-postgres.yaml's Secret, and infra/connector/postgres-connector.json's database.user/database.password/database.dbname
- Kafka topic prefix ("booking-system") and topic naming — must match between the Debezium connector config, backend's KAFKA_CDC_GROUP_ID / topic subscription code (backend/src/infrastructure/kafka/cdc-consumer.ts and backend/src/config/env.ts), and k8s/20-kafka-connect.yaml
- Ports: Postgres 5432 (in-cluster/in-compose) vs the host-remapped ports in infra/.env.example (POSTGRES_PORT=5434 etc.) — confirm the *internal* container ports referenced in k8s manifests and docker-compose service definitions are NOT accidentally using the host-remapped port numbers (that would be a real bug — internal service-to-service traffic should never go through the host port remap, that remap only exists to avoid colliding with other projects on the developer's own machine)
- Kafka bootstrap/advertised listener addresses matching between docker-compose's kafka service and k8s/10-kafka.yaml
- Redis connection details (host, port, any auth) consistent between infra/.env.example, backend/.env.example, and k8s/30-redis.yaml + how backend/40-backend.yaml wires REDIS_URL
- Consumer group IDs: k8s/40-backend.yaml suffixes KAFKA_CDC_GROUP_ID per-pod via $(POD_NAME) so all 3 backend replicas each consume the full CDC stream independently (this is intentional — confirm it's actually wired this way and not accidentally left as a single shared group ID, which would make only one replica ever receive CDC events)

Do NOT touch application source code logic, Rust code, or test files — this task is scoped strictly to config/manifest consistency. If you find something that looks like an application bug outside this scope, report it in your final summary but do not fix it.

Fix genuine drift you find by editing the file(s) that are wrong (pick the version that matches everywhere else, or if truly ambiguous, prefer whatever the code that reads the value actually expects — grep for the actual usage). Do not invent a "fix" for something that isn't actually inconsistent just to have something to report.

Hard rules, non-negotiable:
- Do NOT run any git commands (no git add, commit, push, checkout, etc.) — not even "just to check status". A previous automated dispatch on this exact project ignored this instruction and committed changes on its own as the user (commit ab47712, still sitting in history because of it) — do not repeat that. Leave all git operations to the human.
- Do NOT touch k8s/kind-config.yaml, docs/, README.md, CLAUDE.md, or anything under router-core/.
- Do NOT run `kubectl delete` or `docker compose down` — there is a live kind cluster running right now that a human just finished validating end-to-end; do not disturb it. You may run read-only `kubectl get`/`describe` or `docker compose config` commands to verify actual resolved values if useful, but nothing destructive.

When done, write a plain-text summary to /tmp/claude-1000/-home-vraj-Programming-flashseat/f8cdc317-7e94-444a-9cbb-34a14da52b93/scratchpad/opencode-infra-audit-report.txt listing: every place you checked, every genuine drift found (with file:field), whether you fixed it, and anything you looked at but concluded was NOT a bug (so the human doesn't have to re-check it).
