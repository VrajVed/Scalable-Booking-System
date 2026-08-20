# ADR 0001 — Headless backend Service + StatefulSet for P2C routing

- Status: accepted
- Date: 2026-08-19
- Deciders: Vraj

## Context

Phase 2's Rust `lb-proxy` routes with Power-of-Two-Choices over **individually
addressable** backends, tracking live per-backend health signals (latency,
5xx, in-flight) that feed router-core's scoreboard. A standard Kubernetes
`Service` exposes its pods behind a single ClusterIP VIP, which would present
the backend pool to lb-proxy as one opaque endpoint — collapsing the 
per-backend health model and defeating the entire purpose of the Phase 2
router.

Additionally, the backend runs an async startup path
(`connectProducer()` / `startCdcConsumer()` are awaited before `listen()`), so
dependency ordering (Kafka up before backend starts) matters.

## Decision

Run the backend as a **StatefulSet** (3 replicas) behind a **headless Service**
(`clusterIP: None`). Each pod gets a stable DNS name:

```
booking-backend-{0,1,2}.booking-backend-headless.default.svc.cluster.local:3000
```

`lb-proxy`'s `BACKEND_POOL` lists these three names explicitly, so P2C routing
and per-backend health tracking see real, individually-routable pods. The
headless Service also makes the replica set identity-stable, which keeps the
fixed pool valid across pod restarts (DNS re-resolves to the new Pod IP).

## Consequences

- Positive: P2C sees three real backends; exact pattern from Phase 2 works
  unmodified; stable DNS for direct per-pod probing.
- Positive: the StatefulSet gives a clean per-pod consumer-group split for the
  CDC consumer (`booking-system-cdc-consumer-<pod>`), so every replica
  invalidates cache rather than one pod owning the topic partition.
- Negative: `BACKEND_POOL` is static. If the backend HPA scales the
  StatefulSet beyond 3 replicas, lb-proxy won't learn about
  `booking-backend-3+` unless its pool is updated. Scaling beyond a fixed pool
  needs service discovery (e.g. an endpoint-watching sidecar or a DNS-based
  pool refresh). That is explicitly out of scope for this demo, where the HPA
  is a CPU-based placeholder (min 3 / max 6) and remains a demo artifact.

## Alternatives considered

- **ClusterIP Service as the pool**: rejected — hides individual pods from P2C.
- **Per-pod Services + a configmap updated by a controller**: correct for
  dynamic pools but heavy machinery for a local demo.
- **FlatDeployment + endpoints synced into lb-proxy**: adds a bespoke
  discovery loop — more moving parts than the fixed StatefulSet names above.