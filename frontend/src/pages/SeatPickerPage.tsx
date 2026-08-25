import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { listSeatsForEvent, reserveSeat, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Seat } from "../lib/types";

// A real venue's full seat map can run into the thousands (and this
// project's seed data has one load-test event with ~400k rows) -- render
// only a bounded page rather than dumping every seat into the DOM.
const SEAT_PAGE_SIZE = 240;

export function SeatPickerPage() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Seat | null>(null);
  const [reserving, setReserving] = useState(false);

  useEffect(() => {
    listSeatsForEvent(Number(eventId), undefined, SEAT_PAGE_SIZE)
      .then(setSeats)
      .catch(() => setError("Couldn't load the seat map right now."));
  }, [eventId]);

  const rows = useMemo(() => {
    if (!seats) return [];
    const bySection = new Map<string, Map<string, Seat[]>>();
    for (const seat of seats) {
      if (!bySection.has(seat.section)) bySection.set(seat.section, new Map());
      const byRow = bySection.get(seat.section)!;
      if (!byRow.has(seat.rowLabel)) byRow.set(seat.rowLabel, []);
      byRow.get(seat.rowLabel)!.push(seat);
    }
    return [...bySection.entries()].flatMap(([, byRow]) =>
      [...byRow.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
  }, [seats]);

  async function handleReserve() {
    if (!selected) return;
    if (!user) {
      navigate("/login", { state: { from: { pathname: `/events/${eventId}/seats` } } });
      return;
    }
    setReserving(true);
    setError(null);
    try {
      const booking = await reserveSeat(selected.id);
      navigate(`/bookings/${booking.id}/review`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reserve that seat.");
      setSelected(null);
      listSeatsForEvent(Number(eventId), undefined, SEAT_PAGE_SIZE).then(setSeats);
    } finally {
      setReserving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex gap-5 mb-6 text-xs text-text-dim">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm inline-block bg-paper border border-accent2" /> Available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm inline-block bg-accent" /> Selected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm inline-block bg-surface-2 opacity-50" /> Held / booked
        </span>
      </div>

      <div className="text-center font-mono text-[11px] tracking-widest text-text-dim bg-surface-2 rounded-full py-2 mb-6">
        STAGE
      </div>

      {error && <p className="text-sm text-danger text-center mb-4">{error}</p>}
      {!seats && !error && <p className="text-sm text-text-dim text-center">Loading…</p>}
      {seats && seats.length === SEAT_PAGE_SIZE && (
        <p className="text-xs text-text-dim text-center mb-4">
          Showing the first {SEAT_PAGE_SIZE} seats — this event has more.
        </p>
      )}

      <div className="flex flex-col gap-2 items-center mb-8">
        {rows.map(([rowLabel, rowSeats]) => (
          <div key={rowLabel} className="flex gap-1.5 items-center">
            <span className="w-4 text-right font-mono text-[11px] text-text-dim mr-1">{rowLabel}</span>
            {rowSeats
              .sort((a, b) => a.seatNumber - b.seatNumber)
              .map((seat) => {
                const isSelected = selected?.id === seat.id;
                const isAvailable = seat.status === "available";
                return (
                  <button
                    key={seat.id}
                    type="button"
                    disabled={!isAvailable}
                    title={`${seat.section} ${seat.rowLabel}${seat.seatNumber}`}
                    onClick={() => setSelected(isSelected ? null : seat)}
                    className={`w-[22px] h-[22px] rounded-[5px] border ${
                      isSelected
                        ? "bg-accent border-accent"
                        : isAvailable
                          ? "bg-paper border-accent2"
                          : "bg-surface-2 border-line opacity-50 cursor-not-allowed"
                    }`}
                  />
                );
              })}
          </div>
        ))}
      </div>

      <div className="flex justify-between items-center border border-line rounded-xl px-5 py-4 max-w-md mx-auto">
        <div>
          <div className="text-xs text-text-dim mb-1.5">Selected</div>
          {selected ? (
            <span className="bg-accent text-accent-ink text-xs font-bold px-2 py-1 rounded-md font-mono">
              {selected.section} {selected.rowLabel}
              {selected.seatNumber}
            </span>
          ) : (
            <span className="text-sm text-text-dim">No seat picked yet</span>
          )}
        </div>
        <button
          type="button"
          disabled={!selected || reserving}
          onClick={handleReserve}
          className="bg-accent text-accent-ink font-semibold text-sm rounded-lg px-5 py-2.5 disabled:opacity-50"
        >
          {reserving ? "Reserving…" : "Reserve seat"}
        </button>
      </div>
    </div>
  );
}
