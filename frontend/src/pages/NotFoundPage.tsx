import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="max-w-lg mx-auto px-6 py-20 text-center">
      <div className="font-mono text-6xl font-semibold text-accent tracking-tight">404</div>
      <p className="text-text-dim my-4">This seat doesn't exist. The event may have ended or the link's wrong.</p>
      <Link to="/events" className="inline-block bg-accent text-accent-ink font-semibold text-sm rounded-lg px-5 py-2.5">
        Back to events
      </Link>
    </div>
  );
}
