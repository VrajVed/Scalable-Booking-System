import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { listSeatsForEvent, reserveSeat, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLiveSeats } from "../lib/useLiveSeats";
import type { Seat } from "../lib/types";

// A real venue's full seat map can run into the thousands (and this
// project's seed data has one load-test event with ~400k rows) -- render
// only a bounded page rather than dumping every seat into the DOM.
const SEAT_PAGE_SIZE = 240;

// The backend reserves one seat per call (POST /bookings/reserve takes a
// single seatId, not a set) -- there's no group-booking concept in the
// schema. A cap here keeps "reserve all selected" from firing an unbounded
// number of sequential requests if someone clicks fast.
const MAX_SELECTION = 8;

function seatLabel(seat: Seat) {
  return `${seat.section} ${seat.rowLabel}${seat.seatNumber}`;
}

function seatClasses(status: Seat["status"], isSelected: boolean) {
  if (isSelected) return "bg-accent border-accent";
  switch (status) {
    case "available":
      return "bg-paper border-accent2 hover:bg-accent2-bg hover:border-accent2 hover:scale-110 cursor-pointer";
    case "held":
      return "bg-surface-2 border-line-strong text-text-dim cursor-not-allowed";
    case "booked":
      return "bg-surface-2 border-line text-text-dim opacity-70 cursor-not-allowed";
  }
}

export function SeatPickerPage() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Seat[]>([]);
  const [reserving, setReserving] = useState(false);

  useEffect(() => {
    listSeatsForEvent(Number(eventId), undefined, SEAT_PAGE_SIZE)
      .then(setSeats)
      .catch(() => setError("Couldn't load the seat map right now."));
  }, [eventId]);

  // Live seat-status pushes off the CDC pipeline (see
  // backend/src/infrastructure/realtime/seat-broadcaster.ts) -- a seat
  // someone else reserves/releases updates here without a refetch. A seat
  // that just went unavailable out from under a pending local selection is
  // dropped from `selected` too, so the summary bar can't show a seat as
  // "selected" that the server would now reject.
  const handleLiveUpdate = useCallback((seatId: number, status: Seat["status"]) => {
    setSeats((prev) => (prev ? prev.map((s) => (s.id === seatId ? { ...s, status } : s)) : prev));
    if (status !== "available") {
      setSelected((prev) => prev.filter((s) => s.id !== seatId));
    }
  }, []);

  useLiveSeats(Number(eventId), handleLiveUpdate);

  const sections = useMemo(() => {
    if (!seats) return [];
    const bySection = new Map<string, Map<string, Seat[]>>();
    for (const seat of seats) {
      if (!bySection.has(seat.section)) bySection.set(seat.section, new Map());
      const byRow = bySection.get(seat.section)!;
      if (!byRow.has(seat.rowLabel)) byRow.set(seat.rowLabel, []);
      byRow.get(seat.rowLabel)!.push(seat);
    }
    return [...bySection.entries()].map(([section, byRow]) => ({
      section,
      rows: [...byRow.entries()].sort(([a], [b]) => a.localeCompare(b)),
    }));
  }, [seats]);

  function toggleSeat(seat: Seat) {
    if (seat.status !== "available") return;
    setSelected((prev) => {
      const isSelected = prev.some((s) => s.id === seat.id);
      if (isSelected) return prev.filter((s) => s.id !== seat.id);
      if (prev.length >= MAX_SELECTION) return prev;
      return [...prev, seat];
    });
  }

  async function handleReserve() {
    if (selected.length === 0) return;
    if (!user) {
      navigate("/login", { state: { from: { pathname: `/events/${eventId}/seats` } } });
      return;
    }
    setReserving(true);
    setError(null);

    // One booking per seat -- reserved sequentially (not Promise.all) so a
    // seat that loses the race to another buyer mid-batch doesn't abort
    // bookings already made for the other selected seats.
    const bookingIds: number[] = [];
    const failed: string[] = [];
    for (const seat of selected) {
      try {
        const booking = await reserveSeat(seat.id);
        bookingIds.push(booking.id);
      } catch (err) {
        failed.push(`${seatLabel(seat)} (${err instanceof ApiError ? err.message : "failed"})`);
      }
    }

    setReserving(false);

    if (bookingIds.length === 0) {
      setError(`Couldn't reserve any of the selected seats: ${failed.join(", ")}`);
      setSelected([]);
      listSeatsForEvent(Number(eventId), undefined, SEAT_PAGE_SIZE).then(setSeats);
      return;
    }

    if (failed.length > 0) {
      navigate(`/checkout?ids=${bookingIds.join(",")}`, {
        state: { warning: `Reserved ${bookingIds.length} of ${selected.length} — couldn't get: ${failed.join(", ")}` },
      });
      return;
    }

    navigate(bookingIds.length === 1 ? `/bookings/${bookingIds[0]}/review` : `/checkout?ids=${bookingIds.join(",")}`);
  }

  return (
    <div className="max-w-3xl mx-auto px-6 pt-10 pb-32">
      <div className="flex flex-wrap gap-5 mb-6 text-xs text-text-dim">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm inline-block bg-paper border border-accent2" /> Available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm inline-block bg-accent" /> Selected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm inline-block bg-surface-2 border border-line-strong" /> Held
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm inline-flex items-center justify-center bg-surface-2 border border-line text-text-dim text-[9px] leading-none opacity-70">
            ×
          </span>
          Booked
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

      <div className="flex flex-col items-center gap-8 mb-8">
        {sections.map(({ section, rows }) => (
          <div key={section} className="flex flex-col items-center gap-2">
            {sections.length > 1 && (
              <div className="text-[11px] font-semibold uppercase tracking-wide text-text-dim mb-1">
                Section {section}
              </div>
            )}
            {rows.map(([rowLabel, rowSeats]) => (
              <div key={rowLabel} className="flex gap-1.5 items-center">
                <span className="w-4 text-right font-mono text-[11px] text-text-dim mr-1">{rowLabel}</span>
                {rowSeats
                  .sort((a, b) => a.seatNumber - b.seatNumber)
                  .map((seat) => {
                    const isSelected = selected.some((s) => s.id === seat.id);
                    const isAvailable = seat.status === "available";
                    return (
                      <button
                        key={seat.id}
                        type="button"
                        disabled={!isAvailable}
                        title={`${seatLabel(seat)} — ${isSelected ? "selected" : seat.status}`}
                        aria-pressed={isSelected}
                        onClick={() => toggleSeat(seat)}
                        className={`w-[22px] h-[22px] rounded-[5px] border flex items-center justify-center text-[9px] leading-none font-bold transition-transform ${seatClasses(seat.status, isSelected)}`}
                      >
                        {seat.status === "booked" && !isSelected ? "×" : ""}
                      </button>
                    );
                  })}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="fixed bottom-0 left-0 right-0 border-t border-line bg-surface/95 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto flex justify-between items-center px-6 py-4">
          <div>
            <div className="text-xs text-text-dim mb-1.5">
              Selected {selected.length > 0 && `(${selected.length}/${MAX_SELECTION})`}
            </div>
            {selected.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {selected.map((seat) => (
                  <button
                    key={seat.id}
                    type="button"
                    onClick={() => toggleSeat(seat)}
                    title="Remove"
                    className="bg-accent text-accent-ink text-xs font-bold px-2 py-1 rounded-md font-mono hover:opacity-80"
                  >
                    {seat.rowLabel}
                    {seat.seatNumber} ✕
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-sm text-text-dim">Tap available seats to select them</span>
            )}
          </div>
          <button
            type="button"
            disabled={selected.length === 0 || reserving}
            onClick={handleReserve}
            className="bg-accent text-accent-ink font-semibold text-sm rounded-lg px-5 py-2.5 disabled:opacity-50 shrink-0"
          >
            {reserving ? "Reserving…" : `Reserve ${selected.length > 1 ? `${selected.length} seats` : "seat"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
