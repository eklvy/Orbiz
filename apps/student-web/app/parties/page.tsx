"use client";

import { formatPaise, queryKeys, type Schemas } from "@campuscart/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { EmptyState, ErrorState, InlineError, LoadingList } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useMenu, useOutlets } from "@/lib/hooks";

const STATUS: Record<Schemas["Party"]["status"], [Tone, string]> = {
  requested: ["info", "Waiting for the outlet"],
  accepted: ["warning", "Accepted: pay to confirm"],
  declined: ["danger", "Declined"],
  paid: ["success", "Confirmed"],
  cancelled: ["neutral", "Cancelled"],
  fulfilled: ["success", "Delivered"],
};

function RequestForm({ onDone }: { onDone: () => void }) {
  const outlets = useOutlets();
  const [outletId, setOutletId] = useState("");
  const menu = useMenu(outletId || undefined, {});
  const [name, setName] = useState("");
  const [when, setWhen] = useState("");
  const [headcount, setHeadcount] = useState("20");
  const [notes, setNotes] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const items = menu.data
    ? [...menu.data.categories.flatMap((c) => c.items), ...menu.data.uncategorized]
    : [];
  const lines = Object.entries(qty)
    .map(([menu_item_id, q]) => ({ menu_item_id, quantity: Number(q) || 0 }))
    .filter((l) => l.quantity > 0);
  const request = useMutation({
    mutationFn: () =>
      getApi().requestParty({
        outlet_id: outletId,
        event_name: name.trim(),
        event_at: new Date(when).toISOString(),
        headcount: Number(headcount),
        items: lines,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: onDone,
  });
  return (
    <form
      aria-label="Request a party booking"
      className="grid gap-3 rounded-2xl border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (outletId && name.trim() && when && lines.length) request.mutate();
      }}
    >
      <p className="font-semibold">Book catering for an event</p>
      <label className="grid gap-1 text-sm font-medium">
        Outlet
        <select
          value={outletId}
          onChange={(e) => setOutletId(e.target.value)}
          className="h-11 rounded-lg border border-line bg-surface px-2 font-normal"
        >
          <option value="">Choose…</option>
          {outlets.data?.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Event name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Date and time"
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <Field
          label="People"
          type="number"
          min={5}
          max={500}
          value={headcount}
          onChange={(e) => setHeadcount(e.target.value)}
        />
        <Field
          label="Notes (optional)"
          value={notes}
          maxLength={1000}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      {items.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Dishes and quantities</legend>
          {items.map((item) => (
            <label key={item.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {item.name} · {formatPaise(item.price_paise)}
              </span>
              <input
                type="number"
                min={0}
                max={1000}
                value={qty[item.id] ?? ""}
                placeholder="0"
                onChange={(e) => setQty((q) => ({ ...q, [item.id]: e.target.value }))}
                aria-label={`Quantity of ${item.name}`}
                className="h-9 w-24 rounded-lg border border-line bg-surface px-2"
              />
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-xs text-muted">
        Book 24 hours to 60 days ahead. The outlet confirms first; then you pay from your wallet.
        Full refund if you cancel at least 24 hours before.
      </p>
      <InlineError error={request.error} />
      <Button
        type="submit"
        busy={request.isPending}
        disabled={!outletId || !name.trim() || !when || lines.length === 0}
        className="justify-self-start"
      >
        Send request
      </Button>
    </form>
  );
}

export default function PartiesPage() {
  const auth = useRequireAuth();
  const queryClient = useQueryClient();
  const parties = useQuery({
    queryKey: queryKeys.parties,
    queryFn: () => getApi().listParties(),
    enabled: Boolean(auth.session),
  });
  const [requesting, setRequesting] = useState(false);
  const act = useMutation({
    mutationFn: (v: { id: string; action: "pay" | "cancel" }) =>
      v.action === "pay" ? getApi().payParty(v.id) : getApi().cancelParty(v.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.parties });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    },
  });
  return (
    <div className="mx-auto grid max-w-2xl gap-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Party bookings</h1>
        {!requesting && <Button onClick={() => setRequesting(true)}>Book an event</Button>}
      </div>
      {requesting && (
        <RequestForm
          onDone={() => {
            setRequesting(false);
            void queryClient.invalidateQueries({ queryKey: queryKeys.parties });
          }}
        />
      )}
      <InlineError error={act.error} />
      {parties.isPending ? (
        <LoadingList label="Loading bookings" rows={2} />
      ) : parties.isError ? (
        <ErrorState error={parties.error} onRetry={() => void parties.refetch()} />
      ) : parties.data.length === 0 ? (
        <EmptyState title="No bookings yet" />
      ) : (
        <ul className="grid gap-2">
          {parties.data.map((p) => (
            <li
              key={p.id}
              className="grid gap-2 rounded-xl border border-line bg-surface p-4"
              aria-label={p.event_name}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">
                  {p.event_name} · {p.outlet_name}
                </p>
                <Badge tone={STATUS[p.status][0]}>{STATUS[p.status][1]}</Badge>
              </div>
              <p className="text-sm text-muted">
                {new Date(p.event_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} ·{" "}
                {p.headcount} people ·{" "}
                {p.items.map((i) => `${i.quantity} × ${i.item_name}`).join(", ")}
              </p>
              {p.manager_note && <p className="text-sm">Outlet: “{p.manager_note}”</p>}
              <p className="font-semibold">{formatPaise(p.total_paise)}</p>
              <div className="flex gap-2">
                {p.status === "accepted" && (
                  <Button
                    size="sm"
                    busy={act.isPending}
                    onClick={() => act.mutate({ id: p.id, action: "pay" })}
                  >
                    Pay {formatPaise(p.total_paise)} from wallet
                  </Button>
                )}
                {["requested", "accepted", "paid"].includes(p.status) && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={act.isPending}
                    onClick={() =>
                      window.confirm("Cancel this booking?") &&
                      act.mutate({ id: p.id, action: "cancel" })
                    }
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
