"use client";

import { formatPaise, staffQueryKeys, subscribeToTable, type Schemas } from "@campuscart/client";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  Loading,
  Stat,
  useCurrentOutlet,
  useRuntime,
} from "@campuscart/staff-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

type Entry = Schemas["RefundRequestEntry"];

function when(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PendingRequest({ entry, timeZone }: { entry: Entry; timeZone: string }) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  const noteId = useId();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (body: Schemas["RefundDecision"]) => api.decideRefund(entry.id, body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.refunds(outlet.id) }),
  });
  return (
    <li
      className="grid gap-3 rounded-xl border border-line bg-surface p-4"
      aria-label={`Refund request for ${entry.order_token ?? "order"}`}
      data-testid="refund-request"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">
          {entry.order_token} · {entry.customer_name ?? "Student"}
        </p>
        <p className="text-sm text-muted">Asked {when(entry.created_at, timeZone)}</p>
      </div>
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">“{entry.reason}”</p>
      {declining ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) decide.mutate({ decision: "decline", note: note.trim() });
          }}
        >
          <label htmlFor={noteId} className="text-sm font-medium">
            Note for the student
          </label>
          <input
            id={noteId}
            value={note}
            maxLength={300}
            required
            onChange={(e) => setNote(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface px-3"
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="danger"
              size="sm"
              busy={decide.isPending}
              disabled={!note.trim()}
            >
              Decline request
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDeclining(false)}>
              Back
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button busy={decide.isPending} onClick={() => decide.mutate({ decision: "approve" })}>
            Approve {formatPaise(entry.amount_paise)} refund
          </Button>
          <Button variant="secondary" onClick={() => setDeclining(true)}>
            Decline
          </Button>
        </div>
      )}
      <InlineError error={decide.error} />
    </li>
  );
}

export default function RefundsPage() {
  const { outlet } = useCurrentOutlet();
  const { api, supabase } = useRuntime();
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.refunds(outlet.id) });
    const offs = [
      subscribeToTable(supabase, {
        table: "refund_requests",
        filter: `outlet_id=eq.${outlet.id}`,
        onChange: refresh,
        onResync: refresh,
      }),
      subscribeToTable(supabase, {
        table: "orders",
        filter: `outlet_id=eq.${outlet.id}`,
        onChange: refresh,
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [supabase, outlet.id, queryClient]);
  const desk = useQuery({
    queryKey: staffQueryKeys.refunds(outlet.id),
    queryFn: () => api.refunds(outlet.id),
  });
  const approveAll = useMutation({
    mutationFn: () => api.approveAllRefunds(outlet.id),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.refunds(outlet.id) }),
  });

  if (desk.isPending) return <Loading label="Loading refunds" />;
  if (desk.isError) return <ErrorState error={desk.error} onRetry={() => void desk.refetch()} />;
  const d = desk.data;
  const median = d.median_resolution_minutes_7d;
  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Refunds &amp; cancellations</h1>
        <p className="text-sm text-muted">
          Approving records the refund as owed. Money is paid out once online payments are live (a
          later release). Uncollected orders are not refundable.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Waiting for you" value={d.pending.length} />
        <Stat
          label="Owed to students"
          value={formatPaise(
            d.owed.reduce((sum, o) => sum + o.amount_paise, 0) +
              d.decided
                .filter((e) => e.status === "approved")
                .reduce((sum, e) => sum + e.amount_paise, 0),
          )}
          hint="Approved requests plus kitchen cancellations (last 30 days)"
        />
        <Stat
          label="Median time to decide"
          value={median === null || median === undefined ? "—" : `${median} min`}
          hint="Last 7 days"
        />
      </div>

      <section aria-labelledby="pending-heading" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pending-heading" className="text-lg font-semibold">
            Pending requests
          </h2>
          {d.pending.length > 1 && (
            <Button
              variant="secondary"
              busy={approveAll.isPending}
              onClick={() =>
                window.confirm(`Approve all ${d.pending.length} pending refunds?`) &&
                approveAll.mutate()
              }
            >
              Approve all pending
            </Button>
          )}
        </div>
        <InlineError error={approveAll.error} />
        {d.pending.length === 0 ? (
          <EmptyState title="No refund requests waiting" />
        ) : (
          <ul className="grid gap-3">
            {d.pending.map((entry) => (
              <PendingRequest key={entry.id} entry={entry} timeZone={outlet.timezone} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="owed-heading" className="grid gap-3">
        <h2 id="owed-heading" className="text-lg font-semibold">
          Owed automatically
        </h2>
        <p className="text-sm text-muted">Paid orders that were cancelled or rejected.</p>
        {d.owed.length === 0 ? (
          <EmptyState title="Nothing owed" />
        ) : (
          <ul className="grid gap-2">
            {d.owed.map((o) => (
              <li
                key={o.order_id}
                className="flex flex-wrap justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm"
              >
                <span>
                  <strong>{o.order_token}</strong> · {o.customer_name ?? "Student"} ·{" "}
                  {o.order_status === "rejected" ? "Rejected" : "Cancelled"}
                  {o.cancel_reason ? ` (“${o.cancel_reason}”)` : ""}
                </span>
                <span className="font-semibold">{formatPaise(o.amount_paise)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-heading" className="grid gap-3">
        <h2 id="history-heading" className="text-lg font-semibold">
          Recent decisions
        </h2>
        {d.decided.length === 0 ? (
          <EmptyState title="No decisions yet" />
        ) : (
          <ul className="grid gap-2">
            {d.decided.map((e) => (
              <li
                key={e.id}
                className="grid gap-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{e.order_token}</strong> · {e.customer_name ?? "Student"} ·{" "}
                    {formatPaise(e.amount_paise)}
                  </span>
                  <Badge tone={e.status === "approved" ? "success" : "danger"}>
                    {e.status === "approved" ? "Approved" : "Declined"}
                  </Badge>
                </div>
                <span className="text-muted">
                  “{e.reason}”{e.decision_note ? ` · Note: ${e.decision_note}` : ""}
                  {e.decided_at ? ` · ${when(e.decided_at, outlet.timezone)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
