import {
  CAMPUS_TIME_ZONE,
  CampusCartApiError,
  formatDayLabel,
  formatPaise,
  formatTime,
  newIdempotencyKey,
  queryKeys,
} from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  Muted,
  Stepper,
  Title,
  makeStyles,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCart, useOutlet, usePickupSlots, useSetCartItem } from "@/lib/hooks";
import { radius, space, useTheme } from "@/lib/theme";

export default function CartScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const { session, ready } = useAuth();
  const queryClient = useQueryClient();
  const cart = useCart();
  const setItem = useSetCartItem();
  const outletId = cart.data?.outlet_id ?? undefined;
  const outlet = useOutlet(outletId);
  const slots = usePickupSlots(outletId);
  const [slotId, setSlotId] = useState<string | null>(null);
  // One idempotency key per distinct checkout request, so a retry never creates a second order.
  const keys = useRef(new Map<string, string>());
  const signature = useMemo(
    () =>
      JSON.stringify([outletId, slotId, cart.data?.items.map((i) => [i.menu_item_id, i.quantity])]),
    [outletId, slotId, cart.data],
  );
  const placeOrder = useMutation({
    mutationFn: () => {
      if (!keys.current.has(signature)) keys.current.set(signature, newIdempotencyKey());
      return api.placeOrder(
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
      router.push({ pathname: "/order/[id]", params: { id: order.id } });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cart });
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
      setSlotId(null);
    },
    onError: (error) => {
      if (error instanceof CampusCartApiError && error.reason?.startsWith("slot")) {
        setSlotId(null);
        void slots.refetch();
      }
    },
  });

  if (!ready) return <Loading label="Loading" />;
  if (!session) {
    return (
      <View style={[s.screen, s.content]}>
        <Empty
          title="Sign in to order"
          message="Your cart is shared between the app and the website."
        />
        <Button label="Sign in" onPress={() => router.push("/login")} />
      </View>
    );
  }
  if (cart.isPending) return <Loading label="Loading cart" />;
  if (cart.isError) return <ErrorBox error={cart.error} onRetry={() => void cart.refetch()} />;
  const c = cart.data;
  if (c.items.length === 0) {
    return (
      <View style={[s.screen, s.content]}>
        <Empty title="Your cart is empty" message="Add something from an outlet's menu." />
      </View>
    );
  }
  const tz = outlet.data?.timezone ?? CAMPUS_TIME_ZONE;
  const blocked = c.items.some((i) => !i.orderable);
  const accepting = outlet.data?.accepting_orders ?? false;
  const groups = new Map<string, NonNullable<typeof slots.data>>();
  for (const slot of slots.data ?? []) {
    const day = formatDayLabel(slot.starts_at, tz);
    groups.set(day, [...(groups.get(day) ?? []), slot]);
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Title>Your order</Title>
      {outlet.data && <Muted>From {outlet.data.name}</Muted>}
      {c.items.map((item) => (
        <Card key={item.menu_item_id}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: space.sm,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.ink, fontWeight: "700" }}>{item.name}</Text>
              <Muted>{formatPaise(item.unit_price_paise)} each</Muted>
              {!item.orderable && (
                <Text style={{ color: t.danger, fontWeight: "600" }}>No longer available</Text>
              )}
            </View>
            <Stepper
              value={item.quantity}
              label={item.name}
              disabled={setItem.isPending}
              onChange={(quantity) => setItem.mutate({ menuItemId: item.menu_item_id, quantity })}
            />
          </View>
        </Card>
      ))}
      <Card>
        <Text accessibilityRole="header" style={{ color: t.ink, fontWeight: "700", fontSize: 16 }}>
          Pickup time
        </Text>
        {slots.isPending ? (
          <Loading label="Loading pickup times" />
        ) : slots.isError ? (
          <ErrorBox error={slots.error} onRetry={() => void slots.refetch()} />
        ) : groups.size === 0 ? (
          <Muted>No upcoming pickup slots.</Muted>
        ) : (
          [...groups].map(([day, daySlots]) => (
            <View key={day} style={{ gap: space.sm }}>
              <Muted>{day}</Muted>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                {daySlots.map((slot) => {
                  const selected = slot.id === slotId;
                  return (
                    <Pressable
                      key={slot.id}
                      accessibilityRole="radio"
                      accessibilityLabel={`${formatTime(slot.starts_at, tz)}, ${slot.bookable ? `${slot.remaining} left` : "full"}`}
                      accessibilityState={{ selected, disabled: !slot.bookable }}
                      disabled={!slot.bookable}
                      onPress={() => setSlotId(slot.id)}
                      style={{
                        minWidth: 80,
                        minHeight: 48,
                        padding: space.sm,
                        borderRadius: radius.sm,
                        borderWidth: 1,
                        borderColor: selected ? t.primary : t.line,
                        backgroundColor: selected ? t.primarySoft : t.surface,
                        opacity: slot.bookable ? 1 : 0.45,
                      }}
                    >
                      <Text style={{ color: t.ink, fontWeight: "700" }}>
                        {formatTime(slot.starts_at, tz)}
                      </Text>
                      <Text style={{ color: t.muted, fontSize: 12 }}>
                        {slot.bookable ? `${slot.remaining} left` : "Full"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        )}
      </Card>
      <Card>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: t.ink, fontSize: 18, fontWeight: "700" }}>Total</Text>
          <Text testID="cart-total" style={{ color: t.ink, fontSize: 18, fontWeight: "700" }}>
            {formatPaise(c.subtotal_paise)}
          </Text>
        </View>
        <Muted>
          Prices are confirmed by the outlet when you place the order. Items and slot are held for a
          few minutes while you pay.
        </Muted>
        {!accepting && outlet.data && (
          <Text style={{ color: t.warn, fontWeight: "600" }}>
            This outlet isn&apos;t taking orders right now.
          </Text>
        )}
        {blocked && (
          <Text style={{ color: t.danger, fontWeight: "600" }}>
            Remove unavailable items to continue.
          </Text>
        )}
        <ErrorBox error={placeOrder.error} />
        <Button
          label={slotId ? "Place order" : "Choose a pickup time"}
          disabled={!slotId || blocked || !accepting}
          busy={placeOrder.isPending}
          onPress={() => placeOrder.mutate()}
        />
      </Card>
    </ScrollView>
  );
}
