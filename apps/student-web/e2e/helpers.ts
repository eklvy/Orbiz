import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

/** Throwaway password for users these tests create in the local database. */
export const PASSWORD = "E2e-Password-1";
/** Shared password of the fictional dev accounts in supabase/seeds/01_dev_identity.sql. */
const SEED_PASSWORD = "DevOnly-CampusCart-2026";

export async function sql<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** A fresh, confirmed student account (created directly so tests never share carts or orders). */
export async function createStudent(name = "E2E Student"): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `e2e-${id.slice(0, 12)}@campuscart.test`;
  await sql(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change, email_change_token_new)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
       extensions.crypt($3, extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', $4, now(), now(), '', '', '', '')`,
    [
      id,
      email,
      PASSWORD,
      JSON.stringify({ full_name: name, roll_number: `E2E-${id.slice(0, 8)}` }),
    ],
  );
  await sql(
    `insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
     values (gen_random_uuid(), $1::uuid, $1::text, 'email',
       jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), now(), now(), now())`,
    [id, email],
  );
  return { id, email };
}

export async function signIn(
  page: Page,
  email: string,
  password = PASSWORD,
  path = "/login",
): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Campus email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Stand-in for a provider-verified payment (the Phase 5 Razorpay webhook path). Calls the same
 * system-only database function the payment service will, as the server's system role.
 * Test-only: no such path exists for browsers or students.
 */
export async function confirmPaymentStandIn(orderId: string): Promise<void> {
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('role', 'service_role', true)");
    await client.query("select app.confirm_order_payment($1, $2)", [
      orderId,
      `e2e-payment:${orderId}`,
    ]);
    await client.query("commit");
  } finally {
    await client.end();
  }
}

let kitchenToken: string | undefined;

async function kitchenAuth(): Promise<string> {
  if (!kitchenToken) {
    const response = await fetch(
      `${process.env.E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: { apikey: process.env.E2E_ANON_KEY ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "kitchen.north@campuscart.test", password: SEED_PASSWORD }),
      },
    );
    expect(response.ok).toBe(true);
    kitchenToken = ((await response.json()) as { access_token: string }).access_token;
  }
  return kitchenToken;
}

/** Acts as Dev North Café kitchen staff through the real API (the Phase 4 POS will do this). */
export async function kitchen(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${process.env.E2E_API_URL}/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await kitchenAuth()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.text()).toBe(200);
}

export function orderIdFromUrl(page: Page): string {
  const match = /\/orders\/([0-9a-f-]{36})/.exec(page.url());
  if (!match?.[1]) throw new Error(`not on an order page: ${page.url()}`);
  return match[1];
}

/** Calls the real API as any account (password grant). Asserts the status; returns the body. */
export async function apiAs<T = Record<string, unknown>>(
  email: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  { password = PASSWORD, status = 200 }: { password?: string; status?: number } = {},
): Promise<T> {
  const auth = await fetch(`${process.env.E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.E2E_ANON_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(auth.ok).toBe(true);
  const token = ((await auth.json()) as { access_token: string }).access_token;
  const response = await fetch(`${process.env.E2E_API_URL}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

export const MANAGER_NORTH = { email: "manager.north@campuscart.test", password: SEED_PASSWORD };

/**
 * Puts a ready order past its pickup deadline (its own slot in the past, so other tests' orders
 * are untouched) and runs the no-show job as the system role, as pg_cron does every minute.
 */
export async function makeNoShow(orderId: string): Promise<void> {
  const [slot] = await sql<{ id: string }>(
    `insert into public.pickup_slots (outlet_id, starts_at, ends_at, capacity, reserved_count, is_active)
     select o.outlet_id, now() - interval '45 minutes' - random() * interval '30 days',
            now() - interval '30 minutes', 1, 1, false
     from public.orders o where o.id = $1
     returning id`,
    [orderId],
  );
  await sql(
    "update public.orders set ready_at = now() - interval '50 minutes', pickup_slot_id = $2 where id = $1",
    [orderId, slot?.id],
  );
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('role', 'service_role', true)");
    await client.query("select app.process_no_shows()");
    await client.query("commit");
  } finally {
    await client.end();
  }
}

/** Runs one statement as the server's system role (as pg_cron and the payment service do). */
export async function asSystem(query: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('role', 'service_role', true)");
    await client.query(query, params);
    await client.query("commit");
  } finally {
    await client.end();
  }
}

/**
 * Stand-in for a verified Razorpay top-up: registers and captures a payment through the same
 * system-only functions the webhook uses. Test-only; no real money and no Razorpay call.
 */
export async function fundWalletStandIn(userId: string, paise: number): Promise<void> {
  const ref = `e2e-topup-${randomUUID()}`;
  await asSystem("select app.register_payment($1, 'wallet_topup', null, $2, $3)", [
    userId,
    paise,
    ref,
  ]);
  await asSystem("select app.capture_payment($1, $2, $3)", [ref, `pay-${ref}`, paise]);
}

/** Test-only: award loyalty points directly (as a review would), so a voucher can be redeemed. */
export async function awardPointsStandIn(userId: string, points: number): Promise<void> {
  await sql("select private.loyalty_post($1, $2, 'review')", [userId, points]);
}
