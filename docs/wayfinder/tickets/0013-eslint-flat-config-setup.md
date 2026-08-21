# 0013 — eslint flat-config setup, real findings fixed

## Context

`npm run lint` had been broken since ESLint v9 landed as a devDependency at some
earlier point: it just runs `eslint .` with no `eslint.config.js` anywhere (no
`.eslintrc.*` either) — ESLint v9 requires the new flat-config format, so every
invocation failed immediately with "couldn't find eslint.config.js". Flagged as a
known gap in `docs/wayfinder/map.md`'s "Not yet specified" for a while, never worth
its own ticket until tonight.

## Resolution

Dispatched to `opencode run --model opencode/nemotron-3.5-lightning-free --auto`
(mechanical, well-scoped: install a package, write one config file, verify). It
installed `typescript-eslint` correctly and got `npm run lint` working, but the
config it wrote imported the older split `@typescript-eslint/parser` +
`@typescript-eslint/eslint-plugin` API instead of the modern `typescript-eslint`
package's `tseslint.config(...)` helper the prompt explicitly asked for — those
happened to resolve as transitive deps of the one package actually declared in
`package.json`, so it worked today but would be fragile on a clean `npm ci` if the
dependency tree ever shifted. Rewrote `backend/eslint.config.js` directly to use the
proper helper API.

While rewriting, also fixed a real config gap: the plain `recommended` preset flags
this codebase's existing `_`-prefix-for-intentionally-unused convention (visible
throughout, e.g. `rateLimiter.ts`'s and `requireAuth.ts`'s `_reply: FastifyReply`
params) as errors, which isn't what "harden to zero known bugs" should mean here —
added `argsIgnorePattern`/`varsIgnorePattern: "^_"` to `no-unused-vars`. That dropped
the noise from 9 findings to 4 real ones.

**All 4 real findings fixed** (genuine dead code, not convention false-positives):
- `test/booking/reserve-seat.usecase.test.ts:194` — an `Array.from({length: N}, (_, i)
  => ...)` callback where neither param was used; dropped both, no behavior change.
- `test/booking/booking.controller.test.ts` — unused `disconnectProducer` import
  (the file's own `closeHoldExpiryQueue` import right below it IS used, kept).
- `test/booking/hold-expiry.test.ts` — unused `closeHoldExpiryQueue` import (this
  file's own `disconnectProducer` import IS used at line 76, kept — same two names,
  opposite unused-ness, in the two sibling test files; worth double-checking each
  independently rather than pattern-matching, which is what happened here).
- `test/lifecycle/shutdown.test.ts` — unused `before` import from `node:test` (the
  string "before" appears several times in assertion messages/prose, not as an
  actual `before()` hook call — worth noting since a naive text search would have
  missed that these were false matches).

`npm run lint` now exits clean (0 findings), `npm run build` clean, full suite
re-run after the test-file edits: 64/64 passing.
