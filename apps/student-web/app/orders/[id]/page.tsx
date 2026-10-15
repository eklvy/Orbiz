"use client";

import {
  canTransition,
  formatDayLabel,
  formatPaise,
  formatSlot,
  formatTime,
  orderEventLabel,
  orderStatusLabel,
  queryKeys,
} from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LiveIndicator } from "@/components/live-indicator";
import { OrderStatusBadge, OrderTimeline } from "@/components/order-status";
import { PaymentPanel } from "@/components/payment-panel";
import { PickupPass } from "@/components/pickup-pass";
import { RefundRequest } from "@/components/refund-request";
import { ReviewSection } from "@/components/review-form";
import { Button } from "@/components/ui/button";
import { ErrorState, InlineError, Skeleton } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useOrder, useOutlet, useTransitions } from "@/lib/hooks";

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const auth = useRequireAuth();
  const queryClient = useQueryClient();
  const order = useOrder(id);
  const outlet = useOutlet(order.data?.outlet.slug);
  const rules = useTransitions();
  const cancel = useMutation({
    mutationFn: () => getApi().cancelOrder(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.order(id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
    },
  });

  if (!auth.ready || order.isPending) return <Skeleton className="h-64" />;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;

  const o = order.data;
  const tz = outlet.data?.timezone ?? "Asia/Kolkata";
  const canCancel = rules.data ? canTransition(rules.data, o, "cancelled", "student") : false;

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/orders" className="hover:text-ink">
          Orders
        </Link>{" "}
        / <span aria-current="page">{o.token_label ?? "Order"}</span>
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{o.outlet.name}</h1>
          {o.pickup_slot ? (
            <p className="text-muted">
              Pickup {formatDayLabel(o.pickup_slot.starts_at, tz).toLowerCase()},{" "}
              {formatSlot(o.pickup_slot.starts_at, o.pickup_slot.ends_at, tz)}
            </p>
          ) : (
            <p className="text-muted">
              Surplus deal · pick up at the counter as soon as it&apos;s paid
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <OrderStatusBadge status={o.status} />
          <LiveIndicator status={order.live} />
        </div>
      </header>
      <p className="sr-only" aria-live="polite">
        Order status: {orderStatusLabel(o.status)}
      </p>

      {o.status === "payment_pending" && (
        <PaymentPanel order={o} onExpired={() => void order.refetch()} />
      )}

      <PickupPass order={o} />

      {o.status === "ready_for_pickup" && o.pickup_deadline && (
        <p className="rounded-xl bg-ok-soft px-4 py-3 text-ok" data-testid="pickup-deadline">
          Collect by <strong>{formatTime(o.pickup_deadline, tz)}</strong>. Orders not collected by
          then aren&apos;t refunded, and the food is offered to other students.
        </p>
      )}

      {o.status === "no_show" && (
        <section className="rounded-2xl bg-danger-soft p-5 text-danger" aria-label="Not collected">
          <p className="font-semibold">This order wasn&apos;t collected in time</p>
          <p className="mt-1 text-sm">
            Under the outlet&apos;s policy there&apos;s no refund. Sealed, packaged items went back
            into stock, and freshly made food was offered to other students at a discount.
          </p>
        </section>
      )}

      {o.queue_position != null && (
        <p className="rounded-xl bg-info-soft px-4 py-3 text-info" data-testid="queue-position">
          {o.queue_position === 0
            ? "You're next in the kitchen queue."
            : `${o.queue_position} order${o.queue_position === 1 ? "" : "s"} ahead of you.`}
        </p>
      )}

      {(o.status === "cancelled" || o.status === "rejected") && (
        <section className="rounded-2xl bg-danger-soft p-5 text-danger">
          <p className="font-semibold">{orderStatusLabel(o.status)}</p>
          {o.cancel_reason && <p className="text-sm">Reason: {o.cancel_reason}</p>}
          {o.refund_status === "required" && (
            <p className="mt-2 text-sm">
              A refund of {formatPaise(o.total_paise)} is owed to you. Refund processing arrives in
              a later release; this order is recorded as awaiting refund.
            </p>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-line bg-surface p-5">
        <OrderTimeline status={o.status} />
        <ul className="grid gap-2 border-t border-line pt-4" aria-label="Items">
          {o.items.map((item) => (
            <li key={item.id} className="flex justify-between text-sm">
              <span>
                {item.quantity} × {item.item_name}
              </span>
              <span>{formatPaise(item.line_total_paise)}</span>
            </li>
          ))}
        </ul>
        {o.discount_paise > 0 && (
          <div className="mt-3 flex justify-between border-t border-line pt-3 text-sm">
            <span>Voucher</span>
            <span>−{formatPaise(o.discount_paise)}</span>
          </div>
        )}
        <div className="mt-3 flex justify-between border-t border-line pt-3 font-semibold">
          <span>Total</span>
          <span>{formatPaise(o.total_paise)}</span>
        </div>
        {o.loyalty_points != null && o.loyalty_points !== 0 && (
          <p className="mt-1 text-right text-sm text-primary" data-testid="points-earned">
            {o.loyalty_points > 0 ? `+${o.loyalty_points}` : o.loyalty_points} loyalty points
          </p>
        )}
      </section>

      <ReviewSection order={o} />

      <RefundRequest order={o} />

      {canCancel && (
        <div className="grid gap-2">
          <InlineError error={cancel.error} />
          <Button
            variant="danger"
            busy={cancel.isPending}
            onClick={() => window.confirm("Cancel this order?") && cancel.mutate()}
            className="justify-self-start"
          >
            Cancel order
          </Button>
        </div>
      )}

      <details className="text-sm text-muted">
        <summary className="cursor-pointer font-medium">Order history</summary>
        <ol className="mt-2 grid gap-1">
          {o.events.map((event, i) => (
            <li key={i}>
              {new Date(event.created_at).toLocaleTimeString("en-IN", {
                timeZone: tz,
                hour: "numeric",
                minute: "2-digit",
              })}{" "}
              — {orderEventLabel(event)}
              {event.reason ? ` (${event.reason})` : ""}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
