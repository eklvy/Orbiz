import {
  formatPaise,
  formatTime,
  newIdempotencyKey,
  queryKeys,
  type Schemas,
} from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card, ErrorBox, Input, Muted } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDeals } from "@/lib/hooks";
import { space, useTheme } from "@/lib/theme";

/** Discounted food from uncollected orders (D-19). Server-priced; buying holds the deal. */
export function DealsList({ outletId, timeZone }: { outletId: string; timeZone: string }) {
  const t = useTheme();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const deals = useDeals(outletId);
  const [keys] = useState(() => new Map<string, string>());
  const claim = useMutation({
    mutationFn: (dealId: string) => {
      const key = keys.get(dealId) ?? newIdempotencyKey();
      keys.set(dealId, key);
      return api.claimDeal(dealId, key);
    },
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
      router.push(`/order/${order.id}`);
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.deals(outletId) }),
  });

  if (!deals.data || deals.data.length === 0) return null;
  return (
    <View style={{ gap: space.sm }}>
      <Text accessibilityRole="header" style={{ color: t.ink, fontSize: 18, fontWeight: "700" }}>
        Ready now, at a discount
      </Text>
      <Muted>
        Freshly made food from orders that weren&apos;t collected. Pick it up once paid.
      </Muted>
      <ErrorBox error={claim.error} />
      {deals.data.map((deal) => (
        <Card key={deal.id} style={{ borderColor: t.accent, borderWidth: 2, gap: space.sm }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
            <View style={{ flex: 1 }}>
              {deal.items.map((item, i) => (
                <Text key={i} style={{ color: t.ink, fontWeight: "600" }}>
                  {item.quantity} × {item.item_name}
                </Text>
              ))}
            </View>
            <Badge tone="warning" label={`${deal.discount_percent}% off`} />
          </View>
          <Text style={{ color: t.ink }}>
            <Text style={{ fontWeight: "700", fontSize: 18 }}>{formatPaise(deal.price_paise)}</Text>{" "}
            <Text style={{ color: t.muted, textDecorationLine: "line-through" }}>
              {formatPaise(deal.original_price_paise)}
            </Text>
          </Text>
          <Muted>Available until {formatTime(deal.expires_at, timeZone)}</Muted>
          <Button
            label="Buy deal"
            accessibilityLabel={`Buy deal: ${deal.items.map((i) => `${i.quantity} ${i.item_name}`).join(", ")}`}
            busy={claim.isPending && claim.variables === deal.id}
            disabled={claim.isPending}
            onPress={() => (session ? claim.mutate(deal.id) : router.push("/login"))}
          />
        </Card>
      ))}
    </View>
  );
}

const STATUS_TEXT: Record<Schemas["RefundRequestSummary"]["status"], string> = {
  pending: "Your refund request is waiting for the outlet manager.",
  approved: "Refund approved. It's recorded as owed to you; payouts arrive in a later release.",
  declined: "The outlet declined your refund request.",
};

/** Ask for a refund on a collected order (24 h window enforced by the server). */
export function RefundRequestCard({ order }: { order: Schemas["OrderDetail"] }) {
  const t = useTheme();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [openedAt] = useState(() => Date.now());
  const submit = useMutation({
    mutationFn: () => api.requestRefund(order.id, reason.trim()),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.order(order.id), updated);
      setOpen(false);
    },
  });

  const request = order.refund_request;
  if (request) {
    return (
      <Card style={{ gap: 4 }}>
        <Text style={{ color: t.ink, fontWeight: "700" }}>
          Refund request · {formatPaise(request.amount_paise)}
        </Text>
        <Text style={{ color: t.ink }}>{STATUS_TEXT[request.status]}</Text>
        {request.decision_note && <Muted>Note: {request.decision_note}</Muted>}
      </Card>
    );
  }
  const eligible =
    order.status === "completed" &&
    order.refund_status === "none" &&
    order.completed_at !== null &&
    openedAt - new Date(order.completed_at).getTime() < 24 * 60 * 60 * 1000;
  if (!eligible) return null;
  if (!open)
    return (
      <Button
        label="Something wrong? Ask for a refund"
        variant="secondary"
        onPress={() => setOpen(true)}
      />
    );
  return (
    <Card style={{ gap: space.sm }}>
      <Input
        label="What went wrong?"
        value={reason}
        onChangeText={setReason}
        maxLength={500}
        multiline
      />
      <Muted>The outlet manager reviews it. Requests are open for 24 hours after pickup.</Muted>
      <ErrorBox error={submit.error} />
      <Button
        label="Send request"
        busy={submit.isPending}
        disabled={reason.trim().length < 5}
        onPress={() => submit.mutate()}
      />
    </Card>
  );
}
