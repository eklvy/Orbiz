import { formatPaise, queryKeys, type Schemas } from "@campuscart/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Countdown } from "@/components/status";
import { Button, Card, ErrorBox, Input, Muted } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoyalty, useWallet } from "@/lib/hooks";
import { radius, space, useTheme } from "@/lib/theme";

/** Pay an unpaid order from the wallet (online top-ups happen on the website, D-21). */
export function WalletPayCard({
  order,
  onExpired,
}: {
  order: Schemas["OrderDetail"];
  onExpired: () => void;
}) {
  const t = useTheme();
  const queryClient = useQueryClient();
  const wallet = useWallet();
  const [code, setCode] = useState("");
  const refresh = (updated: Schemas["OrderDetail"]) => {
    queryClient.setQueryData(queryKeys.order(order.id), updated);
    void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
  };
  const pay = useMutation({ mutationFn: () => api.payWithWallet(order.id), onSuccess: refresh });
  const voucher = useMutation({
    mutationFn: () => api.applyVoucher(order.id, code.trim()),
    onSuccess: (updated) => {
      setCode("");
      refresh(updated);
    },
  });
  if (order.group_session_id) {
    return (
      <Card>
        <Text style={{ color: t.warn, fontWeight: "700" }}>Group order</Text>
        <Muted>Each member pays their share on the CampusCart website.</Muted>
      </Card>
    );
  }
  const balance = wallet.data?.balance_paise ?? 0;
  const enough = balance >= order.total_paise;
  return (
    <View
      style={{
        backgroundColor: t.warnSoft,
        borderRadius: radius.md,
        padding: space.lg,
        gap: space.sm,
      }}
    >
      <Text style={{ color: t.warn, fontWeight: "700" }}>
        Awaiting payment — held for{" "}
        {order.reservation_expires_at && (
          <Countdown until={order.reservation_expires_at} onElapsed={onExpired} />
        )}
      </Text>
      {order.discount_paise > 0 && (
        <Text style={{ color: t.warn }}>Voucher −{formatPaise(order.discount_paise)}</Text>
      )}
      <Text style={{ color: t.warn }} testID="wallet-balance">
        Wallet balance {formatPaise(balance)}
        {!enough ? " · top up on the website" : ""}
      </Text>
      <Button
        label={`Pay ${formatPaise(order.total_paise)} from wallet`}
        busy={pay.isPending}
        disabled={!enough}
        onPress={() => pay.mutate()}
      />
      <ErrorBox error={pay.error} />
      {!order.discount_paise && (
        <View style={{ gap: space.sm }}>
          <Input
            label="Voucher code"
            value={code}
            autoCapitalize="characters"
            onChangeText={setCode}
            maxLength={20}
          />
          <Button
            label="Apply voucher"
            variant="secondary"
            busy={voucher.isPending}
            disabled={!code.trim()}
            onPress={() => voucher.mutate()}
          />
          <ErrorBox error={voucher.error} />
        </View>
      )}
    </View>
  );
}

const DIMENSIONS = [
  ["taste", "Taste"],
  ["hygiene", "Hygiene"],
  ["speed", "Pickup speed"],
  ["value", "Value"],
] as const;

/** Rate a collected order (+15 points), then show the review and any reply. */
export function ReviewCard({ order }: { order: Schemas["OrderDetail"] }) {
  const t = useTheme();
  const queryClient = useQueryClient();
  const review = useQuery({
    queryKey: queryKeys.orderReview(order.id),
    queryFn: () => api.getOrderReview(order.id),
    enabled: order.status === "completed",
  });
  const [ratings, setRatings] = useState<Record<string, number>>({
    taste: 0,
    hygiene: 0,
    speed: 0,
    value: 0,
  });
  const submit = useMutation({
    mutationFn: () =>
      api.submitReview(order.id, {
        taste: ratings.taste ?? 0,
        hygiene: ratings.hygiene ?? 0,
        speed: ratings.speed ?? 0,
        value: ratings.value ?? 0,
      }),
    onSuccess: (saved) => queryClient.setQueryData(queryKeys.orderReview(order.id), saved),
  });
  if (order.status !== "completed" || review.isPending) return null;
  if (review.data) {
    const r = review.data;
    return (
      <Card style={{ gap: 4 }}>
        <Text style={{ color: t.ink, fontWeight: "700" }}>Your review</Text>
        <Muted>
          Taste {r.taste} · Hygiene {r.hygiene} · Speed {r.speed} · Value {r.value}
        </Muted>
        {r.reply && <Text style={{ color: t.primary }}>Reply: {r.reply}</Text>}
      </Card>
    );
  }
  return (
    <Card style={{ gap: space.sm }}>
      <Text style={{ color: t.ink, fontWeight: "700" }}>Rate your order (+15 points)</Text>
      {DIMENSIONS.map(([key, label]) => (
        <View
          key={key}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}
        >
          <Text style={{ color: t.ink, width: 100 }}>{label}</Text>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable
              key={n}
              accessibilityRole="radio"
              accessibilityState={{ checked: ratings[key] === n }}
              accessibilityLabel={`${n} stars for ${label}`}
              onPress={() => setRatings((r) => ({ ...r, [key]: n }))}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1,
                borderColor: (ratings[key] ?? 0) >= n ? t.primary : t.line,
                backgroundColor: (ratings[key] ?? 0) >= n ? t.primary : t.surface,
              }}
            >
              <Text style={{ color: (ratings[key] ?? 0) >= n ? t.primaryInk : t.ink }}>{n}</Text>
            </Pressable>
          ))}
        </View>
      ))}
      <ErrorBox error={submit.error} />
      <Button
        label="Post review"
        busy={submit.isPending}
        disabled={Object.values(ratings).some((n) => n === 0)}
        onPress={() => submit.mutate()}
      />
    </Card>
  );
}

/** Wallet balance, points and tier on the profile tab. */
export function MoneySummary() {
  const t = useTheme();
  const wallet = useWallet();
  const loyalty = useLoyalty();
  const tier = { silver: "Silver", gold: "Gold", platinum: "Platinum" } as const;
  return (
    <Card style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}>
      <View>
        <Muted>Wallet</Muted>
        <Text style={{ color: t.ink, fontSize: 22, fontWeight: "800" }} testID="profile-wallet">
          {wallet.data ? formatPaise(wallet.data.balance_paise) : "—"}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Muted>{loyalty.data ? `${tier[loyalty.data.tier]} tier` : "Points"}</Muted>
        <Text style={{ color: t.ink, fontSize: 22, fontWeight: "800" }}>
          {loyalty.data ? `${loyalty.data.balance_points} pts` : "—"}
        </Text>
      </View>
    </Card>
  );
}
