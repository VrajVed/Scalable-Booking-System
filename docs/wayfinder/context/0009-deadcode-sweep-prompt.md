# Prompt given to opencode/deepseek-v4-flash-free for ticket 0009

Repo: /home/vraj/Programming/flashseat (a Node/TS + Fastify + Drizzle backend,
Rust lb-proxy, k8s manifests). Today's session replaced Clerk auth with local
JWT auth (see docs/adr/0002-jwt-auth-instead-of-clerk.md for the full
rationale) and changed bookings.userId from a free-text Clerk ID to an
integer FK on a new `users` table.

Your job: a mechanical dead-code / consistency sweep across `backend/src/`
and `backend/test/`, NOT a redesign. Specifically:

1. Grep for any remaining references to "clerk"/"Clerk"/"CLERK_" anywhere in
   backend/src, backend/test, backend/.env.example, k8s/, infra/ -- the
   migration should have removed all of them. Report any survivors verbatim
   with file:line.
2. Find unused exports: functions/consts exported from a module but never
   imported anywhere else in backend/src or backend/test. Focus especially
   on backend/src/modules/auth/, backend/src/shared/crypto/,
   backend/src/shared/auth/, backend/src/shared/middleware/requireAuth.ts --
   these are all new this session and most likely to have leftover
   unused/duplicate code.
3. Find dead imports: anything imported but never referenced in the
   importing file.
4. Check backend/src/modules/booking/interface/booking.controller.ts and
   booking.routes.ts specifically: confirm there is no remaining code path
   that reads userId from request.body (the whole point of ADR 0002's
   requireAuth change was to stop trusting a client-supplied userId -- a
   leftover fallback would silently reopen that hole).
5. Check backend/src/infrastructure/database/schema/*.ts against
   infra/postgres/init.sql and k8s/00-postgres.yaml's embedded init.sql
   ConfigMap: do all three actually agree on every table/column/constraint?
   (init.sql and the k8s ConfigMap copy were both hand-edited this session,
   not generated from a single source of truth -- drift between them is a
   real risk.)

Do NOT modify code. Do NOT run destructive commands. This is read-only
analysis: grep, read files, report findings. Write your findings as a
Markdown report to
/home/vraj/Programming/flashseat/docs/wayfinder/context/0009-deadcode-sweep-report.md
with file:line references for every claim -- no vague "some functions may be
unused" hand-waving, name the exact export and confirm via grep that it has
zero other references in the repo (excluding its own definition and
re-exports via index.ts barrel files, which don't count as real usage).
