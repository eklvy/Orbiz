"use client";

import { formatPaise, queryKeys } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, InlineError, Skeleton } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useLoyalty } from "@/lib/hooks";

const TIER = { silver: "Silver", gold: "Gold", platinum: "Platinum" } as const;
const REASON = {
  order_paid: "Order",
  order_refunded: "Refunded order",
  topup_bonus: "Top-up bonus",
  review: "Review",
  voucher_redeemed: "Voucher",
} as const;

export default function RewardsPage() {
  const auth = useRequireAuth();
  const queryClient = useQueryClient();
  const loyalty = useLoyalty();
  const redeem = useMutation({
    mutationFn: () => getApi().redeemVoucher(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.loyalty }),
  });
  if (!auth.ready || loyalty.isPending) return <Skeleton className="h-64" />;
  if (loyalty.isError)
    return <ErrorState error={loyalty.error} onRetry={() => void loyalty.refetch()} />;
  const l = loyalty.data;
  const r = l.rules;
  const nextAt = l.next_tier
    ? { gold: r.tier_gold, platinum: r.tier_platinum, silver: 0 }[l.next_tier]
    : null;

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Rewards</h1>
      <section className="grid gap-3 rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-4xl font-black tracking-tight" data-testid="points-balance">
            {l.balance_points} <span className="text-base font-medium text-muted">points</span>
          </p>
          <Badge tone="progress">{TIER[l.tier]} tier</Badge>
        </div>
        {nextAt !== null && l.points_to_next_tier !== null && l.next_tier && (
          <div>
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-label={`Progress to ${TIER[l.next_tier]}`}
              aria-valuemin={0}
              aria-valuemax={nextAt}
              aria-valuenow={l.lifetime_points}
            >
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.min(100, (l.lifetime_points / nextAt) * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-sm text-muted">
              {l.points_to_next_tier} more lifetime points to {TIER[l.next_tier]}.
            </p>
          </div>
        )}
        <Button
          onClick={() => redeem.mutate()}
          busy={redeem.isPending}
          disabled={l.balance_points < r.voucher_cost_points}
          className="justify-self-start"
        >
          Get a {formatPaise(r.voucher_value_paise)} voucher for {r.voucher_cost_points} points
        </Button>
        <InlineError error={redeem.error} />
      </section>

      <section aria-labelledby="vouchers-heading" className="grid gap-2">
        <h2 id="vouchers-heading" className="font-semibold">
          Your vouchers
        </h2>
        {l.vouchers.length === 0 ? (
          <EmptyState title="No vouchers yet" />
        ) : (
          <ul className="grid gap-2">
            {l.vouchers.map((v) => (
              <li
                key={v.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3"
              >
                <span
                  className="font-mono text-lg font-bold tracking-wider"
                  data-testid="voucher-code"
                >
                  {v.code}
                </span>
                <span className="text-sm text-muted">
                  {formatPaise(v.value_paise)} ·{" "}
                  {v.status === "available"
                    ? `use by ${new Date(v.expires_at).toLocaleDateString("en-IN")}`
                    : v.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="rules-heading" className="grid gap-2 text-sm">
        <h2 id="rules-heading" className="font-semibold">
          How points work
        </h2>
        <ul className="list-disc pl-5 text-muted">
          <li>
            {r.points_per_10_rupees} point for every ₹10 you pay for an order (taken back if
            it&apos;s refunded).
          </li>
          <li>
            {r.topup_bonus_points} points for a single wallet top-up of{" "}
            {formatPaise(r.topup_bonus_min_paise)} or more.
          </li>
          <li>{r.review_points} points for reviewing an order.</li>
          <li>
            Tiers by lifetime points: Silver, Gold from {r.tier_gold}, Platinum from{" "}
            {r.tier_platinum}.
          </li>
        </ul>
      </section>

      <section aria-labelledby="activity-heading" className="grid gap-2">
        <h2 id="activity-heading" className="font-semibold">
          Recent points
        </h2>
        {l.entries.length === 0 ? (
          <EmptyState title="No points yet">Order, review or top up to earn some.</EmptyState>
        ) : (
          <ul className="grid gap-1 text-sm">
            {l.entries.map((e) => (
              <li key={e.id} className="flex justify-between rounded-lg bg-surface px-3 py-2">
                <span>{REASON[e.reason]}</span>
                <span className={e.points > 0 ? "font-semibold text-ok" : "font-semibold"}>
                  {e.points > 0 ? "+" : ""}
                  {e.points}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
