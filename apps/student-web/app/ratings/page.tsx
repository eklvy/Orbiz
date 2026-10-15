"use client";

import { queryKeys } from "@campuscart/client";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingList } from "@/components/ui/states";
import { getApi } from "@/lib/api";

/** Campus feed leaderboard: outlets ranked by real, anonymous student reviews. */
export default function RatingsPage() {
  const ratings = useQuery({ queryKey: queryKeys.ratings, queryFn: () => getApi().ratings() });
  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Outlet ratings</h1>
      <p className="text-sm text-muted">
        Averages of students&apos; reviews (taste, hygiene, pickup speed and value, 1–5).
      </p>
      {ratings.isPending ? (
        <LoadingList label="Loading ratings" />
      ) : ratings.isError ? (
        <ErrorState error={ratings.error} onRetry={() => void ratings.refetch()} />
      ) : ratings.data.length === 0 ? (
        <EmptyState title="No reviews yet">
          Ratings appear once students review their orders.
        </EmptyState>
      ) : (
        <ol className="grid gap-2">
          {ratings.data.map((r, i) => (
            <li
              key={r.outlet_id}
              id={r.outlet_id}
              className="grid gap-1 rounded-xl border border-line bg-surface p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-semibold">
                  {i + 1}. {r.outlet_name}
                </p>
                <p className="text-2xl font-black text-primary">{r.overall.toFixed(1)}</p>
              </div>
              <p className="text-sm text-muted">
                Taste {r.taste.toFixed(1)} · Hygiene {r.hygiene.toFixed(1)} · Speed{" "}
                {r.speed.toFixed(1)} · Value {r.value.toFixed(1)} · {r.review_count} review
                {r.review_count === 1 ? "" : "s"}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
