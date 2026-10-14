import { loginSchema } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { router } from "expo-router";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { ScrollView, Text } from "react-native";
import type { z } from "zod";
import { Button, Input, makeStyles } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/lib/theme";

export default function LoginScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async ({ email, password }) => {
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError(
        authError.status === 400
          ? "Email or password is incorrect."
          : "Couldn't sign in. Please try again.",
      );
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace("/");
  });
  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.content}
      keyboardShouldPersistTaps="handled"
    >
      <Controller
        control={form.control}
        name="email"
        render={({ field }) => (
          <Input
            label="Campus email"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            value={field.value}
            onChangeText={field.onChange}
            error={errors.email?.message}
          />
        )}
      />
      <Controller
        control={form.control}
        name="password"
        render={({ field }) => (
          <Input
            label="Password"
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            value={field.value}
            onChangeText={field.onChange}
            onSubmitEditing={() => void submit()}
            error={errors.password?.message}
          />
        )}
      />
      {error && (
        <Text accessibilityRole="alert" style={{ color: t.danger }}>
          {error}
        </Text>
      )}
      <Button label="Sign in" busy={isSubmitting} onPress={() => void submit()} />
      <Button
        label="Forgot password?"
        variant="secondary"
        onPress={() => router.push("/forgot-password")}
      />
      <Button
        label="Create an account"
        variant="secondary"
        onPress={() => router.push("/register")}
      />
    </ScrollView>
  );
}
