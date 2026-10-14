"use client";

import { formatCountdown } from "@campuscart/client";
import { useEffect, useState } from "react";

export function Countdown({ until, onElapsed }: { until: string; onElapsed?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const remaining = new Date(until).getTime() - now;
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (remaining <= 0) onElapsed?.();
  }, [remaining <= 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <time dateTime={until} className="font-mono font-bold tabular-nums">
      {formatCountdown(remaining)}
    </time>
  );
}
