import { execSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

/**
 * Manager dashboard end-to-end tests against the REAL backend: local Supabase (Auth,
 * Postgres, Realtime) and the CampusCart API. Start Supabase first (`pnpm db:start`); Playwright
 * starts (or reuses) the API on :8100 and this app on :3101.
 */
const WEB_PORT = 3101;
const API_PORT = 8100;

function stackEnv(): Record<string, string> {
  const exports = execSync("bash ../../scripts/supabase-env.sh", { encoding: "utf8" });
  return Object.fromEntries(
    [...exports.matchAll(/^export (\w+)='([^']*)'$/gm)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]),
  );
}

const stack = stackEnv();
process.env.E2E_SUPABASE_URL = stack.CAMPUSCART_SUPABASE_URL;
process.env.E2E_DATABASE_URL = stack.CAMPUSCART_DATABASE_URL;
process.env.E2E_ANON_KEY = stack.TEST_SUPABASE_ANON_KEY;
process.env.E2E_API_URL = `http://localhost:${API_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Each worker drives a browser against the full local stack (Docker); more than 2 starves the
  // database VM on a typical laptop and causes spurious timeouts.
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: `bash -c 'cd ../../services/api && exec .venv/bin/uvicorn app.main:app --port ${API_PORT}'`,
      url: `http://localhost:${API_PORT}/api/v1/health/ready`,
      reuseExistingServer: !process.env.CI,
      env: {
        CAMPUSCART_SUPABASE_URL: stack.CAMPUSCART_SUPABASE_URL ?? "",
        CAMPUSCART_DATABASE_URL: stack.CAMPUSCART_DATABASE_URL ?? "",
        CAMPUSCART_CORS_ALLOWED_ORIGINS: JSON.stringify([
          "http://localhost:3100",
          "http://localhost:3101",
          "http://localhost:3102",
        ]),
      },
    },
    {
      // Production build in CI; reuse a running dev server locally.
      command: `pnpm exec next build && pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_BASE_URL: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_SUPABASE_URL: stack.CAMPUSCART_SUPABASE_URL ?? "",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.TEST_SUPABASE_ANON_KEY ?? "",
      },
    },
  ],
});
