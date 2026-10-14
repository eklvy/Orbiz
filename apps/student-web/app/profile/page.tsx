"use client";

import { profileSchema, profileUpdate, queryKeys, type ProfileValues } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ErrorState, InlineError, Skeleton } from "@/components/ui/states";
import { getApi } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";

export default function ProfilePage() {
  const auth = useRequireAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const [saved, setSaved] = useState(false);
  const form = useForm<ProfileValues>({ resolver: zodResolver(profileSchema) });

  useEffect(() => {
    if (me.data) {
      form.reset({
        fullName: me.data.full_name,
        department: me.data.department ?? "",
        yearOfStudy: me.data.year_of_study ? String(me.data.year_of_study) : "",
        hostelRoom: me.data.hostel_room ?? "",
      });
    }
  }, [me.data, form]);

  const save = useMutation({
    mutationFn: (values: ProfileValues) => getApi().updateMe(profileUpdate(values)),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.me, updated);
      setSaved(true);
    },
  });

  if (!auth.ready || me.isPending) return <Skeleton className="h-80" />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  const { errors } = form.formState;

  return (
    <div className="mx-auto grid max-w-xl gap-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Profile</h1>
        <p className="text-muted">{me.data.email}</p>
      </header>
      <dl className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
        <div>
          <dt className="text-muted">Account type</dt>
          <dd className="font-semibold capitalize">{me.data.customer_type}</dd>
        </div>
        <div>
          <dt className="text-muted">Roll number</dt>
          <dd className="font-semibold">{me.data.roll_number ?? "—"}</dd>
        </div>
      </dl>
      <form
        className="grid gap-4 rounded-xl border border-line bg-surface p-5"
        onSubmit={form.handleSubmit((values) => {
          setSaved(false);
          save.mutate(values);
        })}
        noValidate
      >
        <Field
          label="Full name"
          autoComplete="name"
          error={errors.fullName?.message}
          {...form.register("fullName")}
        />
        <Field
          label="Department"
          error={errors.department?.message}
          {...form.register("department")}
        />
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Year of study"
            inputMode="numeric"
            error={errors.yearOfStudy?.message}
            {...form.register("yearOfStudy")}
          />
          <Field
            label="Hostel room"
            error={errors.hostelRoom?.message}
            {...form.register("hostelRoom")}
          />
        </div>
        <InlineError error={save.error} />
        {saved && (
          <p role="status" className="text-sm font-medium text-ok">
            Saved.
          </p>
        )}
        <Button type="submit" busy={save.isPending} className="justify-self-start">
          Save changes
        </Button>
      </form>
      <Button
        variant="secondary"
        className="justify-self-start"
        onClick={() => void auth.signOut().then(() => router.push("/"))}
      >
        Sign out
      </Button>
    </div>
  );
}
