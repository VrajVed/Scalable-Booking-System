import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listEvents } from "../lib/api";
import type { EventSummary } from "../lib/types";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function CatalogPage() {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [city, setCity] = useState("all");

  useEffect(() => {
    listEvents()
      .then(setEvents)
      .catch(() => setError("Couldn't load events right now."));
  }, []);

  const cities = useMemo(() => {
    if (!events) return [];
    return Array.from(new Set(events.map((e) => e.venueCity))).sort();
  }, [events]);

  const filtered = useMemo(() => {
    if (!events) return [];
    return city === "all" ? events : events.filter((e) => e.venueCity === city);
  }, [events, city]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="flex items-center gap-3 mb-6">
        <h2 className="text-lg font-bold">All events</h2>
        <div className="flex-1" />
        <select
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className="border border-line-strong rounded-lg px-3 py-2 text-sm bg-paper"
        >
          <option value="all">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {!events && !error && <p className="text-sm text-text-dim">Loading…</p>}
      {events && filtered.length === 0 && (
        <p className="text-sm text-text-dim">No events{city !== "all" ? ` in ${city}` : ""} right now.</p>
      )}

      <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
        {filtered.map((ev) => (
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
              <div className="text-xs text-text-dim mt-0.5">{ev.venueCity}</div>
              <div className="text-xs text-text-dim mt-1.5">{formatDate(ev.startsAt)}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
