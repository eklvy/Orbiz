"use client";

import { LiveIndicator } from "@/components/live-indicator";
import { OutletCard } from "@/components/outlet-card";
import { EmptyState, ErrorState, LoadingList } from "@/components/ui/states";
import { useOutlets } from "@/lib/hooks";

export default function HomePage() {
  const outlets = useOutlets();
  return (
    <div className="grid gap-6">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">Skip the queue.</h1>
        <p className="mt-1 max-w-prose text-muted">
          Order before you leave class, pick a pickup time, and collect with your token.
        </p>
      </section>
      <section aria-labelledby="outlets-heading" className="grid gap-3">
        <div className="flex items-center justify-between">
          <h2 id="outlets-heading" className="text-lg font-semibold">
            Outlets
          </h2>
          <LiveIndicator status={outlets.live} />
        </div>
        {outlets.isPending ? (
          <LoadingList label="Loading outlets" />
        ) : outlets.isError ? (
          <ErrorState error={outlets.error} onRetry={() => void outlets.refetch()} />
        ) : outlets.data.length === 0 ? (
          <EmptyState title="No outlets are listed yet">Check back soon.</EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {outlets.data.map((outlet) => (
              <OutletCard key={outlet.id} outlet={outlet} />
            ))}
          </div>
        )}
        <p className="text-xs text-muted">
          Wait times and crowd levels are estimated from current orders, not from cameras or
          sensors.
        </p>
      </section>
    </div>
  );
}
