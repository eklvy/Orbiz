import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";

const PASSWORD = "E2e-Password-1"; // throwaway local test user
const SEED_PASSWORD = "DevOnly-CampusCart-2026"; // fictional dev accounts (supabase/seeds)

async function sql(query: string, params: unknown[] = []) {
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(query, params)).rows;
  } finally {
    await client.end();
  }
}

async function createStudent() {
  const id = randomUUID();
  const email = `app-${id.slice(0, 12)}@campuscart.test`;
  await sql(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change, email_change_token_new)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
       extensions.crypt($3, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}',
       $4, now(), now(), '', '', '', '')`,
    [
      id,
      email,
      PASSWORD,
      JSON.stringify({ full_name: "App Student", roll_number: `APP-${id.slice(0, 8)}` }),
    ],
  );
  await sql(
    `insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
     values (gen_random_uuid(), $1::uuid, $1::text, 'email',
       jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), now(), now(), now())`,
    [id, email],
  );
  return email;
}

/** Stand-in for a provider-verified payment (Phase 5 webhook path); test-only. */
async function confirmPaymentStandIn(orderId: string) {
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('role', 'service_role', true)");
    await client.query("select app.confirm_order_payment($1, $2)", [orderId, `app-e2e:${orderId}`]);
    await client.query("commit");
  } finally {
    await client.end();
  }
}

async function kitchen(path: string, body: unknown) {
  const auth = await fetch(`${process.env.E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.E2E_ANON_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "kitchen.north@campuscart.test", password: SEED_PASSWORD }),
  });
  const { access_token } = (await auth.json()) as { access_token: string };
  const response = await fetch(`${process.env.E2E_API_URL}/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.text()).toBe(200);
}

test("student app: sign in, order, and follow the kitchen live until pickup", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const email = await createStudent();

  await page.goto("/");
  await expect(page.getByText("Skip the queue.")).toBeVisible();
  await page.getByRole("tab", { name: /Profile/ }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Campus email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("App Student").or(page.getByText(email)).first()).toBeVisible();

  await page.getByRole("tab", { name: /Outlets/ }).click();
  await page.getByRole("link", { name: /Dev Sample North Café/ }).click();
  await page.getByRole("button", { name: "Add Paneer Sandwich" }).click();
  await page.getByRole("button", { name: "Add Masala Chai" }).click();
  await page.getByRole("button", { name: "Choose pickup time" }).click();

  await expect(page.getByTestId("cart-total")).toHaveText("₹90");
  await page.getByRole("radio", { disabled: false }).first().click();
  await page.getByRole("button", { name: "Place order" }).click();

  await expect(page.getByText(/Awaiting payment — held for/)).toBeVisible();
  const orderId = /\/order\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  expect(orderId).toBeTruthy();

  // No reloads from here: updates must arrive over Realtime.
  await confirmPaymentStandIn(orderId as string);
  await expect(page.getByTestId("token")).toHaveText(/^N-\d+$/);
  const code = ((await page.getByTestId("pickup-code").textContent()) ?? "").trim();

  for (const to of ["confirmed", "preparing", "ready_for_pickup"]) {
    await kitchen(`/staff/orders/${orderId}/transition`, { to_status: to });
  }
  await expect(page.getByText("Ready for pickup").first()).toBeVisible();
  await kitchen(`/staff/orders/${orderId}/verify-pickup`, { code });
  await expect(page.getByText("Collected").first()).toBeVisible();
});
