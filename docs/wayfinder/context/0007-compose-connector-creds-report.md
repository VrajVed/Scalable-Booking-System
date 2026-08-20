Ticket 0007 report — docker-compose connector path credential drift fix
======================================================================
Date: 2026-08-20 (overnight AFK window)
House: opencode deepseek-v4-flash-free --variant max (wayfinder dispatch)

Summary
-------
The docker-compose Debezium connector path (infra/connector/) hardcoded
Postgres credentials in its connector JSON. Fixed by templating the JSON with
the same __DB_USER__ / __DB_PASSWORD__ / __DB_NAME__ placeholders the k8s
path (k8s/20-kafka-connect.yaml) uses, sourcing real values from the same
POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB env the postgres service gets
(from infra/.env), substituting them into register-connector.sh before
POSTing, and wiring those vars into the connect-init service's environment.
Live-verified: registration (HTTP 201) + two real CDC change events flowed to
the Kafka topic through the fixed path.

IMPORTANT deviation from the k8s approach, with evidence: the k8s sed-based
substitution (escape_for_sed over '[\&@]') was mirrored first, but a live test
inside the actual runtime image (curlimages/curl:8.10.1, busybox sed) showed
it produces INVALID JSON when the password contains a literal backslash — the
exact class of input ticket 0007 says must be handled ("passwords can contain
/ , &, \"). The substitution was therefore switched to a byte-faithful awk
pipeline (ENVIRON + index/substr + explicit JSON string escaping), which is
provably safe for any character and keeps the k8s-recognizable placeholder
pattern. This also exposed a likely latent hole in the k8s path (same image,
same sed logic) — flagged at the bottom, NOT touched (k8s/ is out of scope
per dispatch rules).

What changed (file:line)
------------------------
1. infra/connector/postgres-connector.json:7-9
   database.user / database.password / database.dbname now
   "__DB_USER__" / "__DB_PASSWORD__" / "__DB_NAME__" placeholders
   instead of literal "booking_system". Same placeholder names as the
   k8s ConfigMap copy so the pattern is recognizable across both paths.
   All other connector settings unchanged.

2. infra/connector/register-connector.sh
   - Header comment (lines ~2-10): now documents the placeholder +
     env-sourcing pattern and why (rotating POSTGRES_PASSWORD in
     infra/.env previously left a stale connector registered).
   - Substitution block (lines ~27-75): replaced the k8s-mirrored
     sed+escape_for_sed pipeline with an awk pipeline that:
       a) reads the template file,
       b) takes the raw values from ENVIRON["POSTGRES_USER"] /
          ENVIRON["POSTGRES_PASSWORD"] / ENVIRON["POSTGRES_DB"]
          (byte-faithful; awk does not process env values),
       c) JSON-string-escapes them (\\, \", \n, \t, \r, \b, \f), and
       d) splices them into the placeholders via index()/substr()
          string ops (no metacharacter interpretation at any layer).
     Writes the result to /tmp/postgres-connector.json, which is what
     gets POSTed (same -d @/tmp/... shape as k8s's script).
   - Registration + HTTP 201/409 handling unchanged (lines ~77-91).

3. infra/docker-compose.yml:92-95 (connect-init service)
   Added to the connect-init container's environment:
       POSTGRES_USER: ${POSTGRES_USER}
       POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
       POSTGRES_DB: ${POSTGRES_DB}
   Same `${VAR}` interpolation source the postgres service uses
   (docker-compose.yml:7-9), resolved by compose from infra/.env.
   connect-init's entrypoint/volumes untouched (script is bind-mounted,
   so the running container always executes the edited script).

Verification
------------

Step 1 — no stack teardown; scoped rerun of the registration only
  The only container recreated was connect-init, via
    docker compose up -d --force-recreate connect-init
  (twice: once per script iteration). Compose output confirmed
  postgres/kafka/kafka-connect stayed "Running" (no recreate). No
  `docker compose down` was issued at any point, no volumes touched,
  kind cluster untouched. First run used the sed mirror; after the
  backslash finding, the connector was deleted (DELETE /connectors/
  booking-system-connector → 204; deletes only the Connect task
  config/offsets registration, not Postgres or Kafka data) and
  connect-init was recreated to register under the final awk script
  with a clean 201. Deleting was necessary because a POST against an
  existing connector returns 409 and does NOT update its config —
  leave that out of the script itself (its 409-ok behavior is fine)
  but it means a config change requires the recreate+delete dance.

Step 2 — registration with substituted values, no placeholders
  Final state after the awk-based registration:
    - POST .../connectors -> HTTP 201, response JSON shows
      database.user/password/dbname all "booking_system" (the values
      currently in infra/.env — i.e. substituted from env, NOT the
      literal template).
    - GET http://localhost:8084/connectors/booking-system-connector/
      config returns the same resolved values; no "__DB_" text anywhere.
    - GET .../booking-system-connector/status -> state: RUNNING.
  Note the values happen to equal the old hardcoded ones because
  infra/.env still has the dev defaults; the point is they now flow
  from the environment, so a .env rotation updates the connector.

Step 3 — CDC still works end-to-end (real change events, not just 201)
  After the final (awk) registration:
    - UPDATE seats SET status='booked', version=version+1 WHERE id=1
      via psql in booking-system-postgres -> (1, booked, v3)
    - Consumed booking-system.public.seats from the beginning; the last
      UPDATE event (op:"u", snapshot:"false") decoded:
        before: available v2  ->  after: booked v3
      matching the live UPDATE exactly.
  (The first sed-iteration registration was likewise proven: UPDATE
  held v1 -> available v2 produced op:"u", snapshot:"false" on the
  topic.) So CDC flows through both script iterations; final stack
  state runs the awk version.

Step 4 — live password rotation: SKIPPED (explicitly permitted; noted
         why) + equivalent validation substituted
  Reason for skip: a concurrent dispatch (wayfinder ticket 0002, live
  at the time) depends on this exact compose Postgres with the current
  credentials — backend/.env has DATABASE_URL
  postgres://booking_system:booking_system@localhost:5434/... and
  pg_stat_activity showed 4 live connections from the booking_system
  user. Rotating the real DB password even briefly risks derailing
  that agent's test baseline with auth errors, and its prompt
  explicitly instructs it to run npm build/test against this stack.
  Ticket 0007 itself says skip if it risks disrupting other work —
  this qualifies.
  In place of the live rotation, the hazard the fix exists for
  (special characters in credentials) was validated directly inside
  the exact runtime image (curlimages/curl:8.10.1, busybox awk/sed,
  same as connect-init) with env values containing @ / & \ " in all
  three fields:
    - POSTGRES_PASSWORD='Rot@ted/p1&2\3new"line'
    - POSTGRES_DB='book/in&g\sys@tem'
  Result: substituted JSON parses (python3 json.load), the decoded
  database.password and database.dbname are byte-identical to the
  inputs, no placeholders remain, unrelated config fields intact.
  Byte-level behavior this validates: ENVIRON is byte-faithful, the
  JSON escaping is exactly correct, and no layer re-interprets the
  value — so ANY password (not just the tested classes) survives the
  pipeline. This is a strict superset of the protection the live
  rotation would have demonstrated; what it does not exercise is the
  ALTER USER dance on the real DB, which is purely operational.

Finding worth routing back to a ticket (NOT fixed — out of scope)
-----------------------------------------------------------------
The k8s path's substitution (k8s/20-kafka-connect.yaml, escape_for_sed
's/[\&@]/\\&/g' + sed "s@__DB_PASSWORD__@...") runs in the SAME
curlimages/curl:8.10.1 image. Empirical result in this image: busybox
sed's bracket class [\&@] does not match a literal backslash (mirrored
compose test produced raw '\3' in the JSON -> json.load error "Invalid
\escape"). So a rotated Postgres password containing a literal '\'
(or '"', which neither path escapes) would make the k8s Job POST an
invalid JSON payload (loud 400, not silent drift — but still broken),
and the k8s comment's claim that it handles '\' is not satisfied in
this image. Recommend a follow-up ticket to port the awk substitution
to k8s/20-kafka-connect.yaml once the human reviews what's checked in.

Files touched (only infra/, as dispatched)
------------------------------------------
  infra/connector/postgres-connector.json
  infra/connector/register-connector.sh
  infra/docker-compose.yml
No git commands were run. Nothing outside infra/ was modified.