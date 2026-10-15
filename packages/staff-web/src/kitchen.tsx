"use client";

import {
  canTransition,
  formatPaise,
  formatSlot,
  formatTime,
  formatTimeLeft,
  parsePickupQr,
  queryKeys,
  staffQueryKeys,
  subscribeToTable,
  type RealtimeStatus,
  type StaffDeal,
  type StaffOrder,
  type StaffTargetStatus,
} from "@campuscart/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useRuntime } from "./runtime";
import { Badge, Button, EmptyState, ErrorState, InlineError, LiveIndicator, Loading } from "./ui";

/** Re-renders every `ms` so countdowns move; the deadlines themselves come from the server. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * The outlet's active orders, kept live: any order change at the outlet (new paid order, status
 * change, a deal bought by a new student) refetches the authoritative queue from the API.
 */
export function useStaffQueue(outletId: string) {
  const { supabase, api } = useRuntime();
  const queryClient = useQueryClient();
  const [live, setLive] = useState<RealtimeStatus>("connecting");
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.queue(outletId) });
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.deals(outletId) });
    };
    return subscribeToTable(supabase, {
      table: "orders",
      filter: `outlet_id=eq.${outletId}`,
      onChange: refresh,
      onResync: refresh,
      onStatus: setLive,
    });
  }, [supabase, outletId, queryClient]);
  return {
    ...useQuery({
      queryKey: staffQueryKeys.queue(outletId),
      queryFn: () => api.queue(outletId),
      refetchInterval: 60_000,
    }),
    live,
  };
}

export function useStaffDeals(outletId: string) {
  const { supabase, api } = useRuntime();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeToTable(supabase, {
        table: "surplus_deals",
        filter: `outlet_id=eq.${outletId}`,
        onChange: () =>
          void queryClient.invalidateQueries({ queryKey: staffQueryKeys.deals(outletId) }),
      }),
    [supabase, outletId, queryClient],
  );
  return useQuery({
    queryKey: staffQueryKeys.deals(outletId),
    queryFn: () => api.deals(outletId),
    refetchInterval: 60_000,
  });
}

function useTransitionRules() {
  const { api } = useRuntime();
  return useQuery({
    queryKey: queryKeys.transitions,
    queryFn: () => api.listTransitions(),
    staleTime: Infinity,
  });
}

const COLUMNS: { status: StaffOrder["status"]; title: string; empty: string }[] = [
  { status: "placed", title: "New", empty: "No new orders" },
  { status: "confirmed", title: "Accepted", empty: "Nothing accepted yet" },
  { status: "preparing", title: "Preparing", empty: "Nothing on the stove" },
  {
    status: "ready_for_pickup",
    title: "Ready for pickup",
    empty: "Nothing waiting at the counter",
  },
];

const NEXT_STEP: Partial<Record<StaffOrder["status"], { to: StaffTargetStatus; label: string }>> = {
  placed: { to: "confirmed", label: "Accept" },
  confirmed: { to: "preparing", label: "Start preparing" },
  preparing: { to: "ready_for_pickup", label: "Mark ready" },
};

function ReasonForm({
  label,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onSubmit(reason.trim());
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Reason (shown to the student)
      </label>
      <input
        id={id}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
        required
        className="h-10 rounded-lg border border-line bg-surface px-3"
      />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="sm" busy={busy} disabled={!reason.trim()}>
          {label}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Back
        </Button>
      </div>
    </form>
  );
}

function PickupCodeForm({ order, onDone }: { order: StaffOrder; onDone: (msg: string) => void }) {
  const { api } = useRuntime();
  const queryClient = useQueryClient();
  const id = useId();
  const [code, setCode] = useState("");
  const verify = useMutation({
    mutationFn: () => api.verifyPickup(order.id, code.trim()),
    onSuccess: () => {
      setCode("");
      onDone(`${order.token_label ?? "Order"} collected`);
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.queue(order.outlet.id) });
    },
  });
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim().length >= 4) verify.mutate();
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Pickup code for {order.token_label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={12}
          autoComplete="off"
          className="h-10 w-full min-w-0 rounded-lg border border-line bg-surface px-3 font-mono uppercase tracking-widest"
        />
        <Button type="submit" size="sm" busy={verify.isPending} className="h-10 shrink-0">
          Hand over
        </Button>
      </div>
      <InlineError error={verify.error} />
    </form>
  );
}

function OrderCard({
  order,
  timeZone,
  now,
  onDone,
}: {
  order: StaffOrder;
  timeZone: string;
  now: number;
  onDone: (msg: string) => void;
}) {
  const { api } = useRuntime();
  const queryClient = useQueryClient();
  const rules = useTransitionRules();
  const [stopping, setStopping] = useState(false);
  const move = useMutation({
    mutationFn: (vars: { to: StaffTargetStatus; reason?: string }) =>
      api.transition(order.id, vars.to, vars.reason),
    onSuccess: () => {
      setStopping(false);
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.queue(order.outlet.id) });
    },
  });
  const next = NEXT_STEP[order.status];
  const allowed = (to: StaffTargetStatus) =>
    rules.data ? canTransition(rules.data, order, to, "staff") : false;
  // Rejecting (before acceptance) and cancelling (after) both need a reason.
  const stopTo: StaffTargetStatus | null = allowed("rejected")
    ? "rejected"
    : allowed("cancelled")
      ? "cancelled"
      : null;
  const deadlineMs = order.pickup_deadline ? new Date(order.pickup_deadline).getTime() - now : null;

  return (
    <li
      className="grid gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm"
      aria-label={`Order ${order.token_label ?? ""}`}
      data-testid="kitchen-order"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-2xl font-black tracking-tight text-primary">{order.token_label}</p>
          <p className="text-sm font-medium">{order.customer_name ?? "Customer"}</p>
        </div>
        <div className="grid justify-items-end gap-1 text-right text-xs text-muted">
          {order.pickup_slot ? (
            <span>
              {formatSlot(order.pickup_slot.starts_at, order.pickup_slot.ends_at, timeZone)}
            </span>
          ) : (
            <Badge tone="warning">
              Deal{order.deal_source_token ? ` · was ${order.deal_source_token}` : ""}
            </Badge>
          )}
          <span>{formatPaise(order.total_paise)}</span>
        </div>
      </div>
      <ul className="grid gap-0.5 text-sm">
        {order.items.map((item) => (
          <li key={item.id}>
            <span className="font-semibold">{item.quantity} ×</span> {item.item_name}
            {item.is_packaged && <span className="text-xs text-muted"> · packaged</span>}
          </li>
        ))}
      </ul>

      {order.status === "ready_for_pickup" && deadlineMs !== null && (
        <p
          className={`text-sm font-medium ${deadlineMs < 5 * 60_000 ? "text-danger" : "text-muted"}`}
        >
          {deadlineMs > 0
            ? `Collect by ${formatTime(order.pickup_deadline as string, timeZone)} · ${formatTimeLeft(deadlineMs)} left`
            : "Past the pickup deadline: becomes a no-show within a minute"}
        </p>
      )}

      {stopping && stopTo ? (
        <ReasonForm
          label={stopTo === "rejected" ? "Reject order" : "Cancel order"}
          busy={move.isPending}
          onSubmit={(reason) => move.mutate({ to: stopTo, reason })}
          onCancel={() => setStopping(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {next && allowed(next.to) && (
            <Button busy={move.isPending} onClick={() => move.mutate({ to: next.to })}>
              {next.label}
            </Button>
          )}
          {stopTo && (
            <Button variant="danger" onClick={() => setStopping(true)}>
              {stopTo === "rejected" ? "Reject" : "Cancel"}
            </Button>
          )}
        </div>
      )}
      {order.status === "ready_for_pickup" && <PickupCodeForm order={order} onDone={onDone} />}
      <InlineError error={move.error} />
    </li>
  );
}

/** Scanner input: a USB/Bluetooth QR scanner "types" the Digital Food Pass payload here. */
function PickupScanner({ onDone }: { onDone: (msg: string) => void }) {
  const { api } = useRuntime();
  const queryClient = useQueryClient();
  const id = useId();
  const [value, setValue] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const verify = useMutation({
    mutationFn: (pass: { orderId: string; code: string }) =>
      api.verifyPickup(pass.orderId, pass.code),
    onSuccess: (order) => {
      setValue("");
      onDone(`${order.token_label ?? "Order"} collected`);
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.queue(order.outlet.id) });
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const pass = parsePickupQr(value);
    if (!pass) {
      setHint("That isn't a CampusCart pickup QR. Type the code on the order's card instead.");
      return;
    }
    setHint(null);
    verify.mutate(pass);
  }
  return (
    <form className="grid gap-2" onSubmit={submit} aria-label="Scan pickup pass">
      <label htmlFor={id} className="text-sm font-medium">
        Scan a pickup QR
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          placeholder="Focus here and scan"
          className="h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3"
        />
        <Button type="submit" busy={verify.isPending} className="shrink-0">
          Verify
        </Button>
      </div>
      {hint && <p className="text-sm text-warn">{hint}</p>}
      <InlineError error={verify.error} />
    </form>
  );
}

/**
 * The live kitchen board: New → Accepted → Preparing → Ready, with pickup verification. Actions
 * offered come from the server's transition table; the server re-checks each one.
 */
export function KitchenBoard({ outletId, timeZone }: { outletId: string; timeZone: string }) {
  const queue = useStaffQueue(outletId);
  const now = useNow();
  const [announcement, setAnnouncement] = useState("");

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 sm:max-w-md">
          <PickupScanner onDone={setAnnouncement} />
        </div>
        <LiveIndicator status={queue.live} />
      </div>
      <p aria-live="polite" className="text-sm font-semibold text-ok" data-testid="announcement">
        {announcement}
      </p>
      {queue.isPending ? (
        <Loading label="Loading orders" />
      ) : queue.isError ? (
        <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((column) => {
            const orders = queue.data.filter((o) => o.status === column.status);
            return (
              <section
                key={column.status}
                aria-labelledby={`col-${column.status}`}
                className="grid content-start gap-3 rounded-2xl bg-surface-2 p-3"
              >
                <h2 id={`col-${column.status}`} className="flex justify-between font-semibold">
                  {column.title}
                  <span className="text-muted">{orders.length}</span>
                </h2>
                {orders.length === 0 ? (
                  <p className="text-sm text-muted">{column.empty}</p>
                ) : (
                  <ul className="grid gap-3">
                    {orders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        timeZone={timeZone}
                        now={now}
                        onDone={setAnnouncement}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

const DEAL_TONE: Record<
  StaffDeal["status"],
  "success" | "warning" | "info" | "neutral" | "danger"
> = {
  available: "success",
  reserved: "warning",
  sold: "info",
  expired: "neutral",
  withdrawn: "danger",
};
const DEAL_LABEL: Record<StaffDeal["status"], string> = {
  available: "On sale",
  reserved: "Being bought",
  sold: "Sold",
  expired: "Unsold",
  withdrawn: "Withdrawn",
};

function DealRow({ deal, timeZone, now }: { deal: StaffDeal; timeZone: string; now: number }) {
  const { api } = useRuntime();
  const queryClient = useQueryClient();
  const [withdrawing, setWithdrawing] = useState(false);
  const withdraw = useMutation({
    mutationFn: (reason: string) => api.withdrawDeal(deal.id, reason),
    onSuccess: () => {
      setWithdrawing(false);
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.deals(deal.outlet_id) });
    },
  });
  const left = new Date(deal.expires_at).getTime() - now;
  return (
    <li
      className="grid gap-2 rounded-xl border border-line bg-surface p-4"
      data-testid="staff-deal"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          From {deal.source_token ?? "an order"}
          {deal.buyer_token && <span className="text-primary"> → {deal.buyer_token}</span>}
        </p>
        <Badge tone={DEAL_TONE[deal.status]}>{DEAL_LABEL[deal.status]}</Badge>
      </div>
      <p className="text-sm">
        {deal.items.map((i) => `${i.quantity} × ${i.item_name}`).join(", ")} ·{" "}
        <strong>{formatPaise(deal.price_paise)}</strong>{" "}
        <s className="text-muted">{formatPaise(deal.original_price_paise)}</s> (
        {deal.discount_percent}% off)
      </p>
      <p className="text-xs text-muted">
        Listed {formatTime(deal.listed_at, timeZone)}
        {deal.status === "available" && left > 0 && ` · ${formatTimeLeft(left)} left on sale`}
        {deal.close_reason && ` · ${deal.close_reason}`}
      </p>
      {deal.status === "available" &&
        (withdrawing ? (
          <ReasonForm
            label="Withdraw deal"
            busy={withdraw.isPending}
            onSubmit={(reason) => withdraw.mutate(reason)}
            onCancel={() => setWithdrawing(false)}
          />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="justify-self-start"
            onClick={() => setWithdrawing(true)}
          >
            Withdraw
          </Button>
        ))}
      <InlineError error={withdraw.error} />
    </li>
  );
}

/**
 * Uncollected orders and the deals they became (D-19): packaged items were restocked, prepared
 * food is on sale at a discount, and a bought deal shows the new token at the counter.
 */
export function DealsPanel({ outletId, timeZone }: { outletId: string; timeZone: string }) {
  const deals = useStaffDeals(outletId);
  const now = useNow(1000);
  if (deals.isPending) return <Loading label="Loading deals" />;
  if (deals.isError) return <ErrorState error={deals.error} onRetry={() => void deals.refetch()} />;
  if (deals.data.length === 0)
    return (
      <EmptyState title="No uncollected orders in the last 24 hours">
        When a ready order isn&apos;t collected by its deadline, its prepared food appears here as a
        discounted deal.
      </EmptyState>
    );
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {deals.data.map((deal) => (
        <DealRow key={deal.id} deal={deal} timeZone={timeZone} now={now} />
      ))}
    </ul>
  );
}
