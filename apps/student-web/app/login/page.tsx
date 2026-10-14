"use client";

import { loginSchema } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { getSupabase } from "@/lib/supabase";

/** Only same-site relative paths, to avoid open redirects. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  const { errors, isSubmitting } = form.formState;

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit(async ({ email, password }) => {
        setError(null);
        const { error: authError } = await getSupabase().auth.signInWithPassword({
          email,
          password,
        });
        if (authError) {
          setError(
            authError.status === 400
              ? "Email or password is incorrect."
              : "Couldn't sign in. Please try again.",
          );
          return;
        }
        router.replace(safeNext(params.get("next")));
      })}
    >
      <Field
        label="Campus email"
        type="email"
        autoComplete="email"
        error={errors.email?.message}
        {...form.register("email")}
      />
      <Field
        label="Password"
        type="password"
        autoComplete="current-password"
        error={errors.password?.message}
        {...form.register("password")}
      />
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" busy={isSubmitting}>
        Sign in
      </Button>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="text-primary underline">
          Forgot password?
        </Link>
        <Link href="/register" className="text-primary underline">
          Create an account
        </Link>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="mx-auto grid max-w-md gap-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Sign in</h1>
        <p className="text-muted">One account for the app and the website.</p>
      </header>
      <div className="rounded-xl border border-line bg-surface p-5">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
