# 0018 — CORS, ahead of frontend work

## Context

User asked whether backend was ready to move to frontend. It was, functionally, for
the 3 core pages (auth, catalog browsing, booking lifecycle) -- except the backend
had zero CORS handling. A Vite dev frontend on a different port (`:5173` default)
would have hit an opaque browser-blocked-by-CORS error on its very first `fetch()`
call, with nothing in this repo explaining why.

## Resolution

`@fastify/cors` registered in `index.ts`, before every other hook/route so CORS
headers apply uniformly (including to error responses -- a cross-origin frontend
needs to read a 401/429/500 body too, not just a 2xx one). New `CORS_ORIGINS` env
var (comma-separated, defaults to `http://localhost:5173`), explicit allowlist
rather than a wildcard -- keeps the browser's CORS error surface meaningful (an
unexpected origin fails loudly) even though this API's stateless Bearer-token auth
(ADR 0002) means a wildcard wouldn't directly expose credentials the way it would
for cookie-based auth. `credentials: false` for the same reason -- no cookies to
carry cross-origin.

Live-verified with real preflight/actual requests, not just reading the plugin's
docs: an allowed origin gets `access-control-allow-origin` on both an `OPTIONS`
preflight and the real `GET`; a disallowed origin (`http://evil.example.com`) gets
no CORS headers at all, which is what makes the browser block it.

Full suite: 88/88 passing (existing tests build their own minimal Fastify instances
via `app.inject()`, which don't register CORS, so nothing in the existing suite was
affected). `npm run build`/`npm run lint` clean.
