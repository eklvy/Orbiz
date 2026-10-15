"use client";

import { formatPaise, queryKeys, type Schemas } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { getApi } from "@/lib/api";
import { Button } from "./ui/button";
import { InlineError } from "./ui/states";

const STATUS_TEXT: Record<Schemas["RefundRequestSummary"]["status"], string> = {
  pending: "Your refund request is waiting for the outlet manager.",
  approved: "Refund approved. It's recorded as owed to you; payouts arrive in a later release.",
  declined: "The outlet declined your refund request.",
};

/**
 * Ask for a refund on a collected order (the server allows it for 24 hours after pickup), and
 * show the manager's decision. The server decides eligibility; this only offers the form.
 */
export function RefundRequest({ order }: { order: Schemas["OrderDetail"] }) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  // Read once per visit; the server enforces the real 24-hour window.
  const [openedAt] = useState(() => Date.now());
  const submit = useMutation({
    mutationFn: () => getApi().requestRefund(order.id, reason.trim()),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.order(order.id), updated);
      setOpen(false);
    },
  });

  const request = order.refund_request;
  if (request) {
    return (
      <section
        aria-label="Refund request"
        data-testid="refund-request"
        className="rounded-2xl border border-line bg-surface p-5 text-sm"
      >
        <p className="font-semibold">Refund request · {formatPaise(request.amount_paise)}</p>
        <p className="mt-1">{STATUS_TEXT[request.status]}</p>
        {request.decision_note && <p className="mt-1 text-muted">Note: {request.decision_note}</p>}
        <p className="mt-1 text-muted">You said: {request.reason}</p>
      </section>
    );
  }

  const eligible =
    order.status === "completed" &&
    order.refund_status === "none" &&
    order.completed_at !== null &&
    openedAt - new Date(order.completed_at).getTime() < 24 * 60 * 60 * 1000;
  if (!eligible) return null;

  if (!open) {
    return (
      <Button variant="secondary" className="justify-self-start" onClick={() => setOpen(true)}>
        Something wrong? Ask for a refund
      </Button>
    );
  }
  const tooShort = reason.trim().length < 5;
  return (
    <form
      aria-label="Ask for a refund"
      className="grid gap-3 rounded-2xl border border-line bg-surface p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!tooShort) submit.mutate();
      }}
    >
      <label htmlFor={reasonId} className="text-sm font-medium">
        What went wrong?
      </label>
      <textarea
        id={reasonId}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={500}
        rows={3}
        required
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink"
      />
      <p className="text-xs text-muted">
        The outlet manager reviews it. Requests are open for 24 hours after pickup.
      </p>
      <InlineError error={submit.error} />
      <div className="flex gap-2">
        <Button type="submit" busy={submit.isPending} disabled={tooShort}>
          Send request
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
