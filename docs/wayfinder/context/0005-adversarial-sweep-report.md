TICKET 0005 — SECOND ADVERSARIAL SWEEP
=====================================
Repo: /home/vraj/Programming/flashseat
Date: 2026-08-20
Status: complete — 4 areas investigated; small fixes applied; bigger findings
written up for the map (including one genuine live bug in the hold-expiry
feature, left untouched per concurrency rules).

Standing rules honored: no git commands run; router-core/ untouched;
backend/src/modules/booking/ and backend/src/index.ts read-only (a
concurrent agent owns the hold-expiry feature there); live kind cluster
(kind-booking-system) only read via kubectl get/describe/dry-run=client and
inbound curl (no delete/restart/apply/exec).


AREA 1 — THREE-WAY SCHEMA CHECK
--------------------------------
What was checked:
  - backend/drizzle.config.ts:4-10 — migrations output path is
    ./src/infrastructure/database/migrations, schema dir is
    ./src/infrastructure/database/schema, dialect postgresql.
  - All four Drizzle schema files: venues.ts, events.ts, seats.ts, bookings.ts
    (via schema/index.ts).
  - infra/postgres/init.sql (the schema the live Postgres actually has).
  - Any Drizzle-generated migration files under backend/.

Findings:
  1. Schema TS <-> init.sql: IN SYNC, column-for-column and
     constraint-for-constraint:
       - venues  (venues.ts:4-8    vs init.sql:7-12)
       - events  (events.ts:4-15   vs init.sql:14-21; status CHECK enum
         matches scheduled/cancelled/completed)
       - seats   (seats.ts:7-24    vs init.sql:23-33; status CHECK enum,
         version NOT NULL DEFAULT 0, UNIQUE(event_id,section,row_label,
         seat_number) both sides)
       - bookings (bookings.ts:4-16 vs init.sql:35-43; status enum incl.
         'expired', nullable hold_expires_at, created_at/updated_at)
       - The non-table DDL in init.sql (REPLICA IDENTITY FULL line 45,
         indexes lines 47-48) has no Drizzle equivalent — expected, those
         are runtime/CDC concerns, not table definitions.
     Conclusion: no drift between the schema the TypeScript layer declares
     and the schema init.sql creates.

  2. GENERATED MIGRATIONS: DO NOT EXIST. The configured output directory
     backend/src/infrastructure/database/migrations/ is absent entirely
     (glob + ls confirmed: only db.ts and schema/ under
     src/infrastructure/database/). Nothing has ever run `npm run
     db:generate`.
     Consequence (a future-conflict finding, REPORTED not fixed): the first
     `npm run db:generate` will emit a full CREATE TABLE baseline with zero
     prior snapshots, and `npm run db:migrate` against a live init.sql-created
     database will fail with "relation already exists" on every table. The
     schema-authority story is unresolved: init.sql is what compose/k8s
     actually apply, but package.json advertises db:generate/db:migrate
     (backend/package.json:12-13) with no path that reconciles the two.
     Fixing this is a design decision (either commit a baseline migration and
     make init.sql the empty/bootstrap path, or drop migrations in favor of
     init.sql and stop advertising db:migrate), not a one-liner — left as a
     fresh ticket for the map.

Fixed: nothing in area 1 (no bug to fix in-repo; running db:generate would
write files, so it was not executed).


AREA 2 — INFRA/ SHELL SCRIPTS (ADVERSARIAL)
-------------------------------------------
What was checked:
  - infra/connector/register-connector.sh (the only shell script under
    infra/ — glob of infra/** confirmed; docker-compose.yml, .env/.env.example,
    postgres/init.sql, postgres/postgresql.conf, connector/postgres-connector.json
    also read for context).

Findings:
  1. register-connector.sh: CLEAN on the audited axis.
       - set -eu present (line 4). No `-o pipefail` — not applicable: the
         script is /bin/sh and contains no pipelines at all.
       - Every variable is quoted: "${CONNECT_URL}" (lines 8,9,16), "${status}"
         (20,26), -w '%{http_code}' (15). No unescaped substitution exists —
         the payload is a static file, `-d @/connector/postgres-connector.json`
         (18), so there is nothing to escape.
       - Correct HTTP code handling: 201/409 accepted (20-24), anything else
         fails loudly (26-28). /tmp paths are per-container, no collision.
       - Minor robustness note (REPORTED): the wait loop (9-11) has no timeout
         or max-attempts — if Connect's REST API never comes up, the container
         spins forever. In compose this is masked by `depends_on:
         condition: service_healthy` (docker-compose.yml:89-91); in k8s the Job
         has activeDeadlineSeconds: 600 (20-kafka-connect.yaml:168). The
         compose path would hang forever, but only in a scenario compose's
         depends_on already fails on. Not worth a fix; documented here.
  2. Credential-hardcoding divergence (REPORTED, same bug class the k8s audit
     fixed): infra/connector/postgres-connector.json:7-8 hardcodes
     database.user/database.password = booking_system/booking_system, and the
     infra script posts it verbatim. The k8s path was fixed tonight
     (20-kafka-connect.yaml:13-85 — placeholder template __DB_USER__/
     __DB_PASSWORD__/__DB_NAME__ + sed substitution with & and @ escaping,
     sourced from the postgres-credentials Secret). The compose path was NOT
     given the same fix: a user who sets POSTGRES_PASSWORD in infra/.env
     (the whole point of .env templating, docker-compose.yml:7-9) gets a
     connector registered with stale creds and CDC silently goes dead. This is
     exactly the "silently drift the moment the Secret's password changed"
     failure the k8s fix's comment describes (20-kafka-connect.yaml:43-45).
     Not fixed blind: templating requires choosing an injection mechanism
     (sed/envsubst in the script, or env-var templating) and diverges from the
     README's "same files" claim — a fresh-ticket candidate.
  3. Side-check: compose's kafka-connect healthcheck uses curl
     (docker-compose.yml:81) — verified fine live (container is "Up (healthy)"
     in the running compose stack).

Fixed: nothing in area 2.


AREA 3 — K8S/README.MD COLD-START CHECK
---------------------------------------
What was checked: read k8s/README.md top-to-bottom against every manifest in
k8s/ (00-postgres, 10-kafka, 20-kafka-connect, 30-redis, 40-backend,
50-lb-proxy, 60-ingress, kind-config), the two Dockerfiles, lb-proxy source
(health/proxy), and the live kind cluster (kubectl get/describe + inbound
curl only).

Verified correct as written:
  - Build steps: backend/Dockerfile and lb-proxy/Dockerfile exist;
    lb-proxy/Dockerfile's repo-root context requirement (lines 3-10 of the
    Dockerfile) matches README line 54; lb-proxy/Cargo.lock exists so the
    COPY in the Dockerfile (line 16) won't fail; router-core path dep
    confirmed in lb-proxy/Cargo.toml:9.
  - kind-config.yaml:80/443 host mappings (kind-config.yaml:18-23) — cluster
    up and reachable via Host: booking.local (verified live below).
  - Ingress controller install/wait, metrics-server patch — resource names
    match live cluster (ingress-nginx running).
  - kubectl rollout status statefulset/booking-backend, job/connect-init wait,
    deploy/kafka-connect, svc/lb-proxy port-forward target — all names match
    the manifests (40-backend.yaml:34, 20-kafka-connect.yaml:165/90,
    50-lb-proxy.yaml:82).
  - Smoke-test SQL matches the controller contract: POST /bookings/reserve
    accepts {"seatId":1,"userId":"u1"} (booking.routes.ts:5, booking.controller.ts:5-8).
  - Backend /health shape {"status":"ok",...,"cdcConsumer":...} matches
    src/index.ts:34-38 (but see finding 1 — you can't reach it via lb-proxy).
  - HPA in manifests: maxReplicas capped at 3 (40-backend.yaml:171), confirmed
    live (kubectl get hpa: MAXPODS 3).

Findings (all stale/inaccurate README content; FIXED — doc accuracy, small
and unambiguous):
  1. "Both return the backend's /health" (README lines 101-105) is WRONG.
     lb-proxy intercepts GET /health locally and never proxies it upstream
     (lb-proxy/src/proxy.rs:362-366; health_response at 460-502). Live
     verification via the README's own curl command:
       curl -H "Host: booking.local" http://127.0.0.1/health
     returned {"backends":[{"id":0,"in_flight":0,"five_xx_in_window":0,...},
     ...],"requests_total":2,"status":"ok","timestamp_ms":...} — the proxy's
     diagnostics, not the backend body. README updated with the real shape and
     a note on reaching the backend's own /health directly.
  2. `kubectl apply -f k8s/` always errors: k8s/kind-config.yaml is a kind
     cluster config (kind.x-k8s.io/v1alpha4), not a k8s manifest. Verified
     with --dry-run=client against the live cluster: after applying every real
     resource it prints
       error: resource mapping not found for name: "" ... from "k8s/kind-config.yaml":
       no matches for kind "Cluster" in version "kind.x-k8s.io/v1alpha4"
     A first-time reader hits a scary error that the README never mentions.
     Everything else applies fine (dry-run showed all 18 real resources). Fixed
     by documenting the harmless error in the Deploy section.
  3. "same script/JSON as infra/connector/" (old line 79) and "connector
     config ... verbatim" (old lines 145-146) are stale since tonight's audit:
     the k8s Job runs a ConfigMap copy of the script with credential
     substitution and sed escaping, NOT the static infra/connector files
     (20-kafka-connect.yaml:13-85). Updated both passages.
  4. The "If the HPA scales the backend past 3 replicas..." limitation note
     (old lines 131-136) is moot — tonight's audit capped maxReplicas at 3
     (40-backend.yaml:161-181) exactly matching the fixed BACKEND_POOL, so the
     HPA can never scale past the pool. Reworded to describe the actual
     invariant (cap exists precisely to match the static pool; dynamic
     discovery is the out-of-scope extension path).
  5. Notes block also still claimed "The Debezium connector JSON hardcodes
     booking_system credentials" for k8s — corrected to describe the Secret-
     sourced substitution on the k8s path, with the hardcoded JSON relegated
     to the docker-compose path.

Reported, not fixed (not README):
  - Area-1 finding (no migrations) and Area-2 finding (compose connector cred
    hardcoding) also affect the README's claims indirectly; README corrected.

No design decisions were made blind; the four README edits are factual
corrections verified against manifests and a live cluster.


AREA 4 — TEST-QUALITY AUDIT OF BACKEND/TEST/
--------------------------------------------
What was checked: every file under backend/test/ (env.test.ts,
errorHandler.test.ts, rateLimiter.test.ts, reserve-seat.usecase.test.ts,
booking.controller.test.ts, cdc-consumer.test.ts, debezium-mapper.test.ts,
helpers/db.ts, helpers/print-kafka-brokers.ts), plus the relevant src
implementations to judge what each test really proves.

Baseline status: with infra up (docker compose ps all healthy), the suite was
hanging: `npm test` produced no output and did not complete within 300s;
booking.controller.test.ts alone was cancelled after ~150s with "Promise
resolution is still pending but the event loop has already resolved".

Findings:

  A. TEST-SUITE HANG (FIXED — root cause found and resolved):
     The new hold-expiry feature made the booking tests import a module
     (src/infrastructure/queue/hold-expiry.queue.ts) that imports
     src/config/redis.ts, whose module top-level `new Redis(...)` client
     (src/config/redis.ts:4-7) connects immediately and is never closed by
     the booking test files. The BullMQ Queue singleton
     (hold-expiry.queue.ts:15) adds its own connection. Teardown in
     booking.controller.test.ts:25-30 and reserve-seat.usecase.test.ts:25-32
     closed producer + DB pool only — leaving an open TCP socket (verified by
     probe: process.getActiveResourcesInfo() showed a leftover TCPSocketWrap
     after full teardown), so tsx --test never exited and node eventually
     cancelled the file.
     FIXED in both booking test files' after() hooks: quit redisConnection and
     close the hold-expiry queue, mirroring the pattern rateLimiter/cdc tests
     already use. Full suite now: 45 tests, 44 pass, 1 todo, 0 fail, clean
     exit in ~1s.

  B. GENUINE LIVE BUG FOUND BY THIS AUDIT (REPORTED, NOT FIXED — concurrent
     agent's hold-expiry feature, active files):
     hold-expiry.queue.ts:31 uses jobId `hold-expiry:${bookingId}`. BullMQ
     rejects ':' in custom job IDs ("Custom Id cannot contain :",
     bullmq job.js:912 validateOptions). Verified live: every reserve logs
     `[booking] failed to schedule hold-expiry job after commit` with that
     error (surfaced during the controller/usecase test runs), so NO hold-
     expiry job is ever scheduled — the feature silently never expires holds.
     The usecase's swallow-try/catch (reserve-seat.usecase.ts:57-68) correctly
     prevents a 500, which is also why the test suite passed while the
     mechanism was dead. Fix is one line (jobId `hold-expiry-${bookingId}`),
     but it lives in the hold-expiry feature a concurrent agent is actively
     implementing — left as a hand-off finding, not edited.

  C. WEAK ASSERTIONS (all fixed in place — strengthening, never weakening):
     1. cdc-consumer.test.ts — four tests claimed "logs and drops" / "is a
        no-op" but only asserted doesNotReject (i.e., "didn't throw"), which
        would pass even if the handler invalidated a garbage cache key while
        "not throwing". Strengthened each with Redis sentinel assertions
        proving no cache key is touched:
          - malformed JSON (was :55, now seeds seats:availability:event:7)
          - ts_ms missing (was :58, sentinel on seats:availability:event:3,
            the only key the message's data could address)
          - DELETE with null before image (was :63)
          - null/undefined message value (was :68)
        All pass against the real handler.
     2. reserve-seat.usecase.test.ts — "kafka publish failure resilience"
        test asserted the post-commit DB outcome but never verified its
        PREMISE (that the publish was actually attempted AND actually failed);
        it would pass even if the publish call were deleted from reserveSeat.
        Strengthened with explicit premise checks: after disconnectProducer(),
        assert isProducerConnected() === false and assert.rejects() on the
        real publishBookingEvent against the disconnected producer. (First
        attempt used t.mock.method on the producer module — rejected by the
        frozen ESM namespace: "Cannot redefine property: publishBookingEvent";
        mock.module is unavailable on this Node 24.14 without flags, so the
        premise is proven by direct invocation instead.) Passes.
     3. booking.controller.test.ts — "silently strips unexpected extra
        fields" asserted only status 201; strengthened to also assert exactly
        one bookings row was actually created for the seat. Passes.
     4. No weak assertions found in env.test.ts, errorHandler.test.ts,
        rateLimiter.test.ts, debezium-mapper.test.ts — all check concrete
        values/types (deepEqual bodies, instanceof + statusCode/code,
        sentinel values, exact error classes, TTL numbers). The
        Redis-unreachable rateLimiter case is an explicit it.todo with a
        documented design-decision comment (rateLimiter.test.ts:82-117) —
        correct handling, not a weak test.
     Verification: all strengthened files pass; test files typecheck under
     the project's strict flags (tsc --noEmit with the same strict options);
     npm run build passes.

  D. Pre-existing tooling gap (REPORTED, not fixed): backend/package.json:15
     `npm run lint` (eslint .) fails immediately — there is NO eslint
     config anywhere in backend/ or the repo root ("ESLint couldn't find an
     eslint.config.(js|mjs|cjs) file"). Writing a config is a design choice;
     flagged for the map. Also `npm run build` (tsconfig include: src/**/*,
     tsconfig.json:23) does not typecheck test/ — the test files do pass a
     manual strict tsc, but the official command won't catch regressions.


FILES CHANGED IN THIS PASS (small, unambiguous fixes only)
----------------------------------------------------------
  1. backend/test/booking/booking.controller.test.ts — teardown closes
     redisConnection + hold-expiry queue; extra-fields test asserts a real
     booking row was created.
  2. backend/test/booking/reserve-seat.usecase.test.ts — same teardown fix;
     kafka-publish-failure test now verifies its premise
     (isProducerConnected false + publish rejects while disconnected).
  3. backend/test/kafka/cdc-consumer.test.ts — sentinel assertions proving
     the "drop/no-op" claims of four tests.
  4. k8s/README.md — corrected /health response claim (lb-proxy's own body),
     documented the harmless kind-config.yaml apply error, updated the
     connect-init/connector description to the templated ConfigMap reality,
     and rewrote the HPA/limitation and credentials notes to match the
     capped-at-3 manifests and Secret-sourced substitution.

LEFT FOR THE MAP (report-only findings)
---------------------------------------
  1. Hold-expiry feature is broken end-to-end: jobId ':' (hold-expiry.queue.ts:31)
     — one-line fix, but owned by the in-flight feature; needs a verification
     pass after the concurrent agent lands.
  2. No Drizzle migrations exist vs. advertised db:generate/db:migrate —
     first generate will conflict with live init.sql-created tables.
  3. compose connector path still hardcodes dev creds (infra/connector/
     postgres-connector.json:7-8) while k8s was fixed tonight — same drift
     class, design choice on injection mechanism.
  4. `npm run lint` broken (no eslint config).
  5. compose connect-init wait loop has no timeout (benign today).

Verified-by-evidence summary: schema in sync; infra scripts clean on the
audited axis; README now matches manifests + live behavior; test suite
hangs no more, is stronger, and passes 44/44 + 1 documented todo.
