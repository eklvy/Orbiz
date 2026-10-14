import { CampusCartApiError } from "@campuscart/client";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import NetInfo from "@react-native-community/netinfo";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { OfflineBanner } from "@/components/status";
import { AuthProvider } from "@/lib/auth";
import { useTheme } from "@/lib/theme";

// Let TanStack Query know about connectivity and foreground state on native.
onlineManager.setEventListener((setOnline) =>
  NetInfo.addEventListener((s) => setOnline(s.isConnected !== false)),
);

export default function RootLayout() {
  const t = useTheme();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: (count, error) =>
              count < 2 &&
              (!(error instanceof CampusCartApiError) || error.status === 0 || error.status >= 500),
          },
        },
      }),
  );
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = AppState.addEventListener("change", (s) => focusManager.setFocused(s === "active"));
    return () => sub.remove();
  }, []);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="auto" />
          <OfflineBanner />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: t.surface },
              headerTintColor: t.ink,
              contentStyle: { backgroundColor: t.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="outlet/[slug]" options={{ title: "Menu" }} />
            <Stack.Screen name="order/[id]" options={{ title: "Order" }} />
            <Stack.Screen name="login" options={{ title: "Sign in" }} />
            <Stack.Screen name="register" options={{ title: "Create account" }} />
            <Stack.Screen name="forgot-password" options={{ title: "Reset password" }} />
          </Stack>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
