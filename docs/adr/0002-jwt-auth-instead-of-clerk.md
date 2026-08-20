# ADR 0002 — Local JWT auth instead of Clerk

- Status: accepted
- Date: 2026-08-20
- Deciders: Vraj

## Context

`context.md` and the original CLAUDE.md scaffold named Clerk as the auth provider,
ported over from the Scalable-Backend-System repo. Clerk was never actually wired
into any route — `backend/src/infrastructure/auth/clerk.ts` exists but nothing calls
it, and `CLERK_SECRET_KEY` is optional in `env.ts`.

Two things forced a reconsideration before wiring auth for real:

1. **Load testing.** Driving real traffic at the `POST /bookings` endpoint with
   autocannon requires generating many authenticated requests (real userId +
   password) client-side, which is awkward against a third-party hosted auth
   provider and trivial against a local one.
2. **The load balancer.** Phase 2's `lb-proxy` is Power-of-Two-Choices — it routes
   each request independently to whichever backend pod currently looks least
   loaded (see ADR 0001). Session-based auth backed by in-memory server state would
   need sticky sessions to keep a client pinned to the pod holding its session,
   which directly defeats P2C's per-request routing. That's the whole differentiator
   of this project (CLAUDE.md: "Do not skip the Rust load balancer... The P2C +
   safety override LB is the differentiator").

## Decision

Replace Clerk with local JWT auth: a `users` table (email + password hashed with
Node's built-in `crypto.scrypt`, no native-module Docker build step), a
`POST /auth/register` and `POST /auth/login` that issue a signed, short-lived JWT,
and a Fastify `preHandler` that verifies the `Authorization: Bearer` token on
protected routes. Tokens carry `userId` as a claim; `reserveSeat` reads it from the
verified token, not from the request body — the current `booking.controller.ts`
trusting a client-supplied `userId` was a spoofing hole this closes as a side effect.

JWT verification is stateless — any backend pod can verify a token with just the
shared signing secret, no shared session lookup and no sticky routing, so it composes
cleanly with P2C instead of fighting it.

## Consequences

- Positive: no coupling between auth and load-balancer routing; any pod handles any
  request.
- Positive: load-test scripts can log in a pool of synthetic users once, cache their
  tokens, and replay them — no third-party API in the load-test critical path.
- Negative: JWTs can't be revoked before expiry without extra machinery (e.g. a Redis
  denylist). Not built here — tokens are short-lived and this is a portfolio demo, not
  a system with "log out everywhere" requirements. Worth revisiting if that changes.
- Negative: `bookings.user_id` changes from a free-text Clerk ID to an integer FK on
  a real `users` table — a real migration, not just a config swap.

## Alternatives considered

- **Keep Clerk, add sticky sessions at lb-proxy**: rejected — sticky sessions
  contradict the P2C design directly (ADR 0001's whole point is per-request routing
  to the least-loaded pod).
- **Keep Clerk, verify Clerk-issued sessions statelessly**: Clerk does support
  stateless JWT session tokens, which would have avoided this migration. Rejected
  anyway because the load-test requirement (many real login+password flows, fully
  scriptable, zero external dependency) was the deciding factor, not just the
  sticky-session issue.
- **Sessions in Redis instead of JWT**: avoids sticky sessions too (any pod can look
  up the shared Redis session), but adds a Redis round-trip to every authenticated
  request and a revocation-adjacent complexity JWT doesn't need for this project's
  scope. JWT was simpler given local auth was already the call.
