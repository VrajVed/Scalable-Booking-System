# Ticket 0002: rate limiter trusts a spoofable client IP

Status: **closed**. Type: `wayfinder:task` (AFK). Resolved by opencode
deepseek-v4-flash-free --variant max, 2026-08-20 (see Resolution below).

## Question

`backend/src/shared/middleware/rateLimiter.ts` keys on
`request.headers["x-forwarded-for"] ?? request.ip`, with no `trustProxy`
configured on the Fastify instance. Confirmed (read-only check during the
prior audit) that `lb-proxy/src/proxy.rs` forwards headers verbatim and
never overwrites/appends `X-Forwarded-For` with the real client IP — so any
client can rotate the header per request to dodge rate limiting, or spoof a
victim's IP to get them limited instead.

Resolve by making a real trust-boundary decision and implementing it:
- Correct fix belongs at the edge: lb-proxy should set/append
  `X-Forwarded-For` with the actual peer IP of the inbound connection
  before forwarding (standard reverse-proxy behavior), and the backend
  should trust only the hop count it actually controls.
- If lb-proxy is changed: this touches `lb-proxy/src/proxy.rs`'s header
  handling — needs its own test (spoofed inbound XFF header is discarded/
  appended-to, not passed through raw) and must not touch `router-core/`.
- Backend-side: configure Fastify's `trustProxy` appropriately once the
  edge is trustworthy, and add a test proving a spoofed XFF from a
  "client" no longer resets the rate-limit counter.
- If you decide the correct fix is backend-only (e.g. ignore XFF entirely
  and key on `request.ip` as seen by lb-proxy, since this is a single-hop
  topology with no other proxy in front), that's an acceptable alternative
  — but it must be a stated decision with reasoning, not a silent partial
  fix. Record which approach was taken and why in the resolution.

## Resolution (2026-08-20, opencode deepseek-v4-flash-free)

**Option 1 — fix at the edge + backend trust boundary. Both sides changed.**

### Why Option 1, not backend-only

The "backend-only" path (key on the raw socket peer, ignore XFF) was
investigated and rejected as the *primary* mechanism for one structural
reason: after this fix, `request.ip` must mean "the client", and in this
deployment only lb-proxy can know that — the backend's direct peer is the
lb-proxy pod, not the client. Keying the backend on its raw socket address
alone would rate-limit *all* clients behind lb-proxy into one shared
100/min budget per backend replica (fail-closed but structurally wrong —
one abusive client starves every other). The edge hop is cheap to trust and
is, per the topology above, the only trusted hop that exists, so the
correct boundary is: **lb-proxy writes the client identity, the backend
trusts exactly one hop**. That is Option 1.

### What changed

**lb-proxy (edge):**
- `lb-proxy/src/proxy.rs`: new `set_forwarded_for()` (mirroring
  `strip_hop_by_hop()`'s shape) **overwrites** `X-Forwarded-For` with the
  actual TCP peer IP of the accepted inbound connection — a client-supplied
  value (single forged entry or a forged multi-hop chain) is discarded, not
  appended. `handle()` now takes the `SocketAddr` from `run_until()`'s
  `listener.accept()` (previously discarded as `_peer`) and calls it after
  the hop-by-hop strip + Host rewrite (proxy.rs:327-338, 356-361, 400-407).
  Overwrite (not append) is deliberate: appending preserves client-forged
  entries in the chain that the backend's "trust one hop" walk would still
  key on; overwriting means the backend only ever sees the IP the proxy
  itself observed.
- Tests: unit test `set_forwarded_for_overwrites_client_spoofed_value_with_real_peer_ip`
  and integration test `overwrites_client_spoofed_x_forwarded_for_with_the_real_peer_ip`
  (real sockets: spoofed XFF in, backend sees exactly `127.0.0.1`).
- `router-core/` untouched.

**backend (trust boundary):**
- `src/config/env.ts`: new `TRUST_PROXY_ADDRESSES` (comma-separated IPs /
  CIDRs / named ranges, default `"loopback"`).
- `src/index.ts`: Fastify constructor gained
  `trustProxy: env.TRUST_PROXY_ADDRESSES.split(",").map(trim).filter(Boolean)`
  — the only change to that file.
- `src/shared/middleware/rateLimiter.ts`: key on `request.ip ?? "unknown"`
  only; the raw `x-forwarded-for` header is never read (single line change).
- `k8s/40-backend.yaml`: manifest sets `TRUST_PROXY_ADDRESSES =
  loopback,10.244.0.0/16` (loopback = kubectl port-forward; pod CIDR =
  lb-proxy's pod IP; headless Service = direct pod-to-pod TCP, no SNAT, so
  the backend's peer really is the lb-proxy pod).
- `backend/.env.example` documents the var.

### Why NOT `trustProxy: 1` / `trustProxy: true`

Fastify v5 types accept `boolean | string | string[] | function`.
Checked the shipped runtime (`node_modules/fastify/lib/request.js`
`getTrustProxyFn`): a **number** is deliberately converted to
"trust nothing" ("Hop-count-only trust cannot validate the immediate peer.
Fail closed.") — Express-style hop counting does not exist in v5, so
`trustProxy: 1` would silently key every request on the lb-proxy pod IP.
`true` (trust everything) was rejected: in this deployment it *would* work
today (lb-proxy overwrites XFF), but it hands header authority to anything
that can connect directly to the backend — no fail-closed behavior if a
future hop or direct path appears. The exact per-address allowlist is the
"exactly one hop" statement, with the mechanism that any untrusted direct
peer is keyed on its socket and its XFF is ignored.

### Tests

- lb-proxy: 31 → 33 passed (1 unit + 1 integration added), `cargo clippy
  --all-targets` 0 warnings (was 0).
- backend: `npm run build` clean; `npm test` 47 → 49 passed (+2 spoof
  tests), 0 failed, 1 pre-existing `it.todo`. New tests drive the real
  Fastify request path with `inject` + `remoteAddress`:
  1. untrusted direct peer sending rotating spoofed XFF: 100 ok → 101st
     429 despite a different header on every request;
  2. trusted-hop view: only the rightmost (proxy-written) XFF entry keys
     the counter; rotating pre-pended client entries cannot dodge or
     misdirect; a genuinely different client gets its own counter.
  (One earlier full-suite run flaked on `test/booking/hold-expiry.test.ts`
  — a 10s race-window test owned by the concurrent hold-expiry work; it
  passed in isolation and on every rerun, unrelated to this change.)

### Live verification (kind cluster `booking-system`)

Before fix (deployed images): 105 requests through lb-proxy with a rotating
spoofed `X-Forwarded-For` — 105/105 non-limited (vulnerability reproduced
live). After rebuild + rollout (both images + manifest env): same 105-request
flood — exactly 100 pass, then hard 429s. End-to-end proof that rotating the
header no longer resets the rate-limit counter.

### Residual notes

- All port-forwarded/localhost clients share one bucket (they all appear as
  127.0.0.1 at the proxy) — inherent to single-hop trust, acceptable.
- Trusting the whole pod CIDR means any pod is a trusted hop; in-cluster
  pod-to-pod access is the k8s network trust boundary. Tightening to one
  specific pod IP would break on every rollout.
