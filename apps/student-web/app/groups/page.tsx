"use client";

import { formatDayLabel, formatSlot, queryKeys } from "@campuscart/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { EmptyState, ErrorState, InlineError, LoadingList } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useOutlets, usePickupSlots } from "@/lib/hooks";

const STATUS = {
  open: ["info", "Adding items"],
  locked: ["warning", "Waiting for payments"],
  paid: ["success", "Sent to the kitchen"],
  cancelled: ["neutral", "Cancelled"],
} as const;

export default function GroupsPage() {
  const auth = useRequireAuth();
  const router = useRouter();
  const groups = useQuery({
    queryKey: queryKeys.groups,
    queryFn: () => getApi().listGroups(),
    enabled: Boolean(auth.session),
  });
  const outlets = useOutlets();
  const [outletId, setOutletId] = useState("");
  const slots = usePickupSlots(outletId || undefined);
  const [slotId, setSlotId] = useState("");
  const [code, setCode] = useState("");
  const create = useMutation({
    mutationFn: () => getApi().createGroup(outletId, slotId),
    onSuccess: (g) => router.push(`/groups/${g.id}`),
  });
  const join = useMutation({
    mutationFn: () => getApi().joinGroup(code.trim()),
    onSuccess: (g) => router.push(`/groups/${g.id}`),
  });
  const outlet = outlets.data?.find((o) => o.id === outletId);
  const tz = outlet?.timezone ?? "Asia/Kolkata";

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Group orders</h1>
        <p className="text-sm text-muted">
          One tray for your squad. Everyone adds their dishes and pays their own share from their
          wallet; the order reaches the kitchen once every share is paid.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <form
          aria-label="Start a group order"
          className="grid gap-3 rounded-2xl border border-line bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (outletId && slotId) create.mutate();
          }}
        >
          <p className="font-semibold">Start one</p>
          <label className="grid gap-1 text-sm font-medium">
            Outlet
            <select
              value={outletId}
              onChange={(e) => {
                setOutletId(e.target.value);
                setSlotId("");
              }}
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
          <label className="grid gap-1 text-sm font-medium">
            Pickup time
            <select
              value={slotId}
              disabled={!outletId}
              onChange={(e) => setSlotId(e.target.value)}
              className="h-11 rounded-lg border border-line bg-surface px-2 font-normal"
            >
              <option value="">Choose…</option>
              {slots.data
                ?.filter((s) => s.bookable)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatDayLabel(s.starts_at, tz)}, {formatSlot(s.starts_at, s.ends_at, tz)}
                  </option>
                ))}
            </select>
          </label>
          <InlineError error={create.error} />
          <Button type="submit" busy={create.isPending} disabled={!outletId || !slotId}>
            Start group order
          </Button>
        </form>
        <form
          aria-label="Join a group order"
          className="grid content-start gap-3 rounded-2xl border border-line bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim().length === 6) join.mutate();
          }}
        >
          <p className="font-semibold">Join one</p>
          <Field
            label="Invite code"
            value={code}
            maxLength={6}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <InlineError error={join.error} />
          <Button
            type="submit"
            variant="secondary"
            busy={join.isPending}
            disabled={code.trim().length !== 6}
          >
            Join
          </Button>
        </form>
      </div>
      <section aria-labelledby="mine-heading" className="grid gap-2">
        <h2 id="mine-heading" className="font-semibold">
          Your group orders
        </h2>
        {groups.isPending ? (
          <LoadingList label="Loading group orders" rows={2} />
        ) : groups.isError ? (
          <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
        ) : groups.data.length === 0 ? (
          <EmptyState title="No group orders yet" />
        ) : (
          <ul className="grid gap-2">
            {groups.data.map((g) => (
              <li key={g.id}>
                <Link
                  href={`/groups/${g.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3 hover:border-primary"
                >
                  <span>
                    <span className="font-semibold">{g.outlet.name}</span>
                    <span className="block text-sm text-muted">
                      {g.members.length} people ·{" "}
                      {formatSlot(g.pickup_slot.starts_at, g.pickup_slot.ends_at, "Asia/Kolkata")}
                    </span>
                  </span>
                  <Badge tone={STATUS[g.status][0]}>{STATUS[g.status][1]}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
