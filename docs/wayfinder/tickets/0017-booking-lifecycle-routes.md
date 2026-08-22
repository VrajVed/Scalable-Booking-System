# 0017 — a real booking lifecycle: catalog browsing + confirm/cancel/get/list

## Context

The booking flow was one endpoint: `POST /bookings/reserve`, and only that. No way
to discover a `seatId` without querying Postgres directly, no confirm step (idea.md's
"Booking -> Payment -> Confirmation" flow had no Confirmation), no cancel, no way to
view your own bookings. `seats.status` already had a `'booked'` value in its enum and
`producer.ts`'s event-type union already listed `booking.confirmed`/`booking.cancelled`
— both designed for from the start, neither ever reached by any code path.

## Resolution

**New `catalog` module** (read-only, no auth -- browsing is public on any real
ticketing site): `GET /events`, `GET /events/:eventId/seats?status=`. Uses the
existing `idx_seats_event_status` index.

**Booking module gets a real lifecycle**:
- `GET /bookings` — the caller's own bookings.
- `GET /bookings/:bookingId` — one booking, 404 for both "doesn't exist" and
  "exists but isn't yours" (same status code for both, so a booking id can't be
  enumerated by response-code difference — same reasoning as the auth module's
  timing-side-channel fix in ticket 0009, applied to a simpler surface here).
- `POST /bookings/:bookingId/confirm` — the simulated "Payment" step from idea.md
  (no real gateway, that's an explicit non-goal; this endpoint IS the confirmation).
  pending -> confirmed, seat held -> booked, in one transaction. Publishes
  `booking.confirmed`.
- `POST /bookings/:bookingId/cancel` — pending or confirmed -> cancelled, releases
  the seat either way. Also removes the now-pointless hold-expiry BullMQ job
  (best-effort cleanup, not a correctness requirement -- `expireHold`'s own
  `status = 'pending'` WHERE clause already makes a stray job safely no-op). Publishes
  `booking.cancelled`.

**New seat-repository transitions**, same optimistic-concurrency shape as the
existing ones: `confirmSeatRow` (held->booked) and `releaseHeldOrBookedSeatRow`
(held-or-booked->available). The cancel path specifically needed the combined
"either" version rather than picking held-vs-booked based on a pre-transaction status
read -- that status could go stale between the read and the transaction (e.g. a
race between confirm and cancel), so matching either prior state in one statement is
the race-free version, not a status guess.

Both new usecases throw a loud, unswallowed `Error` (not a normal domain error) if
the booking-side transition wins its race but the seat-side one doesn't match --
that would mean the booking/seat states had already drifted out of sync before this
call, which `reserveSeat`'s and `expireHold`'s own transactions should never allow.

**Tests**: 34 new (`test/catalog/catalog.controller.test.ts`,
extended `test/booking/booking.controller.test.ts`) covering auth, ownership
(404-not-403), the full pending->confirmed->cancelled and pending->cancelled state
paths (asserting the seat's actual status after each), and the 409s for invalid
transitions. Full suite: 88/88 passing, `npm run build`/`npm run lint` clean.
