import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { cancelBooking, confirmBooking, getBooking } from "../lib/api";
import { useCountdown } from "../lib/useCountdown";
import type { Booking } from "../lib/types";
import { StatusPill } from "../components/StatusPill";

function Countdown({ target }: { target: string | null }) {
  const countdown = useCountdown(target);
  if (!countdown) return <span className="text-text-dim">—</span>;
  return (
    <span
      className={`font-mono px-2 py-0.5 rounded-full text-[11px] ${
        countdown.expired ? "bg-danger-bg text-danger" : "bg-surface-2 text-text-dim"
      }`}
    >
      {countdown.expired ? "expired" : `${countdown.label} remaining`}
    </span>
  );
}

// Groups the per-seat bookings a multi-select reservation created (the
// backend has no group-booking concept -- see SeatPickerPage) into one
// review/confirm screen so picking several seats still feels like one
// checkout instead of N separate ones.
export function MultiCheckoutPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const ids = (params.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const warning = (location.state as { warning?: string } | null)?.warning;

  function load() {
    Promise.all(ids.map((id) => getBooking(id)))
      .then(setBookings)
      .catch(() => setError("Couldn't load one or more of these bookings."));
  }

  useEffect(load, [params]);

  const pending = bookings?.filter((b) => b.status === "pending") ?? [];

  async function handleConfirmAll() {
    setBusy(true);
    setError(null);
    const results = await Promise.allSettled(pending.map((b) => confirmBooking(b.id)));
    const failures = results.filter((r) => r.status === "rejected").length;
    if (failures > 0) {
      setError(`${failures} of ${pending.length} couldn't be confirmed — they may have expired.`);
    }
    load();
    setBusy(false);
    if (failures === 0) {
      navigate(`/bookings/${pending[0]?.id}/ticket`, { state: { allIds: pending.map((b) => b.id) } });
    }
  }

  async function handleReleaseAll() {
    setBusy(true);
    setError(null);
    await Promise.allSettled(pending.map((b) => cancelBooking(b.id)));
    setBusy(false);
    navigate("/events");
  }

  if (ids.length === 0) {
    return <p className="max-w-3xl mx-auto px-6 py-10 text-sm text-text-dim">No bookings to review.</p>;
  }

  if (!bookings) {
    return <p className="max-w-3xl mx-auto px-6 py-10 text-sm text-text-dim">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h2 className="text-lg font-bold mb-1">Review your booking</h2>
      <p className="text-sm text-text-dim mb-6">{bookings.length} seats in this order</p>

      {warning && <p className="text-sm text-danger mb-4">{warning}</p>}
      {error && <p className="text-sm text-danger mb-4">{error}</p>}

      <div className="border border-line rounded-xl overflow-hidden mb-6">
        {bookings.map((b) => (
          <div key={b.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3 border-b border-line last:border-b-0">
            <span className="font-mono text-sm">Seat #{b.seatId}</span>
            <StatusPill status={b.status} />
            <Countdown target={b.status === "pending" ? b.holdExpiresAt : null} />
          </div>
        ))}
      </div>

      {pending.length > 0 ? (
        <div className="flex gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={handleConfirmAll}
            className="bg-accent text-accent-ink font-semibold text-sm rounded-lg px-5 py-2.5 disabled:opacity-50"
          >
            Confirm {pending.length > 1 ? `all ${pending.length}` : "booking"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleReleaseAll}
            className="border border-line-strong font-semibold text-sm rounded-lg px-5 py-2.5 disabled:opacity-50"
          >
            Release {pending.length > 1 ? "all" : "seat"}
          </button>
        </div>
      ) : (
        <p className="text-sm text-text-dim">Nothing left pending on this order.</p>
      )}
    </div>
  );
}
