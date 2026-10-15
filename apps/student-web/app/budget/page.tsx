"use client";

import { formatPaise, paiseToRupeeInput, parseRupeesToPaise, queryKeys } from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { EmptyState, ErrorState, InlineError, Skeleton } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useBudget } from "@/lib/hooks";

const STATUS = {
  ok: { tone: "success", label: "On track" },
  near: { tone: "warning", label: "Close to your limit" },
  over: { tone: "danger", label: "Over your limit" },
} as const;

function Meter({ label, spent, limit }: { label: string; spent: number; limit: number }) {
  const percent = Math.round((spent / limit) * 100);
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span>
          {formatPaise(spent)} of {formatPaise(limit)}
        </span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label={`${label} spending`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
      >
        <div
          className={`h-full ${percent > 100 ? "bg-danger" : percent >= 80 ? "bg-warn" : "bg-primary"}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

export default function BudgetPage() {
  const auth = useRequireAuth();
  const queryClient = useQueryClient();
  const budget = useBudget();
  const [monthly, setMonthly] = useState<string>();
  const [daily, setDaily] = useState<string>();
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: (body: { monthly_limit_paise: number; daily_limit_paise: number | null }) =>
      getApi().setBudget({ ...body, warn_at_percent: 80 }),
    onSuccess: (b) => queryClient.setQueryData(queryKeys.budget, b),
  });
  const clear = useMutation({
    mutationFn: () => getApi().clearBudget(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.budget }),
  });
  if (!auth.ready || budget.isPending) return <Skeleton className="h-64" />;
  if (budget.isError)
    return <ErrorState error={budget.error} onRetry={() => void budget.refetch()} />;
  const b = budget.data;
  const monthlyValue =
    monthly ?? (b.monthly_limit_paise ? paiseToRupeeInput(b.monthly_limit_paise) : "");
  const dailyValue = daily ?? (b.daily_limit_paise ? paiseToRupeeInput(b.daily_limit_paise) : "");

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Food budget</h1>
      <section className="grid gap-4 rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p>
            <span className="text-3xl font-black tracking-tight" data-testid="month-spent">
              {formatPaise(b.month_spent_paise)}
            </span>{" "}
            <span className="text-muted">
              spent this month · {formatPaise(b.today_spent_paise)} today
            </span>
          </p>
          {b.month_status && (
            <Badge tone={STATUS[b.month_status].tone}>{STATUS[b.month_status].label}</Badge>
          )}
        </div>
        {b.monthly_limit_paise && (
          <Meter label="This month" spent={b.month_spent_paise} limit={b.monthly_limit_paise} />
        )}
        {b.daily_limit_paise && (
          <Meter label="Today" spent={b.today_spent_paise} limit={b.daily_limit_paise} />
        )}
        <p className="text-xs text-muted">
          Counts orders you&apos;ve paid for (refunded ones excluded). Group shares and party
          bookings aren&apos;t included yet.
        </p>
      </section>

      <form
        className="grid gap-3 rounded-2xl border border-line bg-surface p-5 sm:grid-cols-2"
        aria-label="Set your budget"
        onSubmit={(e) => {
          e.preventDefault();
          const m = parseRupeesToPaise(monthlyValue);
          const d = dailyValue.trim() ? parseRupeesToPaise(dailyValue) : null;
          if (m === null || m < 10000 || (dailyValue.trim() && (d === null || d < 1000))) {
            setError("Monthly ₹100 or more; daily ₹10 or more (or leave daily empty)");
            return;
          }
          setError(undefined);
          save.mutate({ monthly_limit_paise: m, daily_limit_paise: d });
        }}
      >
        <Field
          label="Monthly limit (₹)"
          inputMode="decimal"
          value={monthlyValue}
          error={error}
          onChange={(e) => setMonthly(e.target.value)}
        />
        <Field
          label="Daily limit (₹, optional)"
          inputMode="decimal"
          value={dailyValue}
          onChange={(e) => setDaily(e.target.value)}
        />
        <p className="text-xs text-muted sm:col-span-2">
          You&apos;ll see a warning from 80% of a limit.
        </p>
        <InlineError error={save.error ?? clear.error} />
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" busy={save.isPending}>
            Save budget
          </Button>
          {b.monthly_limit_paise && (
            <Button variant="ghost" onClick={() => clear.mutate()} busy={clear.isPending}>
              Remove budget
            </Button>
          )}
        </div>
      </form>

      <section aria-labelledby="breakdown-heading" className="grid gap-2">
        <h2 id="breakdown-heading" className="font-semibold">
          This month by category
        </h2>
        {b.by_category.length === 0 ? (
          <EmptyState title="Nothing spent this month" />
        ) : (
          <ul className="grid gap-1 text-sm">
            {b.by_category.map((c) => (
              <li key={c.category} className="flex justify-between rounded-lg bg-surface px-3 py-2">
                <span>{c.category}</span>
                <span className="font-semibold">
                  {c.paise < 0 ? `−${formatPaise(-c.paise)}` : formatPaise(c.paise)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
