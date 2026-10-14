"use client";

import { forgotPasswordSchema } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { getSupabase } from "@/lib/supabase";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const form = useForm<z.infer<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <div className="mx-auto grid max-w-md gap-6">
      <h1 className="text-3xl font-bold tracking-tight">Reset your password</h1>
      {sent ? (
        // Same message whether or not the account exists, so emails can't be enumerated.
        <p role="status" className="rounded-xl border border-line bg-surface p-5">
          If an account exists for that email, we&apos;ve sent a link to reset the password.
        </p>
      ) : (
        <form
          noValidate
          className="grid gap-4 rounded-xl border border-line bg-surface p-5"
          onSubmit={form.handleSubmit(async ({ email }) => {
            await getSupabase().auth.resetPasswordForEmail(email, {
              redirectTo: `${window.location.origin}/reset-password`,
            });
            setSent(true);
          })}
        >
          <Field
            label="Campus email"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...form.register("email")}
          />
          <Button type="submit" size="lg" busy={isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
    </div>
  );
}
