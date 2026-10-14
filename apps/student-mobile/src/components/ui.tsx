import { friendlyError, type StatusTone } from "@campuscart/client";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { radius, space, useTheme, type Theme } from "@/lib/theme";

type Variant = "primary" | "secondary" | "danger";

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const colors: Record<Variant, { bg: string; fg: string; border: string }> = {
    primary: { bg: t.primary, fg: t.primaryInk, border: t.primary },
    secondary: { bg: t.surface, fg: t.ink, border: t.line },
    danger: { bg: t.surface, fg: t.danger, border: t.danger },
  };
  const c = colors[variant];
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: c.bg,
          borderColor: c.border,
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy && <ActivityIndicator color={c.fg} size="small" />}
      <Text style={[styles.buttonText, { color: c.fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ tone, label }: { tone: StatusTone; label: string }) {
  const t = useTheme();
  const tones: Record<StatusTone, [string, string]> = {
    neutral: [t.surface2, t.muted],
    info: [t.infoSoft, t.info],
    progress: [t.primarySoft, t.primary],
    success: [t.okSoft, t.ok],
    danger: [t.dangerSoft, t.danger],
    warning: [t.warnSoft, t.warn],
  };
  const [bg, fg] = tones[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }, style]}>
      {children}
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
      {children}
    </Text>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={{ color: useTheme().muted }}>{children}</Text>;
}

export function Loading({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View accessibilityLabel={label} style={styles.center}>
      <ActivityIndicator color={t.primary} />
    </View>
  );
}

export function Empty({ title, message }: { title: string; message?: string }) {
  const t = useTheme();
  return (
    <Card style={{ alignItems: "center", paddingVertical: space.xl }}>
      <Text style={{ color: t.ink, fontWeight: "600" }}>{title}</Text>
      {message && (
        <Text style={{ color: t.muted, marginTop: 4, textAlign: "center" }}>{message}</Text>
      )}
    </Card>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTheme();
  if (!error) return null;
  const { message, hint } = friendlyError(error);
  return (
    <View accessibilityRole="alert" style={[styles.error, { backgroundColor: t.dangerSoft }]}>
      <Text style={{ color: t.danger, fontWeight: "600" }}>{message}</Text>
      {hint && <Text style={{ color: t.danger }}>{hint}</Text>}
      {onRetry && <Button label="Try again" variant="secondary" onPress={onRetry} />}
    </View>
  );
}

export function Input({
  label,
  error,
  ...props
}: TextInputProps & { label: string; error?: string | undefined }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.ink, fontWeight: "500" }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        style={[
          styles.input,
          { color: t.ink, backgroundColor: t.surface, borderColor: error ? t.danger : t.line },
        ]}
        {...props}
      />
      {error && <Text style={{ color: t.danger, fontSize: 12 }}>{error}</Text>}
    </View>
  );
}

export function Stepper({
  value,
  onChange,
  label,
  max = 20,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  max?: number;
  disabled?: boolean;
}) {
  const t = useTheme();
  const step = (delta: number, a11y: string, off: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${a11y} ${label}`}
      disabled={disabled || off}
      onPress={() => onChange(value + delta)}
      style={[styles.stepButton, { opacity: disabled || off ? 0.4 : 1 }]}
    >
      <Text style={{ color: t.ink, fontSize: 20, fontWeight: "600" }}>{delta > 0 ? "+" : "−"}</Text>
    </Pressable>
  );
  return (
    <View style={[styles.stepper, { borderColor: t.line, backgroundColor: t.surface }]}>
      {step(-1, "Remove one", false)}
      <Text style={{ color: t.ink, fontWeight: "700", minWidth: 24, textAlign: "center" }}>
        {value}
      </Text>
      {step(1, "Add one", value >= max)}
    </View>
  );
}

export const makeStyles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    content: { padding: space.lg, gap: space.md, paddingBottom: 96 },
  });

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: "row",
    gap: space.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 16, fontWeight: "600" },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, alignSelf: "flex-start" },
  badgeText: { fontSize: 12, fontWeight: "700" },
  card: { borderWidth: 1, borderRadius: radius.md, padding: space.lg, gap: space.sm },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  center: { padding: space.xl, alignItems: "center" },
  error: { borderRadius: radius.sm, padding: space.md, gap: space.xs },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    fontSize: 16,
  },
  stepper: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: radius.sm },
  stepButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
