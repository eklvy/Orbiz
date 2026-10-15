"use client";

import { formatSlot, staffQueryKeys, type Schemas } from "@campuscart/client";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  Loading,
  useCurrentOutlet,
  useRuntime,
} from "@campuscart/staff-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useManagedOutlet } from "@/components/hooks";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function localToday(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date()); // YYYY-MM-DD
}

function SlotRow({
  slot,
  timeZone,
  date,
}: {
  slot: Schemas["ManagerSlot"];
  timeZone: string;
  date: string;
}) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  const [capacity, setCapacity] = useState(String(slot.capacity));
  const update = useMutation({
    mutationFn: (body: Schemas["SlotUpdate"]) => api.updateSlot(slot.id, body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.slots(outlet.id, date) }),
  });
  const label = formatSlot(slot.starts_at, slot.ends_at, timeZone);
  return (
    <li
      className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
      aria-label={`Slot ${label}`}
    >
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-sm text-muted">
          {slot.reserved_count} booked of {slot.capacity}{" "}
          {!slot.is_active && <Badge tone="warning">Not taking bookings</Badge>}
        </p>
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ capacity: Number.parseInt(capacity, 10) });
        }}
      >
        <Field
          label={`Capacity ${label}`}
          type="number"
          min={0}
          max={1000}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          className="w-28"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          className="h-11"
          busy={update.isPending && update.variables?.capacity !== undefined}
        >
          Save
        </Button>
      </form>
      <Button
        size="sm"
        variant={slot.is_active ? "danger" : "secondary"}
        className="h-11"
        onClick={() => {
          if (
            slot.is_active &&
            slot.reserved_count > 0 &&
            !window.confirm(`${slot.reserved_count} order(s) keep this slot. Stop new bookings?`)
          )
            return;
          update.mutate({ is_active: !slot.is_active });
        }}
      >
        {slot.is_active ? "Stop bookings" : "Resume bookings"}
      </Button>
      <div className="sm:col-span-3">
        <InlineError error={update.error} />
      </div>
    </li>
  );
}

function Slots({ timeZone }: { timeZone: string }) {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(() => localToday(timeZone));
  const slots = useQuery({
    queryKey: staffQueryKeys.slots(outlet.id, date),
    queryFn: () => api.slots(outlet.id, date),
  });
  const generate = useMutation({
    mutationFn: () => api.generateSlots(outlet.id, date),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.slots(outlet.id, date) }),
  });
  return (
    <section aria-labelledby="slots-heading" className="grid gap-3">
      <h2 id="slots-heading" className="text-lg font-semibold">
        Pickup slots
      </h2>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Date"
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="w-44"
        />
        <Button
          variant="secondary"
          className="h-11"
          busy={generate.isPending}
          onClick={() => generate.mutate()}
        >
          Create slots from opening hours
        </Button>
      </div>
      {generate.data && (
        <p role="status" className="text-sm text-muted">
          {generate.data.created} new slot(s) created. Existing slots were left as they were.
        </p>
      )}
      <InlineError error={generate.error} />
      {slots.isPending ? (
        <Loading label="Loading slots" />
      ) : slots.isError ? (
        <ErrorState error={slots.error} onRetry={() => void slots.refetch()} />
      ) : slots.data.length === 0 ? (
        <EmptyState title="No slots on this date">Set opening hours, then create slots.</EmptyState>
      ) : (
        <ul className="grid gap-2">
          {slots.data.map((slot) => (
            <SlotRow key={slot.id} slot={slot} timeZone={timeZone} date={date} />
          ))}
        </ul>
      )}
    </section>
  );
}

type Range = { day_of_week: number; opens_at: string; closes_at: string };

function Hours({ outlet }: { outlet: Schemas["ManagedOutlet"] }) {
  const { api } = useRuntime();
  const queryClient = useQueryClient();
  const [ranges, setRanges] = useState<Range[]>(() =>
    outlet.hours.map((h) => ({
      day_of_week: h.day_of_week,
      opens_at: h.opens_at.slice(0, 5),
      closes_at: h.closes_at.slice(0, 5),
    })),
  );
  const save = useMutation({
    mutationFn: () => api.setHours(outlet.id, ranges),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.managedOutlet(outlet.id) }),
  });
  const set = (i: number, patch: Partial<Range>) =>
    setRanges((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <section aria-labelledby="hours-heading" className="grid gap-3">
      <div>
        <h2 id="hours-heading" className="text-lg font-semibold">
          Opening hours
        </h2>
        <p className="text-sm text-muted">Used for new slots. Existing slots don&apos;t change.</p>
      </div>
      <ul className="grid gap-2">
        {ranges.map((r, i) => (
          <li
            key={i}
            className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3"
          >
            <label className="grid gap-1.5 text-sm font-medium">
              Day
              <select
                value={r.day_of_week}
                onChange={(e) => set(i, { day_of_week: Number(e.target.value) })}
                className="h-11 rounded-lg border border-line bg-surface px-2"
              >
                {DAYS.map((d, n) => (
                  <option key={d} value={n}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Opens"
              type="time"
              value={r.opens_at}
              onChange={(e) => set(i, { opens_at: e.target.value })}
              className="w-32"
            />
            <Field
              label="Closes"
              type="time"
              value={r.closes_at}
              onChange={(e) => set(i, { closes_at: e.target.value })}
              className="w-32"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-11"
              onClick={() => setRanges((rs) => rs.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            setRanges((rs) => [...rs, { day_of_week: 1, opens_at: "08:00", closes_at: "17:00" }])
          }
        >
          Add hours
        </Button>
        <Button busy={save.isPending} onClick={() => save.mutate()}>
          Save hours
        </Button>
      </div>
      {save.isSuccess && (
        <p role="status" className="text-sm text-ok">
          Opening hours saved.
        </p>
      )}
      <InlineError error={save.error} />
    </section>
  );
}

export default function SlotsPage() {
  const managed = useManagedOutlet();
  if (managed.isPending) return <Loading label="Loading outlet" />;
  if (managed.isError)
    return <ErrorState error={managed.error} onRetry={() => void managed.refetch()} />;
  return (
    <div className="grid gap-10">
      <h1 className="text-2xl font-bold tracking-tight">Slots &amp; hours</h1>
      <Slots timeZone={managed.data.timezone} />
      <Hours key={managed.data.id} outlet={managed.data} />
    </div>
  );
}
