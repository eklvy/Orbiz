"use client";

import { CampusCartApiError, formatPaise, newIdempotencyKey, queryKeys } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { SlotPicker } from "@/components/slot-picker";
import { Button } from "@/components/ui/button";
import { QuantityStepper } from "@/components/ui/quantity-stepper";
import { EmptyState, ErrorState, InlineError, LoadingList } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useCart, useOutlet, usePickupSlots, useSetCartItem } from "@/lib/hooks";

export default function CartPage() {
  const auth = useRequireAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const cart = useCart();
  const setItem = useSetCartItem();
  const outletId = cart.data?.outlet_id ?? undefined;
  const outlet = useOutlet(outletId);
  const slots = usePickupSlots(outletId);
  const [slotId, setSlotId] = useState<string | null>(null);

  // One idempotency key per distinct checkout request: a retry of the same request (e.g. after
  // a network error) reuses it, so the order is never created twice.
  const keys = useRef(new Map<string, string>());
  const signature = useMemo(
    () =>
      JSON.stringify([outletId, slotId, cart.data?.items.map((i) => [i.menu_item_id, i.quantity])]),
    [outletId, slotId, cart.data],
  );

  const placeOrder = useMutation({
    mutationFn: () => {
      if (!keys.current.has(signature)) keys.current.set(signature, newIdempotencyKey());
      return getApi().placeOrder(
        {
          outlet_id: outletId as string,
          pickup_slot_id: slotId as string,
          items: (cart.data?.items ?? []).map((i) => ({
            menu_item_id: i.menu_item_id,
            quantity: i.quantity,
          })),
        },
        keys.current.get(signature) as string,
      );
    },
    onSuccess: (order) => {
      queryClient.setQueryData(queryKeys.order(order.id), order);
      router.push(`/orders/${order.id}`);
      // The server emptied the cart; refresh it without flashing an empty cart (see below).
      void queryClient.invalidateQueries({ queryKey: queryKeys.cart });
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
    },
    onError: (error) => {
      if (error instanceof CampusCartApiError && error.reason?.startsWith("slot")) {
        setSlotId(null);
        void slots.refetch();
      }
      if (
        error instanceof CampusCartApiError &&
        ["insufficient_stock", "item_unavailable"].includes(error.reason ?? "")
      ) {
        void cart.refetch();
      }
    },
  });

  if (placeOrder.isSuccess) {
    return (
      <p role="status" className="rounded-xl border border-line bg-surface p-6 font-medium">
        Order placed. Opening your order…
      </p>
    );
  }
  if (!auth.ready || !auth.session) return <LoadingList rows={2} label="Loading cart" />;
  if (cart.isPending) return <LoadingList rows={2} label="Loading cart" />;
  if (cart.isError) return <ErrorState error={cart.error} onRetry={() => void cart.refetch()} />;

  const c = cart.data;
  if (c.items.length === 0) {
    return (
      <EmptyState
        title="Your cart is empty"
        action={
          <Link href="/" className="font-medium text-primary underline">
            Browse outlets
          </Link>
        }
      >
        Add something from an outlet&apos;s menu to get started.
      </EmptyState>
    );
  }

  const blocked = c.items.some((i) => !i.orderable);
  const accepting = outlet.data?.accepting_orders ?? false;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
      <div className="grid gap-6">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">Your order</h1>
          {outlet.data && (
            <p className="text-muted">
              From{" "}
              <Link
                href={`/outlets/${outlet.data.slug}`}
                className="font-medium text-primary underline"
              >
                {outlet.data.name}
              </Link>
            </p>
          )}
        </header>
        <ul className="grid gap-2" aria-label="Cart items">
          {c.items.map((item) => (
            <li
              key={item.menu_item_id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4"
            >
              <div className="min-w-0">
                <p className="font-semibold">{item.name}</p>
                <p className="text-sm text-muted">
                  {formatPaise(item.unit_price_paise)} each
                  {!item.orderable && (
                    <span className="ml-2 font-semibold text-danger">No longer available</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <QuantityStepper
                  value={item.quantity}
                  label={item.name}
                  disabled={setItem.isPending}
                  onChange={(quantity) =>
                    setItem.mutate({ menuItemId: item.menu_item_id, quantity })
                  }
                />
                <span className="w-16 text-right font-semibold">
                  {formatPaise(item.line_total_paise)}
                </span>
              </div>
            </li>
          ))}
        </ul>
        <section className="rounded-xl border border-line bg-surface p-4">
          {slots.isPending ? (
            <LoadingList rows={1} label="Loading pickup times" />
          ) : slots.isError ? (
            <ErrorState error={slots.error} onRetry={() => void slots.refetch()} />
          ) : slots.data.length === 0 ? (
            <EmptyState title="No pickup times available">
              This outlet has no upcoming pickup slots.
            </EmptyState>
          ) : (
            <SlotPicker
              slots={slots.data}
              value={slotId}
              onChange={setSlotId}
              timeZone={outlet.data?.timezone}
            />
          )}
        </section>
      </div>

      <aside
        className="sticky top-20 grid gap-4 rounded-xl border border-line bg-surface p-5"
        aria-label="Order summary"
      >
        <div className="flex justify-between text-lg font-semibold">
          <span>Total</span>
          <span data-testid="cart-total">{formatPaise(c.subtotal_paise)}</span>
        </div>
        <p className="text-xs text-muted">
          Prices are confirmed by the outlet when you place the order. Your items and pickup slot
          are held for a few minutes while you pay.
        </p>
        {!accepting && outlet.data && (
          <p className="text-sm font-medium text-warn">
            This outlet isn&apos;t taking orders right now.
          </p>
        )}
        {blocked && (
          <p className="text-sm font-medium text-danger">Remove unavailable items to continue.</p>
        )}
        <InlineError error={placeOrder.error} />
        <Button
          size="lg"
          onClick={() => placeOrder.mutate()}
          disabled={!slotId || blocked || !accepting}
          busy={placeOrder.isPending}
        >
          {slotId ? "Place order" : "Choose a pickup time"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void getApi()
              .clearCart()
              .then(() => cart.refetch())
          }
        >
          Clear cart
        </Button>
      </aside>
    </div>
  );
}
