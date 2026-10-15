"use client";

import {
  formatPaise,
  formatTime,
  staffQueryKeys,
  subscribeToTable,
  type ManagedOutlet,
  type Schemas,
} from "@campuscart/client";
import {
  Badge,
  Button,
  ErrorState,
  Field,
  InlineError,
  Loading,
  SelectField,
  Stat,
  useCurrentOutlet,
  useRuntime,
} from "@campuscart/staff-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useManagedOutlet } from "@/components/hooks";

const BREAKS = [10, 15, 30, 45, 60, 90, 120];

function StatusControl({ outlet }: { outlet: ManagedOutlet }) {
  const { api } = useRuntime();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"on_break" | "closed" | null>(null);
  const [minutes, setMinutes] = useState(15);
  const [reason, setReason] = useState("");
  const change = useMutation({
    mutationFn: (body: Schemas["OutletStatusUpdate"]) => api.setStatus(outlet.id, body),
    onSuccess: () => {
      setMode(null);
      setReason("");
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.managedOutlet(outlet.id) });
      void queryClient.invalidateQueries({ queryKey: ["outlets"] });
    },
  });
  const label = { open: "Open", on_break: "On a break", closed: "Closed" }[outlet.status];
  const tone = { open: "success", on_break: "warning", closed: "danger" } as const;

  return (
    <section
      aria-labelledby="status-heading"
      className="grid gap-4 rounded-2xl border border-line bg-surface p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="status-heading" className="text-lg font-semibold">
          Cafe status
        </h2>
        <span data-testid="outlet-status">
          <Badge tone={tone[outlet.status]}>{label}</Badge>
        </span>
      </div>
      {outlet.status !== "open" && (
        <p className="text-sm text-muted">
          {outlet.status === "on_break" && outlet.break_until
            ? `Back at ${formatTime(outlet.break_until, outlet.timezone)}. `
            : ""}
          {outlet.status_reason ? `Students see: “${outlet.status_reason}”` : "No public reason."}
          {" New orders are blocked until you reopen."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={outlet.status === "open"}
          busy={change.isPending && change.variables?.status === "open"}
          onClick={() => change.mutate({ status: "open" })}
        >
          Open
        </Button>
        <Button variant="secondary" onClick={() => setMode("on_break")}>
          Take a break
        </Button>
        <Button variant="danger" onClick={() => setMode("closed")}>
          Close cafe
        </Button>
      </div>
      {mode && (
        <form
          className="grid gap-3 rounded-xl bg-surface-2 p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate(
              mode === "on_break"
                ? { status: "on_break", break_minutes: minutes, reason: reason.trim() || null }
                : { status: "closed", reason: reason.trim() || null },
            );
          }}
        >
          {mode === "on_break" && (
            <SelectField
              label="Break length"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            >
              {BREAKS.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </SelectField>
          )}
          <Field
            label="Reason shown to students (optional)"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" busy={change.isPending}>
              {mode === "on_break" ? "Start break" : "Close now"}
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Back
            </Button>
          </div>
        </form>
      )}
      <InlineError error={change.error} />
    </section>
  );
}

function TodaySummary({ outletId }: { outletId: string }) {
  const { api, supabase } = useRuntime();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeToTable(supabase, {
        table: "orders",
        filter: `outlet_id=eq.${outletId}`,
        onChange: () =>
          void queryClient.invalidateQueries({ queryKey: staffQueryKeys.summary(outletId) }),
      }),
    [supabase, outletId, queryClient],
  );
  const summary = useQuery({
    queryKey: staffQueryKeys.summary(outletId),
    queryFn: () => api.summary(outletId),
    refetchInterval: 60_000,
  });
  if (summary.isPending) return <Loading label="Loading today's figures" />;
  if (summary.isError)
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  const s = summary.data;
  const active =
    (s.orders_by_status.placed ?? 0) +
    (s.orders_by_status.confirmed ?? 0) +
    (s.orders_by_status.preparing ?? 0) +
    (s.orders_by_status.ready_for_pickup ?? 0);
  return (
    <section aria-labelledby="today-heading" className="grid gap-3">
      <h2 id="today-heading" className="text-lg font-semibold">
        Today ({s.business_date})
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Paid orders" value={s.paid_orders} hint={`${active} still in progress`} />
        <Stat label="Paid today" value={formatPaise(s.gross_paid_paise)} hint="Before refunds" />
        <Stat
          label="Refunds owed"
          value={formatPaise(s.refunds_owed_paise)}
          hint={`${s.pending_refund_requests} request(s) to review`}
        />
        <Stat
          label="Not collected"
          value={s.no_shows}
          hint={`Deals sold ${s.deals.sold} (${formatPaise(s.deal_sales_paise)}) · unsold ${s.deals.expired}`}
        />
      </div>
    </section>
  );
}

function Fleet() {
  const { api, supabase } = useRuntime();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeToTable(supabase, {
        table: "outlets",
        onChange: () => void queryClient.invalidateQueries({ queryKey: ["outlets"] }),
      }),
    [supabase, queryClient],
  );
  const outlets = useQuery({ queryKey: ["outlets"], queryFn: () => api.listOutlets() });
  if (outlets.isPending) return <Loading label="Loading campus outlets" />;
  if (outlets.isError)
    return <ErrorState error={outlets.error} onRetry={() => void outlets.refetch()} />;
  return (
    <section aria-labelledby="fleet-heading" className="grid gap-3">
      <div>
        <h2 id="fleet-heading" className="text-lg font-semibold">
          Every outlet on campus
        </h2>
        <p className="text-sm text-muted">
          Wait and crowd come from real order load (no seat sensors).
        </p>
      </div>
      {/* Focusable so keyboard users can scroll the table sideways on narrow screens. */}
      <div
        className="overflow-x-auto rounded-xl border border-line bg-surface"
        tabIndex={0}
        role="region"
        aria-label="Outlet status table"
      >
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Outlet</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Orders in queue</th>
              <th className="px-4 py-2 font-medium">Est. wait</th>
              <th className="px-4 py-2 font-medium">Crowd</th>
            </tr>
          </thead>
          <tbody>
            {outlets.data.map((o) => (
              <tr key={o.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium">{o.name}</td>
                <td className="px-4 py-2">
                  {{ open: "Open", on_break: "On a break", closed: "Closed" }[o.status]}
                </td>
                <td className="px-4 py-2">{o.queue.active_orders}</td>
                <td className="px-4 py-2">~{o.queue.estimated_wait_minutes} min</td>
                <td className="px-4 py-2 capitalize">{o.queue.crowd_level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function OverviewPage() {
  const { outlet } = useCurrentOutlet();
  const managed = useManagedOutlet();
  return (
    <div className="grid gap-8">
      <h1 className="text-2xl font-bold tracking-tight">{outlet.name}</h1>
      {managed.isPending ? (
        <Loading label="Loading outlet" />
      ) : managed.isError ? (
        <ErrorState error={managed.error} onRetry={() => void managed.refetch()} />
      ) : (
        <StatusControl outlet={managed.data} />
      )}
      <TodaySummary outletId={outlet.id} />
      <Fleet />
    </div>
  );
}
