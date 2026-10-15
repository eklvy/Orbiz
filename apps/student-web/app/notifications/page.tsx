"use client";

import { queryKeys } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useNotifications } from "@/lib/hooks";

const CATEGORY = {
  orders: "Orders",
  refunds: "Refunds",
  loyalty: "Loyalty",
  specials: "Specials",
  social: "Groups & splits",
} as const;

export default function NotificationsPage() {
  const auth = useRequireAuth();
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  const markAll = useMutation({
    mutationFn: () => getApi().markNotificationsRead(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
  });
  if (!auth.ready || notifications.isPending) return <Skeleton className="h-64" />;
  if (notifications.isError)
    return <ErrorState error={notifications.error} onRetry={() => void notifications.refetch()} />;
  const n = notifications.data;
  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        {n.unread_count > 0 && (
          <Button
            variant="secondary"
            size="sm"
            busy={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Mark all as read ({n.unread_count})
          </Button>
        )}
      </div>
      {n.items.length === 0 ? (
        <EmptyState title="Nothing yet">
          Order updates, refunds and points will show up here.
        </EmptyState>
      ) : (
        <ul className="grid gap-2">
          {n.items.map((item) => {
            const orderId = typeof item.data.order_id === "string" ? item.data.order_id : null;
            const body = (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={item.read_at ? "neutral" : "info"}>{CATEGORY[item.category]}</Badge>
                  {!item.read_at && <span className="sr-only">Unread.</span>}
                  <p className="font-semibold">{item.title}</p>
                </div>
                <p className="mt-1 text-sm text-muted">{item.body}</p>
                <p className="mt-1 text-xs text-muted">
                  {new Date(item.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                </p>
              </>
            );
            return (
              <li
                key={item.id}
                data-testid="notification"
                className={`rounded-xl border bg-surface px-4 py-3 ${item.read_at ? "border-line" : "border-info/40"}`}
              >
                {orderId ? (
                  <Link href={`/orders/${orderId}`} className="block hover:text-primary">
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
