import { useEffect, useState } from "react";

export function useCountdown(target: string | null) {
  const [remainingMs, setRemainingMs] = useState<number | null>(
    target ? new Date(target).getTime() - Date.now() : null,
  );

  useEffect(() => {
    if (!target) {
      setRemainingMs(null);
      return;
    }
    const targetMs = new Date(target).getTime();
    const tick = () => setRemainingMs(targetMs - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);

  if (remainingMs === null) return null;
  const clamped = Math.max(0, remainingMs);
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return { expired: clamped === 0, label: `${minutes}:${seconds.toString().padStart(2, "0")}` };
}
