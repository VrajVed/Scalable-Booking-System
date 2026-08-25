import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listEvents, listSeatsForEvent } from "../lib/api";
import type { EventSummary } from "../lib/types";

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EventDetailPage() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState<EventSummary | null | undefined>(undefined);
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    const id = Number(eventId);
    listEvents().then((all) => {
      setEvent(all.find((e) => e.id === id) ?? null);
    });
    const SEAT_COUNT_CAP = 500;
    listSeatsForEvent(id, "available", SEAT_COUNT_CAP)
      .then((seats) => setAvailable(seats.length === SEAT_COUNT_CAP ? -1 : seats.length))
      .catch(() => setAvailable(null));
  }, [eventId]);

  if (event === null) {
    navigate("/404", { replace: true });
    return null;
  }

  if (event === undefined) {
    return <p className="max-w-5xl mx-auto px-6 py-10 text-sm text-text-dim">Loading…</p>;
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="grid md:grid-cols-[1fr_300px] gap-8">
        <div>
          <div
            className="aspect-[21/9] rounded-2xl bg-surface-2 mb-5"
            style={{
              backgroundImage: "repeating-linear-gradient(135deg, var(--color-line) 0 1px, transparent 1px 16px)",
            }}
          />
          <h1 className="text-2xl mb-1.5">{event.name}</h1>
          <div className="flex flex-wrap gap-3.5 text-sm text-text-dim">
            <span>{formatDateTime(event.startsAt)}</span>
            <span>
              {event.venueName}, {event.venueCity}
            </span>
            {available !== null && (
              <span className="font-mono text-[11px] font-semibold bg-accent2-bg text-accent2 px-2.5 py-1 rounded-full">
                {available === -1 ? "500+ seats left" : `${available} seats left`}
              </span>
            )}
          </div>
        </div>
        <div className="border border-line rounded-2xl p-5 h-fit">
          <div className="text-xs text-text-dim mb-1">Status</div>
          <div className="text-sm font-semibold capitalize mb-4">{event.status}</div>
          <Link
            to={`/events/${event.id}/seats`}
            className="block text-center bg-accent text-accent-ink font-semibold text-sm rounded-lg py-2.5"
          >
            Select seats
          </Link>
        </div>
      </div>
    </div>
  );
}
