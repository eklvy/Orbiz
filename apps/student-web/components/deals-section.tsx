"use client";

import { formatPaise, formatTime, newIdempotencyKey, queryKeys } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDeals } from "@/lib/hooks";
import { Button } from "./ui/button";
import { InlineError } from "./ui/states";

/**
 * Freshly made food from orders that weren't collected, offered at a discount (D-19). Prices
 * come from the server. Buying creates an unpaid order that holds the deal, like checkout.
 */
export function DealsSection({
  outletId,
  slug,
  timeZone,
}: {
  outletId: string;
  slug: string;
  timeZone: string;
}) {
  const router = useRouter();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const deals = useDeals(outletId);
  // One key per deal, so a retried click can't create two orders.
  const [keys] = useState(() => new Map<string, string>());
  const claim = useMutation({
    mutationFn: (dealId: string) => {
      const key = keys.get(dealId) ?? newIdempotencyKey();
      keys.set(dealId, key);
      return getApi().claimDeal(dealId, key);
    },
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
      router.push(`/orders/${order.id}`);
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.deals(outletId) }),
  });

  if (!deals.data || deals.data.length === 0) return null;
  return (
    <section aria-labelledby="deals-heading" className="grid gap-3">
      <div>
        <h2 id="deals-heading" className="text-lg font-semibold">
          Ready now, at a discount
        </h2>
        <p className="text-sm text-muted">
          Freshly made food from orders that weren&apos;t collected. Pay and pick it up at the
          counter straight away.
        </p>
      </div>
      <InlineError error={claim.error} />
      <ul className="grid gap-3 md:grid-cols-2">
        {deals.data.map((deal) => (
          <li
            key={deal.id}
            className="grid gap-3 rounded-xl border-2 border-accent/40 bg-surface p-4"
            data-testid="deal"
          >
            <div className="flex items-start justify-between gap-3">
              <ul className="text-sm">
                {deal.items.map((item, i) => (
                  <li key={i} className="font-medium">
                    {item.quantity} × {item.item_name}
                  </li>
                ))}
              </ul>
              <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-white">
                {deal.discount_percent}% off
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>
                <span className="text-lg font-bold">{formatPaise(deal.price_paise)}</span>{" "}
                <s className="text-sm text-muted">{formatPaise(deal.original_price_paise)}</s>
                <span className="block text-xs text-muted">
                  Available until {formatTime(deal.expires_at, timeZone)}
                </span>
              </p>
              <Button
                size="sm"
                busy={claim.isPending && claim.variables === deal.id}
                disabled={claim.isPending}
                onClick={() =>
                  session ? claim.mutate(deal.id) : router.push(`/login?next=/outlets/${slug}`)
                }
                aria-label={`Buy deal: ${deal.items.map((i) => `${i.quantity} ${i.item_name}`).join(", ")}`}
              >
                Buy deal
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
