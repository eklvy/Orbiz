import type { Schemas } from "./api";

export type OrderStatus = Schemas["OrderDetail"]["status"];
export type TransitionRule = Schemas["TransitionRule"];
type OrderLike = Pick<Schemas["Order"], "status" | "payment_status">;

const LABELS: Record<OrderStatus, string> = {
  payment_pending: "Awaiting payment",
  placed: "Order placed",
  confirmed: "Accepted by kitchen",
  preparing: "Preparing",
  ready_for_pickup: "Ready for pickup",
  completed: "Collected",
  cancelled: "Cancelled",
  rejected: "Rejected by kitchen",
};

export type StatusTone = "neutral" | "info" | "progress" | "success" | "danger" | "warning";

const TONES: Record<OrderStatus, StatusTone> = {
  payment_pending: "warning",
  placed: "info",
  confirmed: "info",
  preparing: "progress",
  ready_for_pickup: "success",
  completed: "neutral",
  cancelled: "danger",
  rejected: "danger",
};

export function orderStatusLabel(status: OrderStatus): string {
  return LABELS[status];
}

export function orderStatusTone(status: OrderStatus): StatusTone {
  return TONES[status];
}

const PROGRESS: OrderStatus[] = [
  "placed",
  "confirmed",
  "preparing",
  "ready_for_pickup",
  "completed",
];

export interface TimelineStep {
  status: OrderStatus;
  label: string;
  state: "done" | "current" | "upcoming";
}

/** The happy-path steps with progress for display. Ended orders show no timeline. */
export function orderTimeline(status: OrderStatus): TimelineStep[] {
  if (status === "cancelled" || status === "rejected") return [];
  const index = status === "payment_pending" ? -1 : PROGRESS.indexOf(status);
  return PROGRESS.map((step, i) => ({
    status: step,
    label: LABELS[step],
    state:
      i < index ? "done" : i === index ? (step === "completed" ? "done" : "current") : "upcoming",
  }));
}

export function isActiveOrder(order: Pick<OrderLike, "status">): boolean {
  return ["payment_pending", "placed", "confirmed", "preparing", "ready_for_pickup"].includes(
    order.status,
  );
}

/**
 * Whether the server's state machine lets `actor` move this order to `to`. Used only to decide
 * which buttons to show; the server re-checks every transition.
 */
export function canTransition(
  rules: readonly TransitionRule[],
  order: OrderLike,
  to: OrderStatus,
  actor: TransitionRule["actor"],
): boolean {
  return rules.some(
    (rule) =>
      rule.from_status === order.status &&
      rule.to_status === to &&
      rule.actor === actor &&
      (!rule.requires_paid || order.payment_status === "paid"),
  );
}

/** Realtime events can arrive late or twice; only accept strictly newer versions. */
export function isNewerVersion(
  current: { version: number } | undefined,
  incoming: { version: number },
): boolean {
  return current === undefined || incoming.version > current.version;
}

/** Contents of the Digital Food Pass QR code scanned at the counter. */
export function pickupQrPayload(
  order: Pick<Schemas["Order"], "id" | "pickup_code">,
): string | null {
  return order.pickup_code ? `campuscart:pickup:${order.id}:${order.pickup_code}` : null;
}
