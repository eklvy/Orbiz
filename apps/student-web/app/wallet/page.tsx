"use client";

import { formatPaise, parseRupeesToPaise, queryKeys, type Schemas } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { EmptyState, ErrorState, InlineError, Skeleton } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { usePaymentsConfig, useWallet } from "@/lib/hooks";
import { payOnline } from "@/lib/razorpay";

const QUICK = [10000, 20000, 50000, 99900];
const KIND: Record<Schemas["WalletEntry"]["kind"], string> = {
  topup: "Top-up",
  order_payment: "Paid",
  refund: "Refund",
  transfer_out: "Sent",
  transfer_in: "Received",
  adjustment: "Adjustment",
};

export default function WalletPage() {
  const auth = useRequireAuth();
  const queryClient = useQueryClient();
  const wallet = useWallet();
  const config = usePaymentsConfig();
  const [amount, setAmount] = useState("200");
  const [error, setError] = useState<string>();
  const topUp = useMutation({
    mutationFn: async (paise: number) => {
      const checkout = await getApi().startCheckout({
        purpose: "wallet_topup",
        amount_paise: paise,
      });
      return payOnline(checkout, "Wallet top-up");
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.wallet }),
  });

  if (!auth.ready || wallet.isPending) return <Skeleton className="h-64" />;
  if (wallet.isError)
    return <ErrorState error={wallet.error} onRetry={() => void wallet.refetch()} />;
  const w = wallet.data;

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <h1 className="text-2xl font-bold tracking-tight">CampusCart wallet</h1>
      <section className="rounded-2xl bg-primary p-6 text-primary-ink">
        <p className="text-sm opacity-90">Balance</p>
        <p className="text-4xl font-black tracking-tight" data-testid="wallet-balance">
          {formatPaise(w.balance_paise)}
        </p>
        <p className="mt-2 text-sm opacity-90">
          One-tap payments for orders and group shares. Refunds land here automatically.
        </p>
      </section>

      <section
        aria-labelledby="topup-heading"
        className="grid gap-3 rounded-2xl border border-line bg-surface p-5"
      >
        <h2 id="topup-heading" className="font-semibold">
          Top up
        </h2>
        {config.data && !config.data.razorpay_enabled ? (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            Online top-up isn&apos;t set up on this server yet, so the wallet can&apos;t be loaded
            here. Refunds still arrive in it.
          </p>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const paise = parseRupeesToPaise(amount);
              if (paise === null || paise < 5000 || paise > 500000) {
                setError("Top up between ₹50 and ₹5,000");
                return;
              }
              setError(undefined);
              topUp.mutate(paise);
            }}
          >
            <div className="flex flex-wrap gap-2">
              {QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setAmount(String(q / 100))}
                  className="rounded-full border border-line px-3 py-1 text-sm hover:bg-surface-2"
                >
                  {formatPaise(q)}
                </button>
              ))}
            </div>
            <Field
              label="Amount (₹)"
              inputMode="decimal"
              value={amount}
              error={error}
              onChange={(e) => setAmount(e.target.value)}
            />
            <p className="text-xs text-muted">
              A single top-up of ₹999 or more earns 50 loyalty points.
            </p>
            <InlineError error={topUp.error} />
            {topUp.data && (
              <p role="status" className="text-sm text-ok">
                {topUp.data.outcome === "wallet_credited"
                  ? "Wallet topped up."
                  : "Payment recorded."}
              </p>
            )}
            <Button type="submit" busy={topUp.isPending} className="justify-self-start">
              Top up with UPI / card
            </Button>
          </form>
        )}
      </section>

      <section aria-labelledby="history-heading" className="grid gap-2">
        <h2 id="history-heading" className="font-semibold">
          Activity
        </h2>
        {w.entries.length === 0 ? (
          <EmptyState title="No wallet activity yet" />
        ) : (
          <ul className="grid gap-2">
            {w.entries.map((e) => (
              <li
                key={e.id}
                className="flex justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm"
              >
                <span>
                  <span className="font-medium">{KIND[e.kind]}</span>
                  {e.note && <span className="block text-muted">{e.note}</span>}
                  <span className="block text-xs text-muted">
                    {new Date(e.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                  </span>
                </span>
                <span className={`font-semibold ${e.amount_paise > 0 ? "text-ok" : ""}`}>
                  {e.amount_paise > 0 ? "+" : "−"}
                  {formatPaise(Math.abs(e.amount_paise))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
