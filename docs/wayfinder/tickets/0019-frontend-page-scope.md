# 0019 — Frontend page scope

## Context

Backend, LB, k8s, infra, and observability are all done and adversarially
hardened (tickets 0001-0018). The only remaining piece of the portfolio
project is the frontend. Scaffold (`npm create vite@latest frontend --
--template react-ts` + Tailwind CSS v4 via `@tailwindcss/vite`) already done
and build-verified. No pages built yet.

`map.md`'s old "Out of scope" note calling frontend an idea.md non-goal is
stale/superseded — the user explicitly decided to build one.

## Decision

Core 5 pages, each mapping 1:1 to an existing backend route — no speculative
surface area, matching the resume/portfolio scope-calibration note from
ticket 0017:

1. **Login / Register** — `POST /auth/login`, `POST /auth/register`
2. **Event catalog** — `GET /events`
3. **Seat map / seat picker** — `GET /events/:id/seats`, reserve a seat
4. **My bookings** — `GET /bookings` (list) with confirm/cancel actions
5. **Booking detail** — `GET /bookings/:id`, confirm/cancel buttons

Plus 6 BookMyShow-style UX pages, all built on data the backend already
returns — no new endpoints or schema changes:

6. **Home / landing** — hero + upcoming-events grid off `GET /events`
7. **Event detail page** — split out of the catalog list (event + venue info,
   "select seats" CTA) rather than seat-picking inline from a bare list
8. **City filter** — client-side filter on `venues.city` (already returned
   by `GET /events`, no backend change)
9. **Checkout / order review step** — a confirm-before-confirm screen
   wrapping the existing `POST /bookings/:id/confirm`
10. **Ticket / confirmation page** — post-confirm screen with a
    client-generated QR code from the booking id, no backend needed
11. **404 / not-found page**

**Explicitly declined for now** (would need real backend work — schema
migrations or a new endpoint — decided against per portfolio-scope
discipline, ticket 0017's framing): a profile page (`GET /me` doesn't
exist), event poster images, ticket pricing, event categories (`events`/
`venues` schema has none of these fields). Revisit only if the user asks.

Single-page app, client-side routing (react-router), JWT held client-side
(no cookies — matches ADR 0002's stateless-auth design, and CORS is already
configured with `credentials: false` for exactly this reason). No
meta-framework/SSR — plain Vite SPA is enough for a demo.

Visual mockups of all 11 pages (light blue/cyan theme, approved before
implementation) saved at
[`docs/wayfinder/context/0019-frontend-mockups.html`](../context/0019-frontend-mockups.html).

## Resolution

Built all 11 pages in `frontend/src/` (React 19 + TS, react-router, Tailwind
v4 with a light blue/cyan token system matching the approved mockup — no
gradients/glows, flat surfaces + a hairline diagonal pattern for image
placeholders). `AuthProvider` (localStorage-persisted JWT) + `ProtectedRoute`
gate the bookings/checkout/ticket routes; `lib/api.ts` is a thin typed fetch
wrapper hitting the real endpoints.

**Real data shape forced two adaptations from the original mockup**, caught
by reading the actual schema/usecases rather than assuming:

- **No price field anywhere** (`events`/`venues`/`seats`/`bookings` schema
  has none) — every price/amount shown in the mockup was dropped from the
  real build rather than faked.
- **`POST /bookings/reserve` takes one `seatId`, not a set** — the seat
  picker is single-select, not the mockup's multi-seat picker. Matches what
  the backend can actually do.
- **`bookings` rows carry only `seatId`, no event/venue join** — no
  `GET /seats/:id` or joined-booking endpoint exists, so the bookings
  list/detail/ticket pages show "Seat #N" rather than an event name. Flagged
  as a real gap, not silently invented data; would need a small backend
  addition to fix properly, left for the user to decide on.

**Real bug found and fixed during live verification** (not a load-test
artifact to shrug off): event id 7 in the seed data has ~400,000 seats. The
seat picker would have rendered all of them as DOM buttons, and
`GET /events/:id/seats` had no pagination — any real venue-sized event would
hit the same wall, not just this seed row. Added an optional `limit` query
param (1-1000, `zod`-validated, defaults to unbounded so every existing
caller/test keeps its old behavior) to the endpoint/usecase/repository;
frontend now requests a 240-seat page for the picker and a 500-seat capped
count for the "N seats left" badge, showing "500+" when the cap is hit
instead of a fake exact number.

**Live-verified**, not just typechecked: brought up postgres/redis/kafka/
kafka-connect (skipped Prometheus/Grafana, RAM-conscious), ran the real
backend + frontend dev servers, and drove the actual HTTP flow end-to-end
with curl matching the frontend's own request shapes — register → list
events → list seats (bounded) → reserve → get → confirm → list bookings →
double-confirm correctly 409s. `npm run build` clean on both `frontend/` and
`backend/`. Backend test suite re-run after the `limit` change (dev server
killed first per the established Redis/BullMQ contention workaround).

Browser-based visual QA wasn't available this session (user has the Claude
in Chrome extension mid-install, declined to finish for now) — the flow is
verified at the HTTP-contract level, not screenshotted. Worth a manual
look before calling the frontend fully done.
