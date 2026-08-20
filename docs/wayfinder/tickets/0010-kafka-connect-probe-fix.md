# 0010 — kafka-connect exec probe -> httpGet fix, verify on a real cluster

## Context

Tonight's "scaled-up setup test" (8 backend replicas via a real kind cluster)
surfaced `kafka-connect` restart-looping: 5 restarts in 13 minutes, with its
own `exec: curl -sf http://localhost:8083/connectors` probe timing out at
30s even when queried manually. Root cause: exec probes spawn a fresh curl
subprocess every check; under CPU contention (JVM GC pauses, other pods
competing for cores) that subprocess spawn itself can miss a tight timeout
even when Connect's REST API is fine. This predates tonight's session --
not a regression from the JWT auth work.

## Fix applied directly (not dispatched)

`k8s/20-kafka-connect.yaml`: swapped `startupProbe`/`readinessProbe`/
`livenessProbe` from `exec: curl` to `httpGet: {path: /connectors, port:
rest}` with an explicit `timeoutSeconds: 5` (kubelet's httpGet default is
1s, same as the original curl timeout that caused the flakiness -- widening
it is a legitimate improvement, not just removing the subprocess). httpGet
probes are answered by the kubelet directly against the pod's network
namespace, no subprocess involved.

## Resolution

VERIFIED PASS on a real kind cluster (kind v0.27.0, node image kindest/node:v1.32.2).

**Setup (actual, not simulated):** built `booking-backend:local` and
`booking-lb-proxy:local` (context = repo root), created cluster `booking-system`,
loaded both images, applied postgres/kafka/redis and waited for Ready. Kafka took
~7min to pull `confluentinc/cp-kafka:7.6.1` (452MB) — the initial 180s
`kubectl wait` timed out, but the image pull completed normally (no
ImagePullBackOff / connection-reset in this run) and `kafka-0` came up Ready.

**Observation window (kubelet httpGet probes live):**
- kafka-connect pod reached Running+Ready at 12:30:58; window ran 12:31:19 →
  12:39:07 (full 8 minutes, polled every 15s).
- **RESTARTS at start: 0. RESTARTS at end: 0.** Zero restarts across the entire
  8-minute window (and still 0 at the end of step 8, ~13min after creation).
- READY stayed `true` on every one of the 32 polls.
- REST API responsiveness confirmed in-window via `kubectl exec deploy/kafka-connect
  -- curl -s http://localhost:8083/connectors` at 12:33:05, 12:35:06, 12:37:06, and
  12:39:07 — all four returned `["booking-system-connector"]`, so the API was
  genuinely answering throughout, not just the pod surviving.

**CDC registration path (step 8) intact:**
- `kubectl wait --for=condition=complete job/connect-init` succeeded (connect-init
  Completed on first attempt — it had already registered the connector ~2min into
  the observation window, proving kafka-connect was genuinely ready to accept it).
- `GET /connectors` returned `["booking-system-connector"]`; connector status:
  `state: RUNNING`, task 0 `RUNNING` (worker 10.244.0.10:8083).
- Final API check returned HTTP 200.

**Context:**
- Full stack healthy at end of step 8: postgres-0, kafka-0, redis, kafka-connect
  all 1/1 Running; booking-backend replicas 0–2 and lb-proxy all Ready. (backend-0
  had a single restart during its own boot up, unrelated to kafka-connect, before
  coming Ready; all 3 backend replicas ran fine afterwards.)
- Host memory never approached the 2Gi floor (lowest available ~2.8Gi).

**Verdict:** the exec→httpGet probe fix holds. 0 restarts over 8 minutes with the
REST API responsive the whole time, and the connect-init/CDC registration path
that depends on kafka-connect being genuinely ready works end-to-end. Not flaky in
this run. Cluster and images cleaned up afterwards.
