import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getBooking } from "../lib/api";
import type { Booking } from "../lib/types";

function bookingRef(id: number) {
  return `FS-${id.toString().padStart(4, "0")}`;
}

export function TicketPage() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const [booking, setBooking] = useState<Booking | null>(null);

  useEffect(() => {
    getBooking(Number(bookingId)).then((b) => {
      if (b.status !== "confirmed") {
        navigate(`/bookings/${b.id}`, { replace: true });
        return;
      }
      setBooking(b);
    });
  }, [bookingId, navigate]);

  if (!booking) {
    return <p className="max-w-lg mx-auto px-6 py-10 text-sm text-text-dim">Loading…</p>;
  }

  const ref = bookingRef(booking.id);

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <div className="grid grid-cols-[1fr_150px] border border-line rounded-2xl overflow-hidden">
        <div className="p-6">
          <div className="flex items-center gap-1.5 text-accent2 text-xs font-bold mb-2.5">✓ Booking confirmed</div>
          <h3 className="text-lg">Seat #{booking.seatId}</h3>
          <div className="text-xs text-text-dim mt-1">Booked {new Date(booking.createdAt).toLocaleString()}</div>
          <div className="grid grid-cols-2 gap-2.5 mt-5">
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-text-dim">Booking ref</div>
              <div className="font-mono text-sm mt-0.5">{ref}</div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-text-dim">Seat</div>
              <div className="font-mono text-sm mt-0.5">#{booking.seatId}</div>
            </div>
          </div>
        </div>
        <div className="bg-surface-2 flex flex-col items-center justify-center gap-2.5 border-l border-dashed border-line-strong p-4">
          <div
            className="w-[84px] h-[84px] rounded-lg"
            style={{
              backgroundImage: `repeating-conic-gradient(var(--color-ink) 0% 25%, var(--color-surface) 0% 50%)`,
              backgroundSize: "12px 12px",
            }}
          />
          <div className="font-mono text-[10.5px] text-text-dim">{ref}</div>
        </div>
      </div>
      <Link to="/bookings" className="block text-center text-sm text-text-dim hover:text-text mt-6">
        Back to my bookings
      </Link>
    </div>
  );
}
