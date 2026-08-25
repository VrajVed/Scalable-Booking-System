const STYLES: Record<string, string> = {
  available: "bg-accent2-bg text-accent2",
  confirmed: "bg-accent2-bg text-accent2",
  pending: "bg-surface-2 text-text-dim",
  held: "bg-surface-2 text-text-dim",
  cancelled: "bg-danger-bg text-danger",
  expired: "bg-danger-bg text-danger",
  booked: "bg-surface-2 text-text-dim",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`font-mono text-[11px] font-semibold tracking-wide px-2.5 py-1 rounded-full ${
        STYLES[status] ?? "bg-surface-2 text-text-dim"
      }`}
    >
      {status}
    </span>
  );
}
