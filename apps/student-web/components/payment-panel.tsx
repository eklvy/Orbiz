"use client";

import { formatPaise, queryKeys, type Schemas } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { getApi } from "@/lib/api";
import { usePaymentsConfig, useWallet } from "@/lib/hooks";
import { payOnline } from "@/lib/razorpay";
import { Countdown } from "./countdown";
import { Button } from "./ui/button";
import { InlineError } from "./ui/states";

/**
 * Paying an unpaid order: from the CampusCart wallet (one tap), or online through Razorpay when the
 * server has it set up. Vouchers can be applied first. The server sets every amount.
 */
export function PaymentPanel({
  order,
  onExpired,
}: {
  order: Schemas["OrderDetail"];
  onExpired: () => void;
}) {
  const queryClient = useQueryClient();
  const wallet = useWallet();
  const config = usePaymentsConfig();
  const voucherId = useId();
  const [code, setCode] = useState("");
  const refresh = (updated?: Schemas["OrderDetail"]) => {
    if (updated) queryClient.setQueryData(queryKeys.order(order.id), updated);
    else void queryClient.invalidateQueries({ queryKey: queryKeys.order(order.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
  };
  const payWallet = useMutation({
    mutationFn: () => getApi().payWithWallet(order.id),
    onSuccess: refresh,
  });
  const payCard = useMutation({
    mutationFn: async () => {
      const checkout = await getApi().startCheckout({ purpose: "order", order_id: order.id });
      return payOnline(checkout, `Order at ${order.outlet.name}`);
    },
    onSuccess: () => refresh(),
  });
  const voucher = useMutation({
    mutationFn: () => getApi().applyVoucher(order.id, code.trim()),
    onSuccess: (updated) => {
      setCode("");
      refresh(updated);
    },
  });

  if (order.group_session_id) {
    return (
      <section
        className="rounded-2xl border border-warn/40 bg-warn-soft p-5 text-warn"
        aria-label="Payment"
      >
        <p className="font-semibold">Group order: each member pays their own share.</p>
        <Link
          href={`/groups/${order.group_session_id}`}
          className="mt-2 inline-block font-medium underline"
        >
          Open the group order
        </Link>
      </section>
    );
  }

  const balance = wallet.data?.balance_paise ?? 0;
  const enough = balance >= order.total_paise;
  return (
    <section
      className="grid gap-4 rounded-2xl border border-warn/40 bg-warn-soft p-5 text-warn"
      aria-label="Payment"
    >
      <p className="font-semibold">
        Awaiting payment — {order.pickup_slot ? "items and slot" : "deal"} held for{" "}
        {order.reservation_expires_at && (
          <Countdown until={order.reservation_expires_at} onElapsed={onExpired} />
        )}
      </p>
      <div className="grid gap-2 rounded-xl bg-surface p-4 text-ink">
        {order.discount_paise > 0 && (
          <p className="flex justify-between text-sm">
            <span>Voucher</span>
            <span>−{formatPaise(order.discount_paise)}</span>
          </p>
        )}
        <p className="flex justify-between font-semibold">
          <span>To pay</span>
          <span data-testid="amount-due">{formatPaise(order.total_paise)}</span>
        </p>
        <p className="text-sm text-muted" data-testid="wallet-balance">
          Wallet balance: {formatPaise(balance)}
          {!enough && (
            <>
              {" · "}
              <Link href="/wallet" className="font-medium text-primary underline">
                Top up
              </Link>
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            busy={payWallet.isPending}
            disabled={!enough || payCard.isPending}
            onClick={() => payWallet.mutate()}
          >
            Pay {formatPaise(order.total_paise)} from wallet
          </Button>
          {config.data?.razorpay_enabled ? (
            <Button
              variant="secondary"
              busy={payCard.isPending}
              disabled={payWallet.isPending}
              onClick={() => payCard.mutate()}
            >
              Pay online (UPI / card)
            </Button>
          ) : (
            config.data && (
              <p className="self-center text-xs text-muted">
                Online payment isn&apos;t set up on this server yet.
              </p>
            )
          )}
        </div>
        <InlineError error={payWallet.error ?? payCard.error} />
      </div>
      {!order.discount_paise && (
        <form
          className="flex flex-wrap items-end gap-2 text-ink"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) voucher.mutate();
          }}
        >
          <div className="grid gap-1">
            <label htmlFor={voucherId} className="text-sm font-medium text-warn">
              Have a voucher?
            </label>
            <input
              id={voucherId}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="CC-XXXXXXXX"
              maxLength={20}
              className="h-10 w-44 rounded-lg border border-line bg-surface px-3 font-mono uppercase"
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            className="h-10"
            busy={voucher.isPending}
          >
            Apply
          </Button>
          <div className="basis-full">
            <InlineError error={voucher.error} />
          </div>
        </form>
      )}
    </section>
  );
}
