import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listBookings, ApiError } from "../lib/api";
import type { Booking } from "../lib/types";
import { StatusPill } from "../components/StatusPill";

export function BookingsListPage() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listBookings()
      .then(setBookings)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load your bookings."));
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h2 className="text-lg font-bold mb-4">My bookings</h2>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!bookings && !error && <p className="text-sm text-text-dim">Loading…</p>}
      {bookings && bookings.length === 0 && (
        <p className="text-sm text-text-dim">
          No bookings yet.{" "}
          <Link to="/events" className="text-accent font-semibold">
            Browse events
          </Link>
        </p>
      )}
      <div className="flex flex-col">
        {bookings?.map((b) => (
          <div key={b.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-3.5 border-b border-line last:border-b-0">
            <div>
              <div className="font-bold text-sm">Seat #{b.seatId}</div>
              <div className="text-xs text-text-dim mt-0.5">Booked {new Date(b.createdAt).toLocaleDateString()}</div>
            </div>
            <StatusPill status={b.status} />
            <Link to={`/bookings/${b.id}`} className="text-sm font-semibold border border-line-strong rounded-lg px-3.5 py-1.5">
              View
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
