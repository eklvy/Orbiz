"use client";

import { staffQueryKeys, type Schemas } from "@campuscart/client";
import { Button, ErrorState, Field, InlineError, Loading, useRuntime } from "@campuscart/staff-web";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useManagedOutlet } from "@/components/hooks";

type Settings = Schemas["ManagedOutlet"];
const NUMBERS = [
  ["slot_minutes", "Slot length (minutes)", 5, 120],
  ["default_slot_capacity", "Orders per slot (default)", 1, 500],
  ["reservation_ttl_minutes", "Unpaid order hold (minutes)", 2, 60],
  ["concurrent_orders", "Orders the kitchen prepares at once", 1, 50],
  ["no_show_grace_minutes", "Pickup grace period (minutes)", 5, 120],
  ["no_show_deal_discount_percent", "Deal discount for uncollected food (%)", 10, 90],
  ["deal_ttl_minutes", "How long a deal stays on sale (minutes)", 5, 240],
] as const;

function SettingsForm({ outlet }: { outlet: Settings }) {
  const { api } = useRuntime();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(
    () =>
      ({
        name: outlet.name,
        location: outlet.location ?? "",
        description: outlet.description ?? "",
        ...Object.fromEntries(NUMBERS.map(([key]) => [key, String(outlet[key])])),
      }) as Record<string, string>,
  );
  const save = useMutation({
    mutationFn: (body: Schemas["OutletSettingsUpdate"]) => api.updateSettings(outlet.id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(staffQueryKeys.managedOutlet(outlet.id), updated);
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.managedOutlets });
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({
      name: values.name?.trim() ?? outlet.name,
      location: values.location?.trim() ?? "",
      description: values.description?.trim() ?? "",
      ...Object.fromEntries(NUMBERS.map(([key]) => [key, Number.parseInt(values[key] ?? "", 10)])),
    });
  }
  const set = (key: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  return (
    <form onSubmit={submit} className="grid gap-6">
      <section className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Outlet name"
          required
          maxLength={120}
          value={values.name}
          onChange={set("name")}
        />
        <Field
          label="Location"
          maxLength={200}
          value={values.location}
          onChange={set("location")}
        />
        <Field
          label="Description"
          maxLength={1000}
          value={values.description}
          onChange={set("description")}
          className="sm:col-span-2"
        />
      </section>
      <section aria-labelledby="ops-heading" className="grid gap-3">
        <h2 id="ops-heading" className="text-lg font-semibold">
          Operations
        </h2>
        <p className="text-sm text-muted">
          No-show policy: a ready order not collected by the end of its slot plus the grace period
          isn&apos;t refunded. Packaged items return to stock, and prepared food goes on sale at the
          deal discount for the time below.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {NUMBERS.map(([key, label, min, max]) => (
            <Field
              key={key}
              label={label}
              type="number"
              min={min}
              max={max}
              required
              value={values[key]}
              onChange={set(key)}
            />
          ))}
        </div>
      </section>
      <InlineError error={save.error} />
      {save.isSuccess && (
        <p role="status" className="text-sm text-ok">
          Settings saved.
        </p>
      )}
      <Button type="submit" busy={save.isPending} className="justify-self-start">
        Save settings
      </Button>
    </form>
  );
}

export default function SettingsPage() {
  const managed = useManagedOutlet();
  if (managed.isPending) return <Loading label="Loading settings" />;
  if (managed.isError)
    return <ErrorState error={managed.error} onRetry={() => void managed.refetch()} />;
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <SettingsForm key={managed.data.id} outlet={managed.data} />
    </div>
  );
}
