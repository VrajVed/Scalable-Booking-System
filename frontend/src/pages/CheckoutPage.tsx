import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { cancelBooking, confirmBooking, getBooking, ApiError } from "../lib/api";
import { useCountdown } from "../lib/useCountdown";
import type { Booking } from "../lib/types";
import { StatusPill } from "../components/StatusPill";

export function CheckoutPage() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const countdown = useCountdown(booking?.holdExpiresAt ?? null);

  useEffect(() => {
    getBooking(Number(bookingId))
      .then(setBooking)
      .catch(() => setError("Couldn't load this booking."));
  }, [bookingId]);

  async function handleConfirm() {
    if (!booking) return;
    setBusy(true);
    setError(null);
    try {
      await confirmBooking(booking.id);
      navigate(`/bookings/${booking.id}/ticket`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm this booking.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRelease() {
    if (!booking) return;
    setBusy(true);
    setError(null);
    try {
      await cancelBooking(booking.id);
      navigate("/events");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't release this seat.");
    } finally {
      setBusy(false);
    }
  }

  if (!booking) {
    return <p className="max-w-3xl mx-auto px-6 py-10 text-sm text-text-dim">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="grid md:grid-cols-[1fr_300px] gap-8">
        <div>
          <h2 className="text-lg font-bold mb-4">Review your booking</h2>
          <div className="flex justify-between py-3 border-b border-line text-sm">
            <span className="text-text-dim">Seat</span>
            <span className="font-mono">#{booking.seatId}</span>
          </div>
          <div className="flex justify-between py-3 border-b border-line text-sm">
            <span className="text-text-dim">Status</span>
            <StatusPill status={booking.status} />
          </div>
          <div className="flex justify-between py-3 text-sm">
            <span className="text-text-dim">Hold expires</span>
            {countdown ? (
              <span className={`font-mono px-2.5 py-1 rounded-full text-[11px] ${countdown.expired ? "bg-danger-bg text-danger" : "bg-surface-2 text-text-dim"}`}>
                {countdown.expired ? "expired" : `${countdown.label} remaining`}
              </span>
            ) : (
              <span className="text-text-dim">—</span>
            )}
          </div>
        </div>
        <div className="border border-line rounded-xl p-5 h-fit">
          {error && <p className="text-sm text-danger mb-3">{error}</p>}
          <button
            type="button"
            disabled={busy || booking.status !== "pending"}
            onClick={handleConfirm}
            className="w-full justify-center bg-accent text-accent-ink font-semibold text-sm rounded-lg py-2.5 disabled:opacity-50"
          >
            Confirm booking
          </button>
          <button
            type="button"
            disabled={busy || booking.status !== "pending"}
            onClick={handleRelease}
            className="w-full justify-center border border-line-strong text-sm font-semibold rounded-lg py-2.5 mt-2 disabled:opacity-50"
          >
            Release seat
          </button>
        </div>
      </div>
    </div>
  );
}
