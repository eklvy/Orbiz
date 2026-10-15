"use client";

import { formatPaise, type Schemas } from "@campuscart/client";
import { Badge } from "./ui/badge";
import { QuantityStepper } from "./ui/quantity-stepper";
import { Button } from "./ui/button";

const DIET = { veg: "Veg", egg: "Egg", non_veg: "Non-veg" } as const;

export function StockBadge({ item }: { item: Schemas["MenuItem"] }) {
  if (item.stock_status === "sold_out") return <Badge tone="danger">Sold out</Badge>;
  if (item.stock_status === "low")
    return (
      <Badge tone="warning">
        {item.quantity_available != null ? `Only ${item.quantity_available} left` : "Running low"}
      </Badge>
    );
  return null;
}

export function MenuItemCard({
  item,
  quantity,
  canOrder,
  busy,
  onChange,
  onOpen,
}: {
  item: Schemas["MenuItem"];
  quantity: number;
  canOrder: boolean;
  busy: boolean;
  onChange: (next: number) => void;
  onOpen: () => void;
}) {
  const soldOut = item.stock_status === "sold_out";
  const max = item.quantity_available != null ? Math.min(20, item.quantity_available) : 20;
  return (
    <article
      className="flex gap-4 rounded-xl border border-line bg-surface p-4"
      aria-label={item.name}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.diet && (
            <span
              className={`text-xs font-semibold ${item.diet === "non_veg" ? "text-danger" : "text-ok"}`}
            >
              {DIET[item.diet]}
            </span>
          )}
          <StockBadge item={item} />
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="mt-1 text-left font-semibold hover:text-primary"
        >
          {item.name}
        </button>
        {item.description && (
          <p className="mt-0.5 line-clamp-2 text-sm text-muted">{item.description}</p>
        )}
        {item.special ? (
          <p className="mt-2" data-testid="special-price">
            <span className="font-semibold text-accent">
              {formatPaise(item.special.unit_price_paise)}
            </span>{" "}
            <s className="text-sm text-muted">{formatPaise(item.price_paise)}</s>{" "}
            <span className="text-xs font-semibold text-accent">
              Today&apos;s special · {item.special.discount_percent}% off ·{" "}
              {item.special.portions_left > 0
                ? `${item.special.portions_left} left`
                : "special sold out"}
            </span>
          </p>
        ) : (
          <p className="mt-2 font-semibold">{formatPaise(item.price_paise)}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end justify-end gap-2">
        {quantity > 0 ? (
          <QuantityStepper
            value={quantity}
            onChange={onChange}
            max={max}
            label={item.name}
            disabled={busy}
          />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onChange(1)}
            disabled={soldOut || !canOrder}
            busy={busy}
            aria-label={`Add ${item.name}`}
          >
            {soldOut ? "Sold out" : "Add"}
          </Button>
        )}
      </div>
    </article>
  );
}
