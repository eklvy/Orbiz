"use client";

import { formatPaise, staffQueryKeys, type Schemas } from "@campuscart/client";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  Loading,
  useCurrentOutlet,
  useRuntime,
} from "@campuscart/staff-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

const STATUS = {
  requested: ["info", "New request"],
  accepted: ["warning", "Accepted, awaiting payment"],
  declined: ["danger", "Declined"],
  paid: ["success", "Paid"],
  cancelled: ["neutral", "Cancelled"],
  fulfilled: ["success", "Delivered"],
} as const;

function Booking({ party }: { party: Schemas["Party"] }) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  const noteId = useId();
  const [note, setNote] = useState("");
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: staffQueryKeys.parties(outlet.id) });
  const decide = useMutation({
    mutationFn: (accept: boolean) => api.decideParty(party.id, accept, note.trim() || undefined),
    onSuccess: refresh,
  });
  const fulfil = useMutation({ mutationFn: () => api.fulfilParty(party.id), onSuccess: refresh });
  return (
    <li
      className="grid gap-2 rounded-xl border border-line bg-surface p-4"
      aria-label={party.event_name}
      data-testid="manager-party"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {party.event_name} · {party.customer_name ?? "Student"}
        </p>
        <Badge tone={STATUS[party.status][0]}>{STATUS[party.status][1]}</Badge>
      </div>
      <p className="text-sm text-muted">
        {new Date(party.event_at).toLocaleString("en-IN", { timeZone: outlet.timezone })} ·{" "}
        {party.headcount} people
      </p>
      <p className="text-sm">
        {party.items.map((i) => `${i.quantity} × ${i.item_name}`).join(", ")}
      </p>
      {party.notes && <p className="text-sm">Notes: “{party.notes}”</p>}
      <p className="font-semibold">{formatPaise(party.total_paise)}</p>
      {party.status === "requested" && (
        <div className="grid gap-2">
          <label htmlFor={noteId} className="text-sm font-medium">
            Note for the student (needed to decline)
          </label>
          <input
            id={noteId}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface px-3"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              busy={decide.isPending && decide.variables === true}
              onClick={() => decide.mutate(true)}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={!note.trim()}
              busy={decide.isPending && decide.variables === false}
              onClick={() => decide.mutate(false)}
            >
              Decline
            </Button>
          </div>
        </div>
      )}
      {party.status === "paid" && (
        <Button
          size="sm"
          variant="secondary"
          className="justify-self-start"
          busy={fulfil.isPending}
          onClick={() => fulfil.mutate()}
        >
          Mark delivered
        </Button>
      )}
      <InlineError error={decide.error ?? fulfil.error} />
    </li>
  );
}

export default function PartiesPage() {
  const { outlet } = useCurrentOutlet();
  const { api } = useRuntime();
  const parties = useQuery({
    queryKey: staffQueryKeys.parties(outlet.id),
    queryFn: () => api.parties(outlet.id),
    refetchInterval: 30_000,
  });
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Party bookings</h1>
        <p className="text-sm text-muted">
          Catering requests for events. Students pay from their wallets after you accept.
        </p>
      </div>
      {parties.isPending ? (
        <Loading label="Loading bookings" />
      ) : parties.isError ? (
        <ErrorState error={parties.error} onRetry={() => void parties.refetch()} />
      ) : parties.data.length === 0 ? (
        <EmptyState title="No upcoming bookings" />
      ) : (
        <ul className="grid gap-2">
          {parties.data.map((p) => (
            <Booking key={p.id} party={p} />
          ))}
        </ul>
      )}
    </div>
  );
}
