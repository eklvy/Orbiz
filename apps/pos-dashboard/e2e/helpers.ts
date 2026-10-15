// Shared by the POS and manager dashboard suites (the manager suite imports this file).
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

/** Throwaway password for users these tests create in the local database. */
export const PASSWORD = "E2e-Password-1";
/** Shared password of the fictional dev accounts in supabase/seeds/01_dev_identity.sql. */
export const SEED_PASSWORD = "DevOnly-CampusCart-2026";
export const NORTH_CAFE = "00000000-0000-4000-b000-000000000001";
export const PANEER_SANDWICH = "00000000-0000-4000-d000-000000000003"; // prepared, tracked
export const COLD_COFFEE = "00000000-0000-4000-d000-000000000002"; // packaged, tracked
export const EGG_ROLL = "00000000-0000-4000-d000-000000000004"; // prepared, untracked

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

/** Runs one statement as the server's system role (what pg_cron and the payment service use). */
async function asSystem(query: string, params: unknown[] = []): Promise<void> {
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

/** A fresh, confirmed student account with a recognisable name. */
export async function createStudent(
  name: string,
): Promise<{ id: string; email: string; name: string }> {
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
  return { id, email, name };
}

const tokens = new Map<string, string>();

export async function accessToken(email: string, password = PASSWORD): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const response = await fetch(
    `${process.env.E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: process.env.E2E_ANON_KEY ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
  );
  expect(response.ok).toBe(true);
  const token = ((await response.json()) as { access_token: string }).access_token;
  tokens.set(email, token);
  return token;
}

/** Calls the real API as a user; returns the parsed body and asserts the status. */
export async function api<T = Record<string, unknown>>(
  email: string,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    password?: string;
  } = {},
  expectStatus = 200,
): Promise<T> {
  const response = await fetch(`${process.env.E2E_API_URL}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await accessToken(email, init.password)}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(expectStatus);
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Stand-in for a provider-verified payment (the Phase 5 Razorpay webhook path). Calls the same
 * system-only database function the payment service will. Test-only.
 */
export async function confirmPaymentStandIn(orderId: string): Promise<void> {
  await asSystem("select app.confirm_order_payment($1, $2)", [orderId, `e2e-payment:${orderId}`]);
}

interface Order {
  id: string;
  token_label: string | null;
  pickup_code: string | null;
  status: string;
}

/** A student places an order at Dev North Café through the API, and it is paid (stand-in). */
export async function placePaidOrder(
  email: string,
  items: { menu_item_id: string; quantity: number }[],
): Promise<Order> {
  const slots = await api<{ id: string; bookable: boolean; starts_at: string }[]>(
    email,
    `/outlets/${NORTH_CAFE}/pickup-slots`,
  );
  // At least 10 minutes out, so every item's prep time fits.
  const slot = slots.find((s) => s.bookable && Date.parse(s.starts_at) > Date.now() + 10 * 60_000);
  if (!slot) throw new Error("no bookable slot at Dev North Café");
  const order = await api<Order>(
    email,
    "/orders",
    {
      method: "POST",
      headers: { "Idempotency-Key": `e2e-${randomUUID()}` },
      body: { outlet_id: NORTH_CAFE, pickup_slot_id: slot.id, items },
    },
    201,
  );
  await confirmPaymentStandIn(order.id);
  return api<Order>(email, `/orders/${order.id}`);
}

/**
 * Puts a ready order past its pickup deadline (gives it its own slot in the past, so other
 * tests' orders are untouched), then runs the no-show job as pg_cron would.
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
  await asSystem("select app.process_no_shows()");
}

/** Signs a staff member in on the dashboard's own sign-in form. */
export async function signInStaff(
  page: Page,
  email: string,
  password = SEED_PASSWORD,
): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
