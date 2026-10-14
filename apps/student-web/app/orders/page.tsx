"use client";

import { formatPaise } from "@campuscart/client";
import Link from "next/link";
import { OrderStatusBadge } from "@/components/order-status";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingList } from "@/components/ui/states";
import { useRequireAuth } from "@/lib/auth";
import { useOrderHistory } from "@/lib/hooks";

export default function OrdersPage() {
  const auth = useRequireAuth();
  const history = useOrderHistory();
  if (!auth.ready || !auth.session || history.isPending)
    return <LoadingList label="Loading orders" />;
  if (history.isError)
    return <ErrorState error={history.error} onRetry={() => void history.refetch()} />;
  const orders = history.data.pages.flatMap((p) => p.items);
  return (
    <div className="grid gap-4">
      <h1 className="text-3xl font-bold tracking-tight">Your orders</h1>
      {orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          action={
            <Link href="/" className="font-medium text-primary underline">
              Find something to eat
            </Link>
          }
        />
      ) : (
        <ul className="grid gap-2">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/orders/${order.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 hover:shadow-md"
              >
                <div className="min-w-0">
                  <p className="font-semibold">
                    {order.token_label && (
                      <span className="mr-2 text-primary">{order.token_label}</span>
                    )}
                    {order.outlet.name}
                  </p>
                  <p className="truncate text-sm text-muted">
                    {new Date(order.created_at).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                    })}{" "}
                    · {order.items.map((i) => `${i.quantity}× ${i.item_name}`).join(", ")}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <OrderStatusBadge status={order.status} />
                  <span className="text-sm font-semibold">{formatPaise(order.total_paise)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {history.hasNextPage && (
        <Button
          variant="secondary"
          onClick={() => void history.fetchNextPage()}
          busy={history.isFetchingNextPage}
          className="justify-self-center"
        >
          Load older orders
        </Button>
      )}
    </div>
  );
}
