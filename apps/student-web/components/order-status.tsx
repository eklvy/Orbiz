import {
  orderStatusLabel,
  orderStatusTone,
  orderTimeline,
  type OrderStatus,
} from "@campuscart/client";
import { Badge } from "./ui/badge";

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={orderStatusTone(status)}>{orderStatusLabel(status)}</Badge>;
}

export function OrderTimeline({ status }: { status: OrderStatus }) {
  const steps = orderTimeline(status);
  if (steps.length === 0) return null;
  return (
    <ol className="grid gap-0" aria-label="Order progress">
      {steps.map((step, i) => (
        <li
          key={step.status}
          className="flex gap-3"
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <div className="flex flex-col items-center">
            <span
              className={`grid size-6 place-items-center rounded-full text-xs font-bold ${
                step.state === "done"
                  ? "bg-primary text-primary-ink"
                  : step.state === "current"
                    ? "bg-primary-soft text-primary ring-2 ring-primary"
                    : "bg-surface-2 text-muted"
              }`}
              aria-hidden
            >
              {step.state === "done" ? "✓" : i + 1}
            </span>
            {i < steps.length - 1 && (
              <span
                className={`w-0.5 flex-1 ${step.state === "done" ? "bg-primary" : "bg-line"}`}
              />
            )}
          </div>
          <p
            className={`pb-5 text-sm ${step.state === "upcoming" ? "text-muted" : "font-semibold"}`}
          >
            {step.label}
            <span className="sr-only">{` (${step.state})`}</span>
          </p>
        </li>
      ))}
    </ol>
  );
}
