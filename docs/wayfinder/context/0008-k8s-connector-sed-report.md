Ticket 0008 report — k8s connector credential substitution mishandles a literal backslash
=========================================================================================
Date: 2026-08-20 (overnight AFK window)
House: opencode deepseek-v4-flash-free --variant max (wayfinder dispatch)

Summary
-------
The k8s Debezium connector path (k8s/20-kafka-connect.yaml, `register-connector.sh`
inside the `connector-files` ConfigMap) substituted Postgres credentials into the
connector JSON via a sed pipeline with an `escape_for_sed` helper
(`s/[\&@]/\\&/g`). Ticket 0007 proved empirically, inside the actual runtime image
(curlimages/curl:8.10.1, busybox sed), that this pattern fails to escape a literal
`\` in a password — busybox sed's bracket class `[\&@]` does not match a backslash,
so the produced JSON is invalid (`Invalid \escape` on parse, loud 400 on POST).
Port of ticket 0007's byte-faithful awk pipeline into the k8s script. The compose
path (infra/) was NOT touched (already fixed by 0007).

What changed (only k8s/20-kafka-connect.yaml)
---------------------------------------------
`register-connector.sh` in the `connector-files` ConfigMap (k8s/20-kafka-connect.yaml):
- Removed `escape_for_sed()` and the three-placeholder `sed -e "s@__X__@..."` block.
- Replaced with the same awk pipeline 0007 proved safe (from
  infra/connector/register-connector.sh), adapted to this Job's env var names:
    - `ENVIRON["DB_USER"]` / `ENVIRON["DB_PASSWORD"]` / `ENVIRON["DB_NAME"]`
      (the connect-init Job sources these from the postgres-credentials Secret
      via secretKeyRef — unchanged).
    - `jsonescape()` (index/substr, explicit `\\` `\"` `\n` `\t` `\r` `\b` `\f`
      escapes), `replace()` via `index()`/`substr()` — no metacharacter
      interpretation at any layer.
    - Same __DB_USER__ / __DB_PASSWORD__ / __DB_NAME__ template placeholders
      (postgres-connector.json in the same ConfigMap untouched), same output
      path /tmp/postgres-connector.json, same curl POST + 201/409 handling.
- Header comment now documents the awk approach and why (sed interprets &, \,
  and its delimiter; busybox sed's [\&@] fails on a literal backslash — values
  are JSON-string-escaped so any character round-trips exactly), mirroring the
  compose path's wording with the k8s Secret env names.
- Everything else in the manifest (template, deployment, service, job spec)
  unchanged. No other file touched.

Verification
------------

Step 1 — image-level hostile-character test (the core requirement)
  The awk program was extracted programmatically from the edited YAML
  (yaml.safe_load_all -> ConfigMap data -> exact text between `awk '` and
  `' /connector/postgres-connector.json`, 962 bytes, 37 lines) so the test
  exercised the byte-exact committed script, not a retyped copy. Run inside
  curlimages/curl:8.10.1 (the exact connect-init image) with hostile env:

    DB_USER      = 'us\er@&";x'
    DB_PASSWORD  = 'Rot@ted/p1&2\3new"line'   (the ticket-0007 value)
    DB_NAME      = 'book/in&g\sys@tem'        (the ticket-0007 value)

  Result: substituted JSON parses with python3 json.load, and the decoded
  config decodes byte-for-byte to the inputs:
    database.user     -> 'us\er@&";x'          OK
    database.password -> 'Rot@ted/p1&2\3new"line'  OK
    database.dbname   -> 'book/in&g\sys@tem'   OK
  No __DB_ placeholder text remains anywhere in the output; unrelated fields
  (connector.class, topic.prefix, name) byte-intact. The full extracted script
  also passes `sh -n` (busybox ash, the Job's /bin/sh).

  Bonus 1 — control-char branch: DB_PASSWORD containing a real newline
  ('Rot@ted/p1&2\3new"line' + \n + 'part2') round-trips exactly through the
  \n escape path (json.load decodes back to the identical bytes).

  Bonus 2 — the old bug reproduced in this image for the record: the removed
  escape_for_sed+sed pipeline run against the same values in
  curlimages/curl:8.10.1 produced raw '\3' in the JSON -> python3 json.load
  raises "Invalid \escape: line 7 column 25" — confirming exactly the failure
  0007 predicted for the k8s path and that the new path fixes it.

Step 2 — live kind cluster (booking-system) end-to-end: DONE
  Cluster was up, so the full proof was run. Only the connect-init Job was
  deleted+recreated (stateless registration Job, explicitly sanctioned); the
  connector registration was deleted once via the Connect REST API (204 —
  deletes only the Connect task registration, no Postgres/Kafka data). No
  other workload, StatefulSet, or PVC touched, no cluster teardown.

  1. `kubectl delete job connect-init` + `kubectl apply -f k8s/20-kafka-connect.yaml`
     -> configmap/connector-files configured (awk version), kafka-connect
     deployment/service unchanged, job recreated. First run of the new Job:
     HTTP 409 ("already exists" — old registration still present).
  2. Deleted the old connector registration, recreated the Job -> logs show
     HTTP 201 with the response body containing the fully resolved values:
     database.user/password/dbname = "booking_system" (the Secret's actual
     values), no __DB_ text anywhere. GET /connectors/booking-system-connector/
     config confirms: all three fields resolved, zero placeholder leakage.
  3. Real CDC event through the new registration:
       UPDATE seats SET status='booked', version=version+1 WHERE id=1
       -> (1, booked, 2)  [was held/v1]
     Consumed booking-system.public.seats (kafka-0, /usr/bin/kafka-console-
     consumer): last event decoded as
       op:"u", snapshot:"false",
       before: {id:1, status:"held",  version:1}
       after:  {id:1, status:"booked", version:2}
     matching the live UPDATE exactly. CDC flows through the awk registration.

  Note: the registered value "booking_system" equals the current dev Secret
  value, so on its own it wouldn't distinguish the mechanisms — that's why the
  image-level hostile-char test (Step 1) is the load-bearing evidence, plus
  the fact that the 201 response was produced by the awk substitution with
  zero placeholder leakage. A full credential ROTATION on the live cluster was
  not performed (would require ALTER USER + Secret change against a stack
  other work depends on; same reasoning 0007 recorded — Step 1's byte-level
  proof is a strict superset of what a rotation would demonstrate).

Files touched (only k8s/, per dispatch)
---------------------------------------
  k8s/20-kafka-connect.yaml (ConfigMap data.register-connector.sh only)
No git commands were run. Nothing else modified.