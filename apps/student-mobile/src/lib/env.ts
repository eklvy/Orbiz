// EXPO_PUBLIC_* values are inlined at build time and visible to anyone with the app: public
// values only. Each must be referenced literally for Expo to inline it.
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing ${name}. Copy apps/student-mobile/.env.example to .env.`);
  return value;
}

export const env = {
  apiBaseUrl: required("EXPO_PUBLIC_API_BASE_URL", process.env.EXPO_PUBLIC_API_BASE_URL),
  supabaseUrl: required("EXPO_PUBLIC_SUPABASE_URL", process.env.EXPO_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: required(
    "EXPO_PUBLIC_SUPABASE_ANON_KEY",
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  ),
  passwordResetUrl: process.env.EXPO_PUBLIC_PASSWORD_RESET_URL ?? null,
};
