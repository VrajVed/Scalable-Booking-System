# Prompt given to opencode for ticket 0010

Repo: /home/vraj/Programming/flashseat. `k8s/20-kafka-connect.yaml` was just
edited to fix a flaky health probe (see docs/wayfinder/tickets/0010-*.md for
the full context: it was `exec: curl` probes, now `httpGet`). Your job is to
verify the fix on a REAL kind cluster, not just eyeball the YAML.

This is a Node/Fastify + Postgres + Kafka(KRaft) + Debezium + Redis + Rust
lb-proxy system. Docker images `booking-backend:local` and
`booking-lb-proxy:local` do NOT currently exist locally -- you need to build
them first.

## Steps (run these for real, report exact output at each stage)

1. `cd /home/vraj/Programming/flashseat && docker build -t booking-backend:local backend/`
2. `docker build -f lb-proxy/Dockerfile -t booking-lb-proxy:local .` (build
   context MUST be repo root, not lb-proxy/ -- it has a path dependency on
   the sibling router-core crate)
3. `kind create cluster --name booking-system --config k8s/kind-config.yaml`
4. `kind load docker-image booking-backend:local booking-lb-proxy:local --name booking-system`
5. `kubectl apply -f k8s/00-postgres.yaml -f k8s/10-kafka.yaml -f k8s/30-redis.yaml`
   -- wait for those 3 to be Ready before continuing (`kubectl wait
   --for=condition=ready pod -l app=postgres/kafka/redis --timeout=180s`
   run separately per label). Kafka's image
   (`confluentinc/cp-kafka:7.6.1`) is large; if `kubectl get pods` shows
   `ImagePullBackOff` for kafka-0 with a "connection reset by peer" error in
   `kubectl describe pod kafka-0`, that's a known transient network hiccup --
   just wait, kubelet auto-retries and it resolves on its own within a
   couple minutes. Do not try to work around it by other means.
6. `kubectl apply -f k8s/20-kafka-connect.yaml`
7. THE ACTUAL TEST: watch `kubectl get pods -l app=kafka-connect -w` (or
   poll `kubectl get pods -l app=kafka-connect` every 15s) for a full 8
   MINUTES after the pod first reaches Running. Record the RESTARTS count
   at the start and end of that window. Success = 0 restarts across the
   full 8-minute window. Also run `kubectl exec deploy/kafka-connect --
   curl -s http://localhost:8083/connectors` a few times during the window
   to confirm the REST API itself is actually responsive throughout, not
   just that the pod isn't restarting.
8. `kubectl apply -f k8s/40-backend.yaml -f k8s/50-lb-proxy.yaml` (need
   `JWT_SECRET` to exist for the backend pods to boot -- 40-backend.yaml
   already creates a `backend-jwt-secret` Secret with a dev-only value, no
   action needed) -- just confirm the connect-init Job still completes
   (`kubectl wait --for=condition=complete job/connect-init --timeout=180s`)
   and the connector registers (`kubectl exec deploy/kafka-connect --
   curl -s http://localhost:8083/connectors` should show
   `["booking-system-connector"]`), proving the probe fix didn't break the
   CDC registration path that depends on kafka-connect being genuinely
   ready.
9. CLEANUP (always run this, even if a step above failed):
   `kind delete cluster --name booking-system`, then
   `docker rmi booking-backend:local booking-lb-proxy:local`. Verify with
   `kind get clusters` (expect "No kind clusters found") and
   `docker ps --filter name=booking-system` (expect empty) before finishing.

## Constraints

- Do NOT scale the backend beyond the default 3 replicas in the manifest --
  this is a probe-stability verification, not a load test, keep it minimal.
- Do NOT run any load-testing tools (autocannon, the load-test/ scripts).
- Do NOT modify any files except appending your findings to
  docs/wayfinder/tickets/0010-kafka-connect-probe-fix.md's "## Resolution"
  section (replace the placeholder line there) -- do not touch any other
  file.
- Total memory on this host is 15Gi; if `free -h` ever shows available
  memory dropping below ~2Gi, stop immediately, run the cleanup step, and
  report that instead of continuing.
- Budget: this whole verification should take well under 30 minutes,
  dominated by the Kafka image pull and the 8-minute observation window.
  If any single step hangs for more than 5 minutes with no progress, stop,
  clean up, and report exactly where it got stuck rather than waiting
  indefinitely.

Report the restart count before/after the 8-minute window, whether the REST
API stayed responsive throughout, and whether the connector registration in
step 8 succeeded. Be honest if it's still flaky -- this is a verification,
not a rubber stamp.
