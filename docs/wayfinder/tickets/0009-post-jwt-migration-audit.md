# 0009 — Post-JWT-migration audit

## Context

ADR 0002 (docs/adr/0002-jwt-auth-instead-of-clerk.md) replaced Clerk with local
JWT auth in this session: new `users` table, `bookings.user_id` FK, new
`backend/src/modules/auth/` vertical slice, `requireAuth` middleware,
`bookings.userId` flow changed from client-supplied body field to
JWT-verified claim, `rateLimiter` made configurable
(RATE_LIMIT_MAX_REQUESTS/WINDOW_SECONDS), k8s manifests hand-synced
(00-postgres.yaml's embedded init.sql ConfigMap, 40-backend.yaml's new
JWT_SECRET Secret). ~47 files touched across backend/, k8s/, load-test/,
infra/, docs/, none of it committed yet.

## Goal

Adversarial re-audit of everything touched this session: correctness,
dead code / unused exports left over from the Clerk removal or schema
change, wiring gaps, stale docs, security issues. Not a request for new
features -- verify what's already here is right.

## Resolution

Three parallel dispatches: a Sonnet subagent auditing auth correctness/security,
a Sonnet subagent auditing k8s manifest + docs consistency, and an
opencode/deepseek-v4-flash-free dead-code sweep (failed with a transient
server error; the mechanical checks it would have done -- Clerk-reference
grep, unused-export sweep -- were done directly instead, see below).

**Found and fixed (real bug, HIGH severity):** `login.usecase.ts` had a
timing side-channel that reopened the exact email-enumeration hole
`InvalidCredentialsError` was designed to close. An unknown email
short-circuited before hashing (cheap DB lookup only); a wrong password on a
real account additionally ran a full scrypt derivation before throwing the
*same* error -- identical status/body, but distinguishable by response
latency. Fixed by always calling `verifyPassword` against either the real
user's hash or a fixed dummy hash, so both paths pay the same scrypt cost.
Added a regression test (`auth.controller.test.ts`) that measures both paths'
median latency over 8 samples and asserts they're within the same order of
magnitude -- this test would have caught the original bug.

**Found and fixed (stale docs):** `k8s/README.md`'s end-to-end smoke-test
curl example still POSTed `{"seatId": 1, "userId": "u1"}` -- pre-JWT-migration
shape. `POST /bookings/reserve` no longer accepts a body `userId` (ADR 0002)
and now 401s without a bearer token. Updated the example to register/login
first and pass the token via `Authorization: Bearer`.

**Checked, no issue found:**
- JWT algorithm confusion (alg:none, RS256-confusion): `jsonwebtoken`'s
  `verify()` correctly pins to HMAC algorithms when given a string secret --
  no exploitable path.
- Booking-flow userId spoofing: confirmed no code path reads `userId` from
  the request body; `requireAuth` is the sole source, already covered by test.
- Register race condition: the `findUserByEmail` -> `createUser` unique-
  constraint race is correctly handled (verified the `postgres` driver
  actually populates `.code` from `SQLSTATE`, not just assumed).
- `k8s/00-postgres.yaml`'s embedded init.sql ConfigMap vs
  `infra/postgres/init.sql`: byte-identical SQL bodies, no drift.
- `k8s/40-backend.yaml` HPA maxReplicas: still 3 in the file -- the 8-replica
  scale-up during tonight's testing was a live `kubectl patch` only, never
  written back.
- Env var consistency across `.env.example`/`.env`/`env.ts`/`40-backend.yaml`:
  all agree.
- CLAUDE.md / context.md: both correctly describe JWT/ADR-0002, not Clerk.
- Dead-code sweep (done directly after opencode failed): grepped for
  remaining Clerk references (2 hits, both are comments describing the
  historical migration, not leftover code) and checked every export from the
  new auth-module files -- the only "0 external references" exports are
  interface types used only as a function's own inline parameter type
  (`RegisterInput`, `LoginInput`, `AuthTokenPayload`) and an error class
  tested via HTTP status/code rather than `instanceof` in integration tests
  (`UnauthorizedError`) -- none of these are actually dead code.

Full suite: 64/64 passing (was 63; +1 for the new timing regression test).
