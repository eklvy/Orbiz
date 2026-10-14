"use client";

import { resetPasswordSchema } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export default function ResetPasswordPage() {
  const { session, ready } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof resetPasswordSchema>>({
    resolver: zodResolver(resetPasswordSchema),
  });
  const { errors, isSubmitting } = form.formState;

  if (ready && !session) {
    return (
      <p role="alert" className="mx-auto max-w-md rounded-xl bg-warn-soft p-5 text-warn">
        This reset link is invalid or has expired. Request a new one from the sign-in page.
      </p>
    );
  }
  return (
    <div className="mx-auto grid max-w-md gap-6">
      <h1 className="text-3xl font-bold tracking-tight">Choose a new password</h1>
      <form
        noValidate
        className="grid gap-4 rounded-xl border border-line bg-surface p-5"
        onSubmit={form.handleSubmit(async ({ password }) => {
          const { error: authError } = await getSupabase().auth.updateUser({ password });
          if (authError) {
            setError(authError.message);
            return;
          }
          router.replace("/");
        })}
      >
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          error={errors.password?.message}
          {...form.register("password")}
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={errors.confirm?.message}
          {...form.register("confirm")}
        />
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" busy={isSubmitting}>
          Update password
        </Button>
      </form>
    </div>
  );
}
