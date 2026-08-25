import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listEvents } from "../lib/api";
import type { EventSummary } from "../lib/types";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function HomePage() {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listEvents()
      .then((all) => setEvents(all.slice(0, 6)))
      .catch(() => setError("Couldn't load events right now."));
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="grid md:grid-cols-[1.1fr_0.9fr] gap-8 items-center mb-14">
        <div>
          <h1 className="text-4xl leading-tight mb-3">Tonight's stage is waiting.</h1>
          <p className="text-text-dim max-w-[38ch]">
            Find a seat before it's someone else's — live shows, real-time availability, held for a
            few minutes while you decide.
          </p>
          <Link
            to="/events"
            className="inline-block mt-6 bg-accent text-accent-ink font-semibold text-sm rounded-lg px-5 py-2.5"
          >
            Browse events
          </Link>
        </div>
        <div className="aspect-[4/3] rounded-2xl border border-line bg-surface-2 relative overflow-hidden">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: "repeating-linear-gradient(135deg, var(--color-line) 0 1px, transparent 1px 14px)",
            }}
          />
          <span className="absolute bottom-4 left-4 font-mono text-[11px] bg-accent text-accent-ink px-2.5 py-1 rounded-full">
            live tonight
          </span>
        </div>
      </div>

      <div className="text-xs uppercase tracking-wide text-text-dim font-semibold mb-3">Upcoming</div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!events && !error && <p className="text-sm text-text-dim">Loading…</p>}
      {events && events.length === 0 && <p className="text-sm text-text-dim">No events on sale right now.</p>}
      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
        {events?.map((ev) => (
          <Link
            key={ev.id}
            to={`/events/${ev.id}`}
            className="border border-line rounded-xl overflow-hidden bg-paper hover:border-line-strong"
          >
            <div
              className="aspect-[16/10] bg-surface-2"
              style={{
                backgroundImage: "repeating-linear-gradient(135deg, var(--color-line) 0 1px, transparent 1px 12px)",
              }}
            />
            <div className="p-3">
              <div className="font-bold text-sm">{ev.name}</div>
              <div className="text-xs text-text-dim mt-0.5">
                {ev.venueName} · {ev.venueCity}
              </div>
              <div className="text-xs text-text-dim mt-1.5">{formatDate(ev.startsAt)}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
