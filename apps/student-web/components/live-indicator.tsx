import type { RealtimeStatus } from "@campuscart/client";

export function LiveIndicator({ status }: { status: RealtimeStatus }) {
  const label = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" }[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted" role="status">
      <span
        className={`size-2 rounded-full ${status === "live" ? "bg-ok" : "animate-pulse bg-warn"}`}
        aria-hidden
      />
      {label}
    </span>
  );
}
