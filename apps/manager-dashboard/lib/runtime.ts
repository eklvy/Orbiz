import { createStaffRuntime, type StaffRuntime } from "@campuscart/staff-web";

// Browser-exposed configuration. Next inlines NEXT_PUBLIC_* at build time, so each variable is
// referenced literally. Only public values belong here (URLs and the anon key).
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Run scripts/web-env.sh manager-dashboard (or copy .env.example).`,
    );
  }
  return value;
}

export function createRuntime(): StaffRuntime {
  return createStaffRuntime({
    apiBaseUrl: required("NEXT_PUBLIC_API_BASE_URL", process.env.NEXT_PUBLIC_API_BASE_URL),
    supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnonKey: required(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
  });
}
