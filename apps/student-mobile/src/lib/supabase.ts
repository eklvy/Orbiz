import { createClient } from "@supabase/supabase-js";
import { AppState, Platform } from "react-native";
import { env } from "./env";
import { sessionStorage } from "./secure-storage";

export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    ...(sessionStorage ? { storage: sessionStorage } : {}),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Refresh tokens only while the app is in the foreground (recommended for React Native).
if (Platform.OS !== "web") {
  AppState.addEventListener("change", (state) => {
    if (state === "active") void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
}
