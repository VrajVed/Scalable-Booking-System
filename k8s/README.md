# k8s — locally-deployable Kubernetes setup for the booking system

`kubectl apply -f k8s/` brings up the whole system on a kind cluster:

```
              ┌───────────────┐
    :80 ─────►│ nginx ingress │   (ingress controller, assumed installed)
              └──────┬────────┘
                     │   http://booking.local
                     ▼
              ┌───────────────┐        P2C + health overrides (router-core)
              │  lb-proxy     │ ──────► booking-backend-0, -1, -2
              └───────────────┘        (headless StatefulSet DNS names)
                     │
        ┌────────────┴──────────────────────────┐
        │  Postgres ──► Debezium ──► Kafka      │
        │          │                    │       │
        │          │                    └──► backend CD C consumer → Redis
        └───────────────────────────────────────┘
```

## Prerequisites

- Docker (for building images)
- `kind` (kubernetes-in-docker)
- `kubectl`
- An nginx ingress controller **installed in the cluster**. For kind:

  ```bash
  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml
  kubectl wait --namespace ingress-nginx \
    --for=condition=ready pod --selector=app.kubernetes.io/component=controller \
    --timeout=120s
  ```

- (Optional) metrics-server so the backend HPA sees real CPU metrics instead
  of `<unknown>`:

  ```bash
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
  # kind kubelets serve metrics over HTTP; allow the insecure TLS flag:
  kubectl -n kube-system patch deployment metrics-server --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
  ```

## Build + load images

```bash
# Backend (context = backend/)
docker build -t booking-backend:local backend/

# lb-proxy: depends on the sibling router-core crate (path dependency
# `../router-core`), so the build context must be the repo ROOT, not lb-proxy/:
docker build -f lb-proxy/Dockerfile -t booking-lb-proxy:local .

# Create the cluster (maps host 80/443 to the ingress controller; add
# `127.0.0.1 booking.local` to /etc/hosts to hit it as booking.local)
kind create cluster --name booking-system --config k8s/kind-config.yaml

# Load the locally-built images so the cluster doesn't try to pull them
kind load docker-image booking-backend:local booking-lb-proxy:local --name booking-system
```

## Deploy

```bash
kubectl apply -f k8s/
```

Note: `k8s/kind-config.yaml` is a *kind* cluster configuration file (`kind.x-k8s.io/v1alpha4`), not a Kubernetes manifest — `kubectl apply -f k8s/` prints a harmless error for it ("no matches for kind Cluster ... ensure CRDs are installed first") after applying everything else. All other files apply cleanly.

Everything lands in the `default` namespace. Wait for readiness:

```bash
kubectl rollout status statefulset/booking-backend --timeout=180s
kubectl get pods
```

Kafka Connect registers the Debezium connector via a one-shot `connect-init`
Job that retries until Connect's REST API is up. It runs a **templated** copy
of `infra/connector/register-connector.sh` embedded in the `connector-files`
ConfigMap (k8s/20-kafka-connect.yaml): the JSON carries `__DB_USER__` /
`__DB_PASSWORD__` / `__DB_NAME__` placeholders that the script substitutes
from the same `postgres-credentials` Secret the Postgres StatefulSet uses, so
the connector can't silently drift from the Secret. Verify it:

```bash
kubectl wait --for=condition=complete job/connect-init --timeout=180s
kubectl exec deploy/kafka-connect -- curl -s http://localhost:8083/connectors
# expect: ["booking-system-connector"]
```

## Verify it's up

lb-proxy's `/health` (P2C-routes requests, but answers `/health` itself —
it's intercepted locally, never proxied to a backend):

```bash
# via the ingress (needs booking.local in /etc/hosts)
curl -H "Host: booking.local" http://127.0.0.1/health

# or via port-forward straight to the lb-proxy Service (no ingress needed)
kubectl port-forward svc/lb-proxy 8080:8080 &
curl http://127.0.0.1:8080/health
```

Both return lb-proxy's own diagnostics — per-backend health plus a lifetime
request counter:

```json
{"status":"ok","timestamp_ms":"...","requests_total":N,"backends":[{"id":0,"url":"http://booking-backend-0...","in_flight":0,"five_xx_in_window":0}]}
```

(The backend's own `/health` — `{"status":"ok","timestamp":"...","cdcConsumer":"connected"}` — is only reachable directly on a backend pod, e.g. `kubectl exec statefulset/booking-backend -- wget -qO- http://localhost:3000/health`; the lb-proxy never forwards `/health` upstream.)

End-to-end booking smoke test (insert a seat, reserve it through the LB,
watch the WAL → Debezium → Kafka → Redis cache-invalidation path):

```bash
kubectl exec statefulset/postgres -- psql -U booking_system -d booking_system \
  -c "INSERT INTO venues(name,city) VALUES('Demo Arena','Mumbai');"
kubectl exec statefulset/postgres -- psql -U booking_system -d booking_system \
  -c "INSERT INTO events(venue_id,name,starts_at) VALUES(1,'Flash Sale','2026-12-31 20:00:00+00');"
kubectl exec statefulset/postgres -- psql -U booking_system -d booking_system \
  -c "INSERT INTO seats(event_id,section,row_label,seat_number) VALUES(1,'A','1',1);"
kubectl exec statefulset/postgres -- psql -U booking_system -d booking_system \
  -c "SELECT setval('seats_id_seq', (SELECT max(id) FROM seats));"
```

Booking now requires a JWT (ADR 0002) -- register/login first, then pass the
token via `Authorization: Bearer`:

```bash
TOKEN=$(curl -s -H "Host: booking.local" -X POST http://127.0.0.1/auth/register \
  -H 'Content-Type: application/json' -d '{"email":"demo@example.com","password":"correct-horse-battery"}' \
  | jq -r .token)

curl -X POST -H "Host: booking.local" -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1/bookings/reserve \
  -H 'Content-Type: application/json' -d '{"seatId": 1}'
```
```

## Cleanup

```bash
kind delete cluster --name booking-system
```

## Notes / known limitations

- **BACKEND_POOL is a static list of the three StatefulSet pod DNS names** —
  that's the point (individual backends for P2C). The HPA in 40-backend.yaml
  is capped at `maxReplicas: 3` to match this fixed pool exactly — scaling
  further would need dynamic service discovery (e.g. watching the headless
  Service's Endpoints/EndpointSlice), which is out of scope for this demo
  (see `docs/adr/0001-k8s-headless-backend-service.md`).
- HPA shows `<unknown>` targets unless metrics-server is installed (above).
- Postgres credentials are committed as a plain Secret for a local-dev demo —
  not production credential handling.
- On the k8s path the connector credential placeholders are substituted from
  the `postgres-credentials` Secret at Job runtime (see the Deploy section) —
  no hardcoded creds to drift. The static `infra/connector/postgres-connector.json`
  with hardcoded dev creds is only used by the docker-compose path.
- The backend starts a Kafka producer/consumer at boot, so the init container
  waits for Kafka+Postgres to avoid a crash/restart loop while they come up.
- Debezium must be able to connect to Postgres on the `postgres` Service name;
  the ConfigMap copy of the connector config differs from
  `infra/connector/postgres-connector.json` only in the credential
  placeholders (`__DB_USER__`/`__DB_PASSWORD__`/`__DB_NAME__`).