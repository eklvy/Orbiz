"use client";

import { registerSchema, registrationMetadata, type RegisterValues } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { getSupabase } from "@/lib/supabase";

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { customerType: "student", rollNumber: "", department: "", yearOfStudy: "" },
  });
  const { errors, isSubmitting } = form.formState;
  const isFaculty = useWatch({ control: form.control, name: "customerType" }) === "faculty";

  if (checkEmail) {
    return (
      <div role="status" className="mx-auto max-w-md rounded-xl border border-line bg-surface p-6">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="mt-1 text-muted">
          We sent you a link to confirm your account. Open it on this device to finish signing up.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-md gap-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Create your account</h1>
        <p className="text-muted">Use your campus email. The same account works in the app.</p>
      </header>
      <form
        noValidate
        className="grid gap-4 rounded-xl border border-line bg-surface p-5"
        onSubmit={form.handleSubmit(async (values) => {
          setError(null);
          const { data, error: authError } = await getSupabase().auth.signUp({
            email: values.email,
            password: values.password,
            options: {
              data: registrationMetadata(values),
              emailRedirectTo: window.location.origin,
            },
          });
          if (authError) {
            // Profile constraint failures surface from Supabase Auth as a generic database error.
            setError(
              /database error/i.test(authError.message)
                ? "We couldn't create your account. Check that your roll number isn't already registered and that you're using your campus email."
                : authError.message,
            );
            return;
          }
          if (!data.session) {
            setCheckEmail(true); // email confirmation is enabled for this project
            return;
          }
          router.replace("/");
        })}
      >
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">I am</legend>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                value="student"
                className="accent-primary"
                {...form.register("customerType")}
              />{" "}
              A student
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                value="faculty"
                className="accent-primary"
                {...form.register("customerType")}
              />{" "}
              Faculty / staff
            </label>
          </div>
        </fieldset>
        <Field
          label="Full name"
          autoComplete="name"
          error={errors.fullName?.message}
          {...form.register("fullName")}
        />
        <Field
          label="Campus email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...form.register("email")}
        />
        <Field
          label={isFaculty ? "Roll / staff number (optional)" : "Roll number"}
          autoComplete="off"
          error={errors.rollNumber?.message}
          {...form.register("rollNumber")}
        />
        <div className="grid grid-cols-[1fr_7rem] gap-4">
          <Field
            label="Department (optional)"
            error={errors.department?.message}
            {...form.register("department")}
          />
          <Field
            label="Year (optional)"
            inputMode="numeric"
            error={errors.yearOfStudy?.message}
            {...form.register("yearOfStudy")}
          />
        </div>
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters, with a letter and a number."
          error={errors.password?.message}
          {...form.register("password")}
        />
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" busy={isSubmitting}>
          Create account
        </Button>
        <p className="text-center text-sm">
          Already registered?{" "}
          <Link href="/login" className="text-primary underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
