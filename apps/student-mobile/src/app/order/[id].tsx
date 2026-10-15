import {
  canTransition,
  formatDayLabel,
  formatPaise,
  formatSlot,
  formatTime,
  orderStatusLabel,
  queryKeys,
} from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { LiveIndicator, OrderStatusBadge, PickupPass, Timeline } from "@/components/status";
import { RefundRequestCard } from "@/components/deals";
import { ReviewCard, WalletPayCard } from "@/components/money";
import { Button, Card, ErrorBox, Loading, Muted, Title, makeStyles } from "@/components/ui";
import { api } from "@/lib/api";
import { confirm } from "@/lib/confirm";
import { useOrder, useOutlet, useTransitions } from "@/lib/hooks";
import { radius, space, useTheme } from "@/lib/theme";

export default function OrderScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const order = useOrder(id);
  const outlet = useOutlet(order.data?.outlet.slug);
  const rules = useTransitions();
  const cancel = useMutation({
    mutationFn: () => api.cancelOrder(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.order(id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
    },
  });

  if (order.isPending) return <Loading label="Loading order" />;
  if (order.isError) return <ErrorBox error={order.error} onRetry={() => void order.refetch()} />;
  const o = order.data;
  const tz = outlet.data?.timezone ?? "Asia/Kolkata";
  const canCancel = rules.data ? canTransition(rules.data, o, "cancelled", "student") : false;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: o.token_label ?? "Order" }} />
      <View
        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Title>{o.outlet.name}</Title>
          {o.pickup_slot ? (
            <Muted>
              Pickup {formatDayLabel(o.pickup_slot.starts_at, tz).toLowerCase()},{" "}
              {formatSlot(o.pickup_slot.starts_at, o.pickup_slot.ends_at, tz)}
            </Muted>
          ) : (
            <Muted>Surplus deal · pick up at the counter once paid</Muted>
          )}
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <OrderStatusBadge status={o.status} />
          <LiveIndicator status={order.live} />
        </View>
      </View>
      <Text accessibilityLiveRegion="polite" style={{ height: 0, width: 0, opacity: 0 }}>
        Order status: {orderStatusLabel(o.status)}
      </Text>

      {o.status === "payment_pending" && (
        <WalletPayCard order={o} onExpired={() => void order.refetch()} />
      )}

      <PickupPass order={o} />

      {o.status === "ready_for_pickup" && o.pickup_deadline && (
        <View style={{ backgroundColor: t.okSoft, borderRadius: radius.sm, padding: space.md }}>
          <Text style={{ color: t.ok }}>
            Collect by {formatTime(o.pickup_deadline, tz)}. Orders not collected by then aren&apos;t
            refunded, and the food is offered to other students.
          </Text>
        </View>
      )}

      {o.status === "no_show" && (
        <View
          style={{
            backgroundColor: t.dangerSoft,
            borderRadius: radius.md,
            padding: space.lg,
            gap: 4,
          }}
        >
          <Text style={{ color: t.danger, fontWeight: "700" }}>
            This order wasn&apos;t collected in time
          </Text>
          <Text style={{ color: t.danger }}>
            Under the outlet&apos;s policy there&apos;s no refund. Packaged items went back into
            stock, and freshly made food was offered to other students at a discount.
          </Text>
        </View>
      )}

      {o.queue_position != null && (
        <View style={{ backgroundColor: t.infoSoft, borderRadius: radius.sm, padding: space.md }}>
          <Text style={{ color: t.info }}>
            {o.queue_position === 0
              ? "You're next in the kitchen queue."
              : `${o.queue_position} order${o.queue_position === 1 ? "" : "s"} ahead of you.`}
          </Text>
        </View>
      )}

      {(o.status === "cancelled" || o.status === "rejected") && (
        <View
          style={{
            backgroundColor: t.dangerSoft,
            borderRadius: radius.md,
            padding: space.lg,
            gap: 4,
          }}
        >
          <Text style={{ color: t.danger, fontWeight: "700" }}>{orderStatusLabel(o.status)}</Text>
          {o.cancel_reason && <Text style={{ color: t.danger }}>Reason: {o.cancel_reason}</Text>}
          {o.refund_status === "required" && (
            <Text style={{ color: t.danger }}>
              A refund of {formatPaise(o.total_paise)} is owed to you. Refund processing arrives in
              a later release.
            </Text>
          )}
        </View>
      )}

      <Card>
        <Timeline status={o.status} />
        {o.items.map((item) => (
          <View key={item.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ color: t.ink }}>
              {item.quantity} × {item.item_name}
            </Text>
            <Text style={{ color: t.ink }}>{formatPaise(item.line_total_paise)}</Text>
          </View>
        ))}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            borderTopWidth: 1,
            borderTopColor: t.line,
            paddingTop: space.sm,
          }}
        >
          <Text style={{ color: t.ink, fontWeight: "700" }}>Total</Text>
          <Text style={{ color: t.ink, fontWeight: "700" }}>{formatPaise(o.total_paise)}</Text>
        </View>
      </Card>

      <ReviewCard order={o} />
      <RefundRequestCard order={o} />

      {canCancel && (
        <>
          <ErrorBox error={cancel.error} />
          <Button
            label="Cancel order"
            variant="danger"
            busy={cancel.isPending}
            onPress={() =>
              void confirm("Cancel this order?", "This can't be undone.", "Cancel order").then(
                (ok) => ok && cancel.mutate(),
              )
            }
          />
        </>
      )}
    </ScrollView>
  );
}
