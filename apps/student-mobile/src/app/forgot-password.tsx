import { forgotPasswordSchema } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { ScrollView, Text } from "react-native";
import type { z } from "zod";
import { Button, Card, Input, makeStyles } from "@/components/ui";
import { env } from "@/lib/env";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/lib/theme";

export default function ForgotPasswordScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const [sent, setSent] = useState(false);
  const form = useForm<z.infer<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      {sent ? (
        // Same message whether or not the account exists (no email enumeration).
        <Card>
          <Text style={{ color: t.ink }}>
            If an account exists for that email, we&apos;ve sent a link to reset the password.
          </Text>
          <Text style={{ color: t.muted }}>
            The link opens the CampusCart website, where you choose the new password.
          </Text>
        </Card>
      ) : (
        <>
          <Controller
            control={form.control}
            name="email"
            render={({ field }) => (
              <Input
                label="Campus email"
                autoCapitalize="none"
                keyboardType="email-address"
                value={field.value}
                onChangeText={field.onChange}
                error={errors.email?.message}
              />
            )}
          />
          <Button
            label="Send reset link"
            busy={isSubmitting}
            onPress={() =>
              void form.handleSubmit(async ({ email }) => {
                await supabase.auth.resetPasswordForEmail(
                  email,
                  env.passwordResetUrl ? { redirectTo: env.passwordResetUrl } : {},
                );
                setSent(true);
              })()
            }
          />
        </>
      )}
    </ScrollView>
  );
}
