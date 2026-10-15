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
  no_show: "Not collected",
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
  no_show: "danger",
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
  if (status === "cancelled" || status === "rejected" || status === "no_show") return [];
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

const QR_PATTERN =
  /^campuscart:pickup:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([A-Za-z0-9]{4,12})$/i;

/**
 * Reads what a counter scanner typed from a Digital Food Pass QR. Returns null for anything
 * else (staff can still type the 6-character code by hand). The server verifies the code.
 */
export function parsePickupQr(payload: string): { orderId: string; code: string } | null {
  const match = QR_PATTERN.exec(payload.trim());
  if (!match?.[1] || !match[2]) return null;
  return { orderId: match[1].toLowerCase(), code: match[2].toUpperCase() };
}

const EVENT_LABELS: Record<string, string> = {
  refund_requested: "Refund requested",
  refund_approved: "Refund approved",
  refund_declined: "Refund declined",
  no_show: "Not collected in time",
  expired: "Hold expired (not paid)",
};

/** A line of order history: refund activity has its own wording; everything else is a status. */
export function orderEventLabel(
  event: Pick<Schemas["OrderEvent"], "event_type" | "to_status">,
): string {
  return EVENT_LABELS[event.event_type] ?? LABELS[event.to_status];
}

/** True for an order that bought a surplus deal (no slot: the food is already at the counter). */
export function isDealOrder(order: Pick<Schemas["Order"], "source_deal_id">): boolean {
  return order.source_deal_id !== null;
}
