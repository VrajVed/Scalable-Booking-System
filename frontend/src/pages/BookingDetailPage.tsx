import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { cancelBooking, confirmBooking, getBooking, ApiError } from "../lib/api";
import { useCountdown } from "../lib/useCountdown";
import type { Booking } from "../lib/types";
import { StatusPill } from "../components/StatusPill";

export function BookingDetailPage() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const countdown = useCountdown(booking?.holdExpiresAt ?? null);

  function load() {
    getBooking(Number(bookingId))
      .then(setBooking)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          navigate("/404", { replace: true });
          return;
        }
        setError("Couldn't load this booking.");
      });
  }

  useEffect(load, [bookingId, navigate]);

  async function handleConfirm() {
    if (!booking) return;
    setBusy(true);
    try {
      await confirmBooking(booking.id);
      navigate(`/bookings/${booking.id}/ticket`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm this booking.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!booking) return;
    setBusy(true);
    try {
      const updated = await cancelBooking(booking.id);
      setBooking(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't cancel this booking.");
    } finally {
      setBusy(false);
    }
  }

  if (!booking) {
    return <p className="max-w-lg mx-auto px-6 py-10 text-sm text-text-dim">{error ?? "Loading…"}</p>;
  }

  const actionable = booking.status === "pending" || booking.status === "confirmed";

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <div className="border border-line rounded-2xl p-5">
        <div className="flex justify-between items-baseline mb-3.5">
          <h3 className="text-lg">Seat #{booking.seatId}</h3>
          <StatusPill status={booking.status} />
        </div>
        <div className="flex flex-col">
          <div className="flex justify-between py-2.5 border-b border-line text-sm">
            <span className="text-text-dim">Booked</span>
            <span>{new Date(booking.createdAt).toLocaleString()}</span>
          </div>
          {countdown && booking.status === "pending" && (
            <div className="flex justify-between py-2.5 border-b border-line text-sm">
              <span className="text-text-dim">Hold expires</span>
              <span>{countdown.expired ? "expired" : `${countdown.label} remaining`}</span>
            </div>
          )}
          <div className="flex justify-between py-2.5 text-sm">
            <span className="text-text-dim">Last updated</span>
            <span>{new Date(booking.updatedAt).toLocaleString()}</span>
          </div>
        </div>
        {error && <p className="text-sm text-danger mt-3.5">{error}</p>}
        {actionable && (
          <div className="flex gap-2.5 mt-4.5">
            {booking.status === "pending" && (
              <button
                type="button"
                disabled={busy}
                onClick={handleConfirm}
                className="bg-accent text-accent-ink font-semibold text-sm rounded-lg px-4 py-2.5 disabled:opacity-50"
              >
                Confirm booking
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={handleCancel}
              className="border border-danger text-danger font-semibold text-sm rounded-lg px-4 py-2.5 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
