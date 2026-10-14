import { execSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

/**
 * Drives the student app's React Native Web build (same screens and logic as iOS/Android) on a
 * phone viewport against the REAL local backend. Native-only pieces (Keychain storage, native
 * navigation) are not exercised here; see docs/IMPLEMENTATION_STATUS.md.
 * Expects `expo export --platform web` output in dist-web (the `e2e` script does this) built
 * with EXPO_PUBLIC_API_BASE_URL=http://localhost:8100.
 */
const exports = execSync("bash ../../scripts/supabase-env.sh", { encoding: "utf8" });
const stack = Object.fromEntries(
  [...exports.matchAll(/^export (\w+)='([^']*)'$/gm)].map((m) => [m[1] as string, m[2] as string]),
);
process.env.E2E_SUPABASE_URL = stack.CAMPUSCART_SUPABASE_URL;
process.env.E2E_DATABASE_URL = stack.CAMPUSCART_DATABASE_URL;
process.env.E2E_ANON_KEY = stack.TEST_SUPABASE_ANON_KEY;
process.env.E2E_API_URL = "http://localhost:8100";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Pixel 7"],
    baseURL: "http://localhost:8081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "bash -c 'cd ../../services/api && exec .venv/bin/uvicorn app.main:app --port 8100'",
      url: "http://localhost:8100/api/v1/health/ready",
      reuseExistingServer: true,
      env: {
        CAMPUSCART_SUPABASE_URL: stack.CAMPUSCART_SUPABASE_URL ?? "",
        CAMPUSCART_DATABASE_URL: stack.CAMPUSCART_DATABASE_URL ?? "",
        CAMPUSCART_CORS_ALLOWED_ORIGINS: JSON.stringify(["http://localhost:8081"]),
      },
    },
    {
      command: "pnpm exec serve -s dist-web -l 8081",
      url: "http://localhost:8081",
      reuseExistingServer: true,
    },
  ],
});
