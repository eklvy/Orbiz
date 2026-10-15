"use client";

import { formatPaise, parseRupeesToPaise, queryKeys } from "@campuscart/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { EmptyState, ErrorState, InlineError, LoadingList } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";

function NewSplit({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [total, setTotal] = useState("");
  const [rows, setRows] = useState([{ email: "", amount: "" }]);
  const [error, setError] = useState<string>();
  const create = useMutation({
    mutationFn: (body: Parameters<ReturnType<typeof getApi>["createSplit"]>[0]) =>
      getApi().createSplit(body),
    onSuccess: onDone,
  });
  return (
    <form
      aria-label="New bill split"
      className="grid gap-3 rounded-2xl border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const totalPaise = parseRupeesToPaise(total);
        const shares = rows.map((r) => ({
          email: r.email.trim(),
          amount_paise: parseRupeesToPaise(r.amount),
        }));
        if (
          !title.trim() ||
          totalPaise === null ||
          shares.some((s) => !s.email || s.amount_paise === null)
        ) {
          setError("Fill in the title, the total and each person's email and amount");
          return;
        }
        setError(undefined);
        create.mutate({
          title: title.trim(),
          total_paise: totalPaise,
          shares: shares.map((s) => ({ email: s.email, amount_paise: s.amount_paise as number })),
        });
      }}
    >
      <p className="font-semibold">Split a bill</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="What for"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Field
          label="Total paid (₹)"
          inputMode="decimal"
          value={total}
          onChange={(e) => setTotal(e.target.value)}
        />
      </div>
      {rows.map((row, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem]">
          <Field
            label={`Person ${i + 1} email`}
            type="email"
            value={row.email}
            onChange={(e) =>
              setRows((r) => r.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))
            }
          />
          <Field
            label={`Person ${i + 1} owes (₹)`}
            inputMode="decimal"
            value={row.amount}
            onChange={(e) =>
              setRows((r) => r.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
            }
          />
        </div>
      ))}
      {rows.length < 10 && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => setRows((r) => [...r, { email: "", amount: "" }])}
        >
          Add a person
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <InlineError error={create.error} />
      <Button type="submit" busy={create.isPending} className="justify-self-start">
        Create split
      </Button>
    </form>
  );
}

export default function SplitsPage() {
  const auth = useRequireAuth();
  const queryClient = useQueryClient();
  const splits = useQuery({
    queryKey: queryKeys.splits,
    queryFn: () => getApi().listSplits(),
    enabled: Boolean(auth.session),
  });
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const act = useMutation({
    mutationFn: (v: { id: string; action: "settle" | "cancel" }) =>
      v.action === "settle" ? getApi().settleSplit(v.id) : getApi().cancelSplit(v.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.splits });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    },
  });
  return (
    <div className="mx-auto grid max-w-2xl gap-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bill splits</h1>
          <p className="text-sm text-muted">
            Paid for friends? Record it; they settle from their wallets.
          </p>
        </div>
        {!creating && <Button onClick={() => setCreating(true)}>Split a bill</Button>}
      </div>
      {creating && (
        <NewSplit
          onDone={() => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: queryKeys.splits });
          }}
        />
      )}
      <InlineError error={act.error} />
      {splits.isPending ? (
        <LoadingList label="Loading splits" rows={2} />
      ) : splits.isError ? (
        <ErrorState error={splits.error} onRetry={() => void splits.refetch()} />
      ) : splits.data.length === 0 ? (
        <EmptyState title="No bill splits yet" />
      ) : (
        <ul className="grid gap-2">
          {splits.data.map((s) => {
            const myShare = s.shares.find((sh) => sh.user_id === me.data?.id && !sh.paid);
            return (
              <li
                key={s.id}
                className="grid gap-2 rounded-xl border border-line bg-surface p-4"
                aria-label={s.title}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">
                    {s.title} · {formatPaise(s.total_paise)}
                  </p>
                  <Badge tone={s.settled_at ? "success" : s.cancelled_at ? "neutral" : "warning"}>
                    {s.settled_at ? "Settled" : s.cancelled_at ? "Cancelled" : "Open"}
                  </Badge>
                </div>
                <p className="text-sm text-muted">
                  Paid by {s.i_am_creator ? "you" : (s.creator_name ?? "a friend")}
                </p>
                <ul className="text-sm">
                  {s.shares.map((sh) => (
                    <li key={sh.user_id}>
                      {sh.full_name ?? "Someone"} owes {formatPaise(sh.amount_paise)} ·{" "}
                      {sh.paid ? "settled" : "not yet"}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  {myShare && !s.cancelled_at && (
                    <Button
                      size="sm"
                      busy={act.isPending}
                      onClick={() => act.mutate({ id: s.id, action: "settle" })}
                    >
                      Settle my share from wallet
                    </Button>
                  )}
                  {s.i_am_creator && !s.settled_at && !s.cancelled_at && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: s.id, action: "cancel" })}
                    >
                      Cancel split
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
