CONFIG DRIFT AUDIT — flashseat (infra/manifests only)
=====================================================
Audited: infra/, backend/.env.example, k8s/, live kind cluster (read-only checks),
backend/src/config/env.ts + cdc-consumer.ts (read as consumers of the config values, not edited).
No files were modified. No git commands were run.

VERDICT: ZERO genuine drift found. Every "must agree" field agrees across all sources
of truth, including live verification against the running kind cluster.

CHECKED, FIELD BY FIELD
-----------------------

1. Postgres credentials (booking_system / booking_system / booking_system)
   - infra/.env.example: POSTGRES_USER/PASSWORD/DB = booking_system      OK
   - backend/.env.example: DATABASE_URL embeds booking_system:booking_system@localhost:5434/booking_system  OK
   - k8s/00-postgres.yaml Secret postgres-credentials: all three = booking_system  OK
   - k8s/00-postgres.yaml readiness/liveness probes hardcode booking_system/booking_system  OK
   - infra/connector/postgres-connector.json: database.user/.password/.dbname = booking_system  OK
   - k8s/20-kafka-connect.yaml ConfigMap copy: identical  OK
   - k8s/40-backend.yaml DATABASE_URL = postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@postgres:5432/$(POSTGRES_DB),
     pulling the three values from the Secret via secretKeyRef (defined earlier in the same env block,
     so $(VAR) expansion is valid).  OK
   - Live cluster: connector reports database.user/password/dbname = booking_system.  OK

2. Kafka topic prefix / topic naming
   - topic.prefix="booking-system" + table.include.list="public.seats" in both connector copies
     => topic "booking-system.public.seats"  OK
   - backend/src/config/env.ts default KAFKA_CDC_TOPIC="booking-system.public.seats"  OK
   - backend/.env.example KAFKA_CDC_TOPIC=booking-system.public.seats  OK
   - k8s/40-backend.yaml KAFKA_CDC_TOPIC="booking-system.public.seats"  OK
   - Live cluster: connector registered with topic.prefix=booking-system.  OK

3. Ports — internal vs host-remapped
   - Postgres: compose maps "${POSTGRES_PORT}:5432" (host 5434 -> container 5432); k8s 00-postgres.yaml
     containerPort 5432, Service port 5432; connector database.port=5432; k8s backend + init container
     use postgres:5432. NO host port leaks into any in-cluster/internal reference.  OK
   - Redis: compose "${REDIS_PORT}:6379" (6381->6379); k8s containerPort/Service 6379; backend REDIS_URL
     redis://redis:6379. No leak.  OK
   - Kafka: compose "${KAFKA_PORT}:29092" (29093->29092) for the PLAINTEXT_HOST listener only;
     k8s has NO host listener (no host access in kind) and only 9092/9093. No leak.  OK
   - Kafka Connect: compose "${KAFKA_CONNECT_PORT}:8083" (8084->8083); k8s containerPort/Service 8083;
     register scripts talk to kafka-connect:8083 in both paths. No leak.  OK
   - Confirmed via `docker compose config` (resolved) and grep of k8s/ (host ports 5434/6381/29093/8084
     appear NOWHERE in k8s/).  OK

4. Kafka bootstrap / advertised listeners
   - compose: KAFKA_LISTENERS PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093,PLAINTEXT_HOST://0.0.0.0:29092;
     ADVERTISED PLAINTEXT://kafka:9092,PLAINTEXT_HOST://localhost:29093 (host clients via remap).
     In-compose clients (Connect) use kafka:9092; host backend (npm run dev) uses localhost:29093
     (backend/.env.example KAFKA_BROKERS=localhost:29093 — matches the advertised PLAINTEXT_HOST. OK)
   - k8s: LISTENERS PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093; ADVERTISED PLAINTEXT://kafka:9092;
     in-cluster clients (Connect, backend, init container) all use kafka:9092. Intentional omission of the
     host listener — no host access in kind. Operaationally equivalent for their respective topologies.  OK
   - KAFKA_CONTROLLER_QUORUM_VOTERS "1@kafka:9093" identical in both.  OK
   - CLUSTER_ID MkU3OEVBNTcwNTJENDM2Qk identical in infra/.env.example and k8s/10-kafka.yaml (and in
     resolved compose output).  OK
   - Connect env (BOOTSTRAP_SERVERS kafka:9092, GROUP_ID booking-system-connect, storage topics
     connect-configs/-offsets/-status, RF=1) identical between compose and k8s/20-kafka-connect.yaml.  OK

5. Redis
   - compose redis:7-alpine, internal 6379, no auth; k8s/30-redis.yaml redis:7-alpine, containerPort/Service
     6379, no auth.  OK
   - backend/.env.example REDIS_URL=redis://localhost:6381 (host remap for dev, matches REDIS_PORT=6381);
     k8s/40-backend.yaml REDIS_URL=redis://redis:6379 (in-cluster).  OK
   - No requirepass anywhere; URL has no password in either path (consistent).  OK

6. CDC consumer group IDs (per-pod in k8s, intentional)
   - k8s/40-backend.yaml: POD_NAME via fieldRef metadata.name, defined BEFORE KAFKA_CDC_GROUP_ID in the env
     list, and KAFKA_CDC_GROUP_ID = "booking-system-cdc-consumer-$(POD_NAME)". Expansion is valid k8s
     (referenced var defined earlier in same env block).  OK
   - LIVE-VERIFIED: booking-backend-0/1/2 each run with group
     booking-system-cdc-consumer-booking-backend-{0,1,2} — three distinct groups, so each replica consumes
     the full CDC stream independently (not partitioned to one pod).  CONFIRMED NOT A BUG.
   - Base name "booking-system-cdc-consumer" matches env.ts default + .env.example.  OK
   - Backend subscribes to env.KAFKA_CDC_TOPIC (cdc-consumer.ts:74) = booking-system.public.seats everywhere. OK

7. Connector copies / init scripts (byte-for-byte diffs)
   - infra/connector/postgres-connector.json vs k8s/20-kafka-connect.yaml ConfigMap data: IDENTICAL
   - infra/connector/register-connector.sh vs ConfigMap copy: IDENTICAL
   - infra/postgres/init.sql  vs k8s/00-postgres.yaml ConfigMap init.sql:  IDENTICAL
   - infra/postgres/postgresql.conf vs k8s/00-postgres.yaml ConfigMap postgresql.conf: IDENTICAL
   - infra/.env        == infra/.env.example      (diff clean)
   - backend/.env      == backend/.env.example    (diff clean)

8. Cross-links not in the explicit list, checked anyway
   - k8s/60-ingress.yaml: booking.local -> Service lb-proxy:8080; matches 50-lb-proxy.yaml Service
     (port 8080 -> targetPort http=8080) and LISTEN_ADDR 0.0.0.0:8080.  OK
   - k8s/50-lb-proxy.yaml env matches lb-proxy/README.md env contract (BACKEND_POOL, LISTEN_ADDR,
     LATENCY_SLO_MS=1000, FIVE_XX_WINDOW_SECS=10, MAX_BACKLOG=100, MAX_5XX_COUNT=10, MAX_IN_FLIGHT=500,
     HEALTH_POLL_MS=500). BACKEND_POOL targets the 3 StatefulSet pod DNS names from 40-backend.yaml
     (`booking-backend-{0,1,2}.booking-backend-headless.default.svc.cluster.local:3000`) on port 3000,
     matching the backend containerPort.  OK
   - kafka StatefulSet has enableServiceLinks:false due to KAFKA_PORT env-var collision comment (10-kafka.yaml)
     — comment is accurate; would be a real runtime issue if re-enabled; noted only.  OK
   - k8s/11 backend init container waits for ["kafka",9092] and ["postgres",5432] — internal ports, correct. OK

NOT A BUG (checked, no change needed)
-------------------------------------
- The two-listener split in compose (PLAINTEXT for in-compose + PLAINTEXT_HOST for the host dev backend)
  vs single listener in k8s: intentional and correct for each topology, not drift.
- compose kafka healthcheck uses kafka:9092 (compose service DNS name); POSTGRES healthcheck uses
  ${POSTGRES_USER}/${POSTGRES_DB} — resolves to booking_system. OK.
- k8s/40-backend.yaml also passes POSTGRES_USER/PASSWORD/DB into the backend container even though
  env.ts only reads DATABASE_URL — they exist solely for the $(VAR) substitution into DATABASE_URL;
  harmless, not drift.
- HPA (min 3 / max 6, CPU 60%) fine as configured; no config coupling issues.
- backend Dockerfile EXPOSE 3000 matches PORT=3000 everywhere. OK.

OUT-OF-SCOPE OBSERVATIONS (app-level, NOT audited/fixed per task scope)
-----------------------------------------------------------------------
- None found that qualify as bugs. The only notables observed were documentation-adjacent:
  - k8s/README.md and docs/adr/0001 reference the per-pod group scheme — consistent with manifests.
  - No polling anywhere: CDC cache invalidation is event-driven (handleCdcMessage DELs the
    seats:availability key) — no setInterval refresh found; architecture constraint intact.

CHANGES MADE: NONE.