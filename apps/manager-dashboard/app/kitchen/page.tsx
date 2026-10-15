"use client";

import { DealsPanel, KitchenBoard, useCurrentOutlet } from "@campuscart/staff-web";

/** Oversight copy of the POS board (D-7): same live queue, same server state machine. */
export default function KitchenPage() {
  const { outlet } = useCurrentOutlet();
  return (
    <div className="grid gap-8">
      <h1 className="text-2xl font-bold tracking-tight">Kitchen queue</h1>
      <KitchenBoard key={outlet.id} outletId={outlet.id} timeZone={outlet.timezone} />
      <section aria-labelledby="deals-heading" className="grid gap-3">
        <h2 id="deals-heading" className="text-lg font-semibold">
          Uncollected orders &amp; deals
        </h2>
        <DealsPanel key={outlet.id} outletId={outlet.id} timeZone={outlet.timezone} />
      </section>
    </div>
  );
}
