// Browser-exposed configuration. Next inlines NEXT_PUBLIC_* at build time, so each variable
// must be referenced literally. Only public values belong here (URLs and the anon key).
// Checked lazily (on first use in the browser) so static builds don't need real values.
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy apps/student-web/.env.example to .env.local (or run scripts/web-env.sh).`,
    );
  }
  return value;
}

export const env = {
  get apiBaseUrl() {
    return required("NEXT_PUBLIC_API_BASE_URL", process.env.NEXT_PUBLIC_API_BASE_URL);
  },
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get supabaseAnonKey() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },
};
