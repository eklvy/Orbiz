import { registerSchema, registrationMetadata, type RegisterValues } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { router } from "expo-router";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { ScrollView, Switch, Text, View } from "react-native";
import { Button, Card, Input, makeStyles } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { space, useTheme } from "@/lib/theme";

export default function RegisterScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      customerType: "student",
      fullName: "",
      email: "",
      password: "",
      rollNumber: "",
      department: "",
      yearOfStudy: "",
    },
  });
  const { errors, isSubmitting } = form.formState;
  const isFaculty = useWatch({ control: form.control, name: "customerType" }) === "faculty";
  const submit = form.handleSubmit(async (values) => {
    setError(null);
    const { data, error: authError } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: { data: registrationMetadata(values) },
    });
    if (authError) {
      setError(
        /database error/i.test(authError.message)
          ? "We couldn't create your account. Check that your roll number isn't already registered and that you're using your campus email."
          : authError.message,
      );
      return;
    }
    if (!data.session) setCheckEmail(true);
    else router.replace("/");
  });

  if (checkEmail) {
    return (
      <View style={[s.screen, s.content]}>
        <Card>
          <Text style={{ color: t.ink, fontWeight: "700" }}>Check your email</Text>
          <Text style={{ color: t.muted }}>We sent you a link to confirm your account.</Text>
        </Card>
      </View>
    );
  }
  const text = (
    name: Exclude<keyof RegisterValues, "customerType">,
    label: string,
    extra: object = {},
  ) => (
    <Controller
      control={form.control}
      name={name}
      render={({ field }) => (
        <Input
          label={label}
          value={field.value ?? ""}
          onChangeText={field.onChange}
          error={errors[name]?.message}
          {...extra}
        />
      )}
    />
  );
  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.content}
      keyboardShouldPersistTaps="handled"
    >
      <Controller
        control={form.control}
        name="customerType"
        render={({ field }) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Switch
              accessibilityLabel="I'm faculty or staff"
              value={field.value === "faculty"}
              onValueChange={(v) => field.onChange(v ? "faculty" : "student")}
            />
            <Text style={{ color: t.ink }}>I&apos;m faculty / staff</Text>
          </View>
        )}
      />
      {text("fullName", "Full name", { autoComplete: "name" })}
      {text("email", "Campus email", {
        autoCapitalize: "none",
        keyboardType: "email-address",
        autoComplete: "email",
      })}
      {text("rollNumber", isFaculty ? "Roll / staff number (optional)" : "Roll number", {
        autoCapitalize: "characters",
      })}
      {text("department", "Department (optional)")}
      {text("yearOfStudy", "Year (optional)", { keyboardType: "number-pad" })}
      {text("password", "Password", { secureTextEntry: true, autoComplete: "new-password" })}
      <Text style={{ color: t.muted, fontSize: 12 }}>
        At least 8 characters, with a letter and a number.
      </Text>
      {error && (
        <Text accessibilityRole="alert" style={{ color: t.danger }}>
          {error}
        </Text>
      )}
      <Button label="Create account" busy={isSubmitting} onPress={() => void submit()} />
    </ScrollView>
  );
}
