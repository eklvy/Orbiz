import type { Schemas } from "@campuscart/client";
import Link from "next/link";
import { Badge, type Tone } from "./ui/badge";

const CROWD: Record<Schemas["QueueStats"]["crowd_level"], { label: string; tone: Tone }> = {
  low: { label: "Quiet", tone: "success" },
  medium: { label: "Busy", tone: "warning" },
  high: { label: "Very busy", tone: "danger" },
};

export function OutletStatus({ outlet }: { outlet: Schemas["Outlet"] }) {
  if (outlet.accepting_orders) return <Badge tone="success">Open</Badge>;
  if (outlet.status === "on_break") return <Badge tone="warning">On a break</Badge>;
  return <Badge tone="neutral">Closed</Badge>;
}

export function OutletCard({ outlet }: { outlet: Schemas["Outlet"] }) {
  const crowd = CROWD[outlet.queue.crowd_level];
  return (
    <Link
      href={`/outlets/${outlet.slug}`}
      className="group flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold group-hover:text-primary">{outlet.name}</h2>
          {outlet.location && <p className="text-sm text-muted">{outlet.location}</p>}
        </div>
        <OutletStatus outlet={outlet} />
      </div>
      {!outlet.accepting_orders && outlet.status_reason && (
        <p className="text-sm text-muted">“{outlet.status_reason}”</p>
      )}
      <dl className="mt-auto flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="sr-only">Estimated wait</dt>
          <dd>
            <span className="font-semibold">~{outlet.queue.estimated_wait_minutes} min</span>{" "}
            <span className="text-muted">wait</span>
          </dd>
        </div>
        <div>
          <dt className="sr-only">Orders in queue</dt>
          <dd className="text-muted">{outlet.queue.active_orders} in queue</dd>
        </div>
        <div>
          <dt className="sr-only">Crowd</dt>
          <dd>
            <Badge tone={crowd.tone}>{crowd.label}</Badge>
          </dd>
        </div>
      </dl>
    </Link>
  );
}
