import { profileSchema, profileUpdate, queryKeys, type ProfileValues } from "@campuscart/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { ScrollView, Text, View } from "react-native";
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  Input,
  Loading,
  Muted,
  Title,
  makeStyles,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";
import { space, useTheme } from "@/lib/theme";

export default function ProfileScreen() {
  const t = useTheme();
  const s = makeStyles(t);
  const { session, ready } = useAuth();
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
    mutationFn: (values: ProfileValues) => api.updateMe(profileUpdate(values)),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.me, updated);
      setSaved(true);
    },
  });

  if (!ready) return <Loading label="Loading" />;
  if (!session) {
    return (
      <View style={[s.screen, s.content]}>
        <Empty
          title="You're signed out"
          message="One account works in the app and on the website."
        />
        <Button label="Sign in" onPress={() => router.push("/login")} />
        <Button
          label="Create an account"
          variant="secondary"
          onPress={() => router.push("/register")}
        />
      </View>
    );
  }
  if (me.isPending) return <Loading label="Loading profile" />;
  if (me.isError) return <ErrorBox error={me.error} onRetry={() => void me.refetch()} />;
  const { errors } = form.formState;
  const field = (name: keyof ProfileValues, label: string, numeric = false) => (
    <Controller
      control={form.control}
      name={name}
      render={({ field: { value, onChange, onBlur } }) => (
        <Input
          label={label}
          value={value ?? ""}
          onChangeText={onChange}
          onBlur={onBlur}
          keyboardType={numeric ? "number-pad" : "default"}
          error={errors[name]?.message}
        />
      )}
    />
  );
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Title>Profile</Title>
      <Muted>{me.data.email}</Muted>
      <Card>
        <Text style={{ color: t.muted }}>
          Account type:{" "}
          <Text style={{ color: t.ink, fontWeight: "600" }}>{me.data.customer_type}</Text>
        </Text>
        <Text style={{ color: t.muted }}>
          Roll number:{" "}
          <Text style={{ color: t.ink, fontWeight: "600" }}>{me.data.roll_number ?? "—"}</Text>
        </Text>
      </Card>
      <Card style={{ gap: space.md }}>
        {field("fullName", "Full name")}
        {field("department", "Department")}
        {field("yearOfStudy", "Year of study", true)}
        {field("hostelRoom", "Hostel room")}
        <ErrorBox error={save.error} />
        {saved && (
          <Text accessibilityRole="alert" style={{ color: t.ok, fontWeight: "600" }}>
            Saved.
          </Text>
        )}
        <Button
          label="Save changes"
          busy={save.isPending}
          onPress={form.handleSubmit((v) => {
            setSaved(false);
            save.mutate(v);
          })}
        />
      </Card>
      <Button label="Sign out" variant="secondary" onPress={() => void supabase.auth.signOut()} />
    </ScrollView>
  );
}
