import NetInfo from "@react-native-community/netinfo";
import {
  formatCountdown,
  orderStatusLabel,
  orderStatusTone,
  orderTimeline,
  pickupQrPayload,
  type OrderStatus,
  type RealtimeStatus,
  type Schemas,
} from "@campuscart/client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { space, useTheme } from "@/lib/theme";
import { Badge, Card } from "./ui";

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={orderStatusTone(status)} label={orderStatusLabel(status)} />;
}

export function LiveIndicator({ status }: { status: RealtimeStatus }) {
  const t = useTheme();
  const label = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" }[status];
  return (
    <View
      accessibilityLabel={`Updates: ${label}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: status === "live" ? t.ok : t.warn,
        }}
      />
      <Text style={{ color: t.muted, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function OfflineBanner() {
  const t = useTheme();
  const [offline, setOffline] = useState(false);
  useEffect(() => NetInfo.addEventListener((state) => setOffline(state.isConnected === false)), []);
  if (!offline) return null;
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: t.warnSoft, padding: space.sm }}>
      <Text style={{ color: t.warn, textAlign: "center", fontWeight: "500" }}>
        You&apos;re offline. Showing the last information we had.
      </Text>
    </View>
  );
}

export function Timeline({ status }: { status: OrderStatus }) {
  const t = useTheme();
  const steps = orderTimeline(status);
  if (!steps.length) return null;
  return (
    <View accessibilityLabel="Order progress" style={{ gap: space.sm }}>
      {steps.map((step, i) => (
        <View
          key={step.status}
          style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor:
                step.state === "done"
                  ? t.primary
                  : step.state === "current"
                    ? t.primarySoft
                    : t.surface2,
              borderWidth: step.state === "current" ? 2 : 0,
              borderColor: t.primary,
            }}
          >
            <Text
              style={{
                color: step.state === "done" ? t.primaryInk : t.muted,
                fontSize: 12,
                fontWeight: "700",
              }}
            >
              {step.state === "done" ? "✓" : i + 1}
            </Text>
          </View>
          <Text
            accessibilityLabel={`${step.label}, ${step.state}`}
            style={{
              color: step.state === "upcoming" ? t.muted : t.ink,
              fontWeight: step.state === "upcoming" ? "400" : "600",
            }}
          >
            {step.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function PickupPass({ order }: { order: Schemas["OrderDetail"] }) {
  const t = useTheme();
  const payload = pickupQrPayload(order);
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (payload)
      void QRCode.toString(payload, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(
        setSvg,
      );
  }, [payload]);
  // Only useful while the order can still be collected.
  const ended = ["no_show", "cancelled", "rejected"].includes(order.status);
  if (!payload || !order.token_label || ended) return null;
  return (
    <Card style={{ borderColor: t.primary, borderWidth: 2, alignItems: "center" }}>
      <View
        accessibilityLabel={`QR code for token ${order.token_label}`}
        style={{ backgroundColor: "#fff", padding: 8, borderRadius: 8 }}
      >
        {svg && <SvgXml xml={svg} width={170} height={170} />}
      </View>
      <Text style={{ color: t.muted }}>Your token</Text>
      <Text testID="token" style={{ color: t.primary, fontSize: 40, fontWeight: "900" }}>
        {order.token_label}
      </Text>
      <Text style={{ color: t.muted }}>Pickup code</Text>
      <Text
        testID="pickup-code"
        style={{
          color: t.ink,
          fontSize: 26,
          fontWeight: "800",
          letterSpacing: 6,
          fontFamily: "Courier",
        }}
      >
        {order.pickup_code}
      </Text>
      <Text style={{ color: t.muted, fontSize: 12, textAlign: "center" }}>
        Show the QR or read this code at the counter.
      </Text>
    </Card>
  );
}

export function Countdown({ until, onElapsed }: { until: string; onElapsed?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const remaining = new Date(until).getTime() - now;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (remaining <= 0) onElapsed?.();
  }, [remaining <= 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Text style={{ fontWeight: "800", fontVariant: ["tabular-nums"] }}>
      {formatCountdown(remaining)}
    </Text>
  );
}
