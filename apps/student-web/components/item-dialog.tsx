"use client";

import { formatPaise, type Schemas } from "@campuscart/client";
import { useEffect, useRef } from "react";
import { StockBadge } from "./menu-item-card";
import { Button } from "./ui/button";

export function ItemDialog({
  item,
  onClose,
}: {
  item: Schemas["MenuItem"] | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (item && !dialog.open) dialog.showModal();
    if (!item && dialog.open) dialog.close();
  }, [item]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-2xl bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40"
      aria-labelledby="item-dialog-title"
    >
      {item && (
        <div className="grid gap-4 p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id="item-dialog-title" className="text-xl font-semibold">
              {item.name}
            </h2>
            <p className="text-lg font-semibold">{formatPaise(item.price_paise)}</p>
          </div>
          <StockBadge item={item} />
          {item.description && <p className="text-muted">{item.description}</p>}
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg bg-surface-2 p-3">
              <dt className="text-muted">Prep time</dt>
              <dd className="font-semibold">{item.prep_minutes} min</dd>
            </div>
            <div className="rounded-lg bg-surface-2 p-3">
              <dt className="text-muted">Calories</dt>
              <dd className="font-semibold">
                {item.calories_kcal != null ? `${item.calories_kcal} kcal` : "Not listed"}
              </dd>
            </div>
            <div className="rounded-lg bg-surface-2 p-3">
              <dt className="text-muted">Protein</dt>
              <dd className="font-semibold">
                {item.protein_g != null ? `${item.protein_g} g` : "Not listed"}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted">
            Nutrition is provided by the outlet. Ask at the counter about allergens; CampusCart
            cannot guarantee allergy safety.
          </p>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </dialog>
  );
}
