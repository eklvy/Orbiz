"use client";

import { staffQueryKeys } from "@campuscart/client";
import {
  Badge,
  Button,
  ErrorState,
  Field,
  InlineError,
  Loading,
  useCurrentOutlet,
  useMe,
  useRuntime,
} from "@campuscart/staff-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export default function StaffPage() {
  const { api } = useRuntime();
  const { outlet } = useCurrentOutlet();
  const me = useMe();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const staff = useQuery({
    queryKey: staffQueryKeys.staff(outlet.id),
    queryFn: () => api.staff(outlet.id),
  });
  const add = useMutation({
    mutationFn: () => api.addStaff(outlet.id, email.trim()),
    onSuccess: (list) => {
      setEmail("");
      queryClient.setQueryData(staffQueryKeys.staff(outlet.id), list);
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeStaff(outlet.id, userId),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: staffQueryKeys.staff(outlet.id) }),
  });

  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Staff</h1>
        <p className="text-sm text-muted">
          Kitchen staff use the CampusCart Kitchen app. Managers are added by an administrator.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) add.mutate();
        }}
      >
        <Field
          label="Add kitchen staff by email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          hint="They need a CampusCart account first."
          className="w-72"
        />
        <Button type="submit" busy={add.isPending} className="h-11">
          Add
        </Button>
      </form>
      <InlineError error={add.error ?? remove.error} />
      {staff.isPending ? (
        <Loading label="Loading staff" />
      ) : staff.isError ? (
        <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />
      ) : (
        <ul className="grid gap-2">
          {staff.data.map((m) => (
            <li
              key={m.user_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3"
            >
              <div>
                <p className="font-medium">{m.full_name ?? m.email}</p>
                <p className="text-sm text-muted">{m.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={m.role === "manager" ? "info" : "neutral"}>
                  {m.role === "manager" ? "Manager" : "Kitchen staff"}
                </Badge>
                {m.role === "kitchen_staff" && m.user_id !== me.data?.id && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() =>
                      window.confirm(`Remove ${m.email} from this outlet?`) &&
                      remove.mutate(m.user_id)
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
