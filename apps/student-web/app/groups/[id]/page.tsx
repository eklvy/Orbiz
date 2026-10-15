"use client";

import {
  formatDayLabel,
  formatPaise,
  formatSlot,
  queryKeys,
  type Schemas,
} from "@campuscart/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Countdown } from "@/components/countdown";
import { LiveIndicator } from "@/components/live-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, InlineError, Skeleton } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useGroup, useMenu, useWallet } from "@/lib/hooks";

type Group = Schemas["Group"];

function SplitEditor({ group }: { group: Group }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState(group.split_mode);
  const [percents, setPercents] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      group.members.map((m) => [
        m.user_id,
        String(m.percent ?? Math.floor(100 / group.members.length)),
      ]),
    ),
  );
  const save = useMutation({
    mutationFn: () =>
      getApi().setGroupSplit(group.id, {
        mode,
        ...(mode === "percent"
          ? {
              percents: Object.fromEntries(
                Object.entries(percents).map(([k, v]) => [k, Number(v) || 0]),
              ),
            }
          : {}),
      }),
    onSuccess: (g) => queryClient.setQueryData(queryKeys.group(group.id), g),
  });
  const total = Object.values(percents).reduce((sum, v) => sum + (Number(v) || 0), 0);
  return (
    <fieldset className="grid gap-2 rounded-xl border border-line bg-surface p-4">
      <legend className="px-1 text-sm font-semibold">How to split</legend>
      <div className="flex flex-wrap gap-3 text-sm">
        {(
          [
            ["by_dish", "Each pays for their own dishes"],
            ["equal", "Equally"],
            ["percent", "By percentage"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="split"
              checked={mode === value}
              onChange={() => setMode(value)}
              className="accent-primary"
            />
            {label}
          </label>
        ))}
      </div>
      {mode === "percent" && (
        <div className="grid gap-2 sm:grid-cols-2">
          {group.members.map((m) => (
            <label key={m.user_id} className="flex items-center justify-between gap-2 text-sm">
              {m.full_name ?? "Member"}
              <input
                type="number"
                min={0}
                max={100}
                value={percents[m.user_id] ?? "0"}
                onChange={(e) => setPercents((p) => ({ ...p, [m.user_id]: e.target.value }))}
                aria-label={`Percent for ${m.full_name ?? "member"}`}
                className="h-9 w-20 rounded-lg border border-line bg-surface px-2"
              />
            </label>
          ))}
          <p className={`text-sm ${total === 100 ? "text-muted" : "text-danger"}`}>
            Total {total}% (must be 100%)
          </p>
        </div>
      )}
      <InlineError error={save.error} />
      <Button
        size="sm"
        variant="secondary"
        className="justify-self-start"
        busy={save.isPending}
        onClick={() => save.mutate()}
      >
        Save split
      </Button>
    </fieldset>
  );
}

function AddItems({ group, me }: { group: Group; me: Schemas["GroupMember"] }) {
  const queryClient = useQueryClient();
  const menu = useMenu(group.outlet.id, {});
  const [member, setMember] = useState(me.user_id);
  const setItem = useMutation({
    mutationFn: (v: { menuItemId: string; quantity: number }) =>
      getApi().setGroupItem(group.id, {
        member_id: member,
        menu_item_id: v.menuItemId,
        quantity: v.quantity,
      }),
    onSuccess: (g) => queryClient.setQueryData(queryKeys.group(group.id), g),
  });
  const items = menu.data
    ? [...menu.data.categories.flatMap((c) => c.items), ...menu.data.uncategorized]
    : [];
  const qty = (itemId: string) =>
    group.items.find((i) => i.member_id === member && i.menu_item_id === itemId)?.quantity ?? 0;
  return (
    <section
      aria-labelledby="add-heading"
      className="grid gap-3 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="add-heading" className="font-semibold">
          Add dishes
        </h2>
        {me.is_host && (
          <label className="flex items-center gap-2 text-sm">
            For
            <select
              value={member}
              onChange={(e) => setMember(e.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2"
            >
              {group.members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.is_me ? "Me" : (m.full_name ?? "Member")}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <InlineError error={setItem.error} />
      <ul className="grid gap-2">
        {items.map((item) => {
          const current = qty(item.id);
          const price = item.special?.unit_price_paise ?? item.price_paise;
          return (
            <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {item.name} · {formatPaise(price)}
              </span>
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`One less ${item.name}`}
                  disabled={current === 0 || setItem.isPending}
                  onClick={() => setItem.mutate({ menuItemId: item.id, quantity: current - 1 })}
                >
                  −
                </Button>
                <span
                  className="w-6 text-center font-semibold"
                  aria-label={`${item.name} quantity`}
                >
                  {current}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`One more ${item.name}`}
                  disabled={current >= 20 || item.stock_status === "sold_out" || setItem.isPending}
                  onClick={() => setItem.mutate({ menuItemId: item.id, quantity: current + 1 })}
                >
                  +
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function GroupPage() {
  const { id } = useParams<{ id: string }>();
  const auth = useRequireAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const group = useGroup(id);
  const wallet = useWallet();
  const act = useMutation({
    mutationFn: (action: "checkout" | "pay" | "leave") =>
      action === "checkout"
        ? getApi().checkoutGroup(id)
        : action === "pay"
          ? getApi().payGroupShare(id)
          : getApi()
              .leaveGroup(id)
              .then(() => null),
    onSuccess: (g) => {
      if (g) queryClient.setQueryData(queryKeys.group(id), g);
      else router.push("/groups");
      void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    },
  });

  if (!auth.ready || group.isPending) return <Skeleton className="h-64" />;
  if (group.isError) return <ErrorState error={group.error} onRetry={() => void group.refetch()} />;
  const g = group.data;
  const me = g.members.find((m) => m.is_me);
  if (!me) return null;
  const tz = "Asia/Kolkata";
  const myItems = (memberId: string) => g.items.filter((i) => i.member_id === memberId);

  return (
    <div className="mx-auto grid max-w-2xl gap-5">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/groups" className="hover:text-ink">
          Group orders
        </Link>{" "}
        / <span aria-current="page">{g.outlet.name}</span>
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Group order · {g.outlet.name}</h1>
          <p className="text-muted">
            Pickup {formatDayLabel(g.pickup_slot.starts_at, tz).toLowerCase()},{" "}
            {formatSlot(g.pickup_slot.starts_at, g.pickup_slot.ends_at, tz)}
          </p>
        </div>
        <div className="grid justify-items-end gap-1">
          {g.status === "open" && (
            <p className="text-sm">
              Invite code{" "}
              <span
                className="font-mono text-lg font-bold tracking-widest"
                data-testid="invite-code"
              >
                {g.invite_code}
              </span>
            </p>
          )}
          <LiveIndicator status={group.live} />
        </div>
      </header>

      {g.status === "locked" && g.payment_due_by && (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-warn">
          Checked out. Everyone pays their share within{" "}
          <Countdown until={g.payment_due_by} onElapsed={() => void group.refetch()} /> or the order
          is cancelled and paid shares go back to wallets.
        </p>
      )}
      {g.status === "paid" && g.order_id && (
        <p className="rounded-xl bg-ok-soft px-4 py-3 text-ok">
          Everyone paid. Token <strong>{g.token_label}</strong> is with the kitchen.{" "}
          <Link href={`/orders/${g.order_id}`} className="font-medium underline">
            Track the order
          </Link>
          {me.is_host ? " (you collect it with your Food Pass)." : " (the host collects it)."}
        </p>
      )}
      {g.status === "cancelled" && (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger">
          This group order was cancelled. Any shares paid went back to wallets.
        </p>
      )}

      <section aria-labelledby="members-heading" className="grid gap-2">
        <h2 id="members-heading" className="font-semibold">
          Who&apos;s in ({g.members.length})
        </h2>
        <ul className="grid gap-2">
          {g.members.map((m) => (
            <li
              key={m.user_id}
              className="rounded-xl border border-line bg-surface px-4 py-3"
              aria-label={`${m.full_name ?? "Member"}'s items`}
              data-testid="group-member"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {m.full_name ?? "Member"}
                  {m.is_host && " (host)"}
                  {m.is_me && " · you"}
                </p>
                {m.share_paise !== null && (
                  <span className="flex items-center gap-2 text-sm">
                    {formatPaise(m.share_paise)}
                    <Badge tone={m.paid ? "success" : "warning"}>
                      {m.paid ? "Paid" : "Not paid yet"}
                    </Badge>
                  </span>
                )}
              </div>
              <ul className="mt-1 text-sm text-muted">
                {myItems(m.user_id).map((i) => (
                  <li key={i.id}>
                    {i.quantity} × {i.item_name} · {formatPaise(i.line_total_paise)}
                  </li>
                ))}
                {myItems(m.user_id).length === 0 && <li>No dishes yet</li>}
              </ul>
            </li>
          ))}
        </ul>
        <p className="flex justify-between font-semibold">
          <span>{g.status === "open" ? "Estimated total" : "Total"}</span>
          <span data-testid="group-total">{formatPaise(g.total_paise)}</span>
        </p>
      </section>

      {g.status === "open" && <AddItems group={g} me={me} />}
      {g.status === "open" && me.is_host && <SplitEditor key={g.version} group={g} />}

      <InlineError error={act.error} />
      <div className="flex flex-wrap gap-2">
        {g.status === "open" && me.is_host && (
          <Button
            busy={act.isPending}
            disabled={g.items.length === 0}
            onClick={() => act.mutate("checkout")}
          >
            Check out the group order
          </Button>
        )}
        {g.status === "locked" && me.share_paise !== null && !me.paid && (
          <Button busy={act.isPending} onClick={() => act.mutate("pay")}>
            Pay my share {formatPaise(me.share_paise)} from wallet
            {wallet.data ? ` (balance ${formatPaise(wallet.data.balance_paise)})` : ""}
          </Button>
        )}
        {g.status === "open" && (
          <Button
            variant="danger"
            disabled={act.isPending}
            onClick={() =>
              window.confirm(
                me.is_host ? "Cancel this group order for everyone?" : "Leave this group order?",
              ) && act.mutate("leave")
            }
          >
            {me.is_host ? "Cancel group order" : "Leave"}
          </Button>
        )}
      </div>
    </div>
  );
}
