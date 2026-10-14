import { expect, test } from "@playwright/test";
import {
  confirmPaymentStandIn,
  createStudent,
  kitchen,
  orderIdFromUrl,
  signIn,
  sql,
} from "./helpers";

test.beforeEach(({ page }) => {
  // Accept the app's confirm() prompts (e.g. "Cancel this order?").
  page.on("dialog", (dialog) => void dialog.accept());
});

test("a new student can register and see their profile", async ({ page }) => {
  const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Playwright Student");
  await page.getByLabel("Campus email").fill(`pw-${suffix}@campuscart.test`);
  await page.getByLabel("Roll number").fill(`PW-${suffix}`);
  await page.getByLabel("Year (optional)").fill("2");
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("At least 8 characters")).toBeVisible();

  await page.getByLabel("Password").fill("Playwright-1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  await page.getByRole("link", { name: "Profile" }).click();
  await expect(page.getByText(`PW-${suffix}`, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Full name")).toHaveValue("Playwright Student");
});

test("signed-out visitors are sent to sign in and brought back", async ({ page }) => {
  const student = await createStudent();
  await page.goto("/orders");
  await expect(page).toHaveURL(/\/login\?next=%2Forders/);
  await page.getByLabel("Campus email").fill(student.email);
  await page.getByLabel("Password").fill("E2e-Password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/orders");
  await expect(page.getByText("No orders yet")).toBeVisible();
});

test("order, pay (stand-in), and watch the kitchen update the order live until pickup", async ({
  page,
}) => {
  const student = await createStudent();
  await signIn(page, student.email);

  await page.getByRole("link", { name: /Dev Sample North Café/ }).click();
  await page.getByRole("button", { name: "Add Paneer Sandwich" }).click();
  await page.getByRole("button", { name: "Add Masala Chai" }).click();
  await page.getByRole("button", { name: "Add one Masala Chai" }).click();
  await expect(page.getByRole("group", { name: "Masala Chai" })).toContainText("2");

  await page.getByRole("link", { name: "Choose pickup time" }).click();
  await expect(page.getByTestId("cart-total")).toHaveText("₹110");
  await page.locator('label:has(input[name="pickup-slot"]:not([disabled]))').first().click();
  await page.getByRole("button", { name: "Place order" }).click();

  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/Awaiting payment — items and slot held for/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Pay ₹110 \(coming soon\)/ })).toBeDisabled();
  const orderId = orderIdFromUrl(page);

  // From here on the page is never reloaded: every change must arrive over Realtime.
  await confirmPaymentStandIn(orderId);
  await expect(page.getByTestId("token")).toHaveText(/^N-\d+$/);
  const code = (await page.getByTestId("pickup-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/^[A-Z2-9]{6}$/);

  await kitchen(`/staff/orders/${orderId}/transition`, { to_status: "confirmed" });
  await expect(page.getByText("Accepted by kitchen").first()).toBeVisible();
  await kitchen(`/staff/orders/${orderId}/transition`, { to_status: "preparing" });
  await kitchen(`/staff/orders/${orderId}/transition`, { to_status: "ready_for_pickup" });
  await expect(page.getByText("Ready for pickup").first()).toBeVisible();

  await kitchen(`/staff/orders/${orderId}/verify-pickup`, { code });
  await expect(page.getByText("Collected").first()).toBeVisible();

  await page.getByRole("link", { name: "Orders" }).first().click();
  await expect(page.getByRole("link", { name: /Dev Sample North Café/ })).toContainText(
    "Collected",
  );
});

test("an unpaid order can be cancelled and its stock is released", async ({ page }) => {
  const student = await createStudent();
  await signIn(page, student.email);
  await page.goto("/outlets/dev-north-cafe");
  await page.getByRole("button", { name: "Add Cold Coffee" }).click();
  await page.getByRole("link", { name: "Choose pickup time" }).click();
  await page.locator('label:has(input[name="pickup-slot"]:not([disabled]))').first().click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText(/Awaiting payment — items and slot held for/)).toBeVisible();
  const orderId = orderIdFromUrl(page);

  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByText("Cancelled").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  await expect(page.getByText(/refund/i)).toHaveCount(0); // unpaid: nothing owed

  // Parallel tests share Cold Coffee stock, so check this order's own ledger entries instead:
  // the reservation (-1) and the release (+1) must net to zero.
  const ledger = await sql<{ reason: string; delta: number }>(
    "select reason::text, delta from public.inventory_movements where order_id = $1 order by id",
    [orderId],
  );
  expect(ledger).toEqual([
    { reason: "order_reserved", delta: -1 },
    { reason: "order_released", delta: 1 },
  ]);
});

test("menu filters and sold-out items", async ({ page }) => {
  const thali = "00000000-0000-4000-d000-000000000006";
  await sql("update public.menu_items set manual_status = 'sold_out' where id = $1", [thali]);
  try {
    await page.goto("/outlets/dev-south-canteen");
    const card = page.getByRole("article", { name: "Veg Thali" });
    await expect(card.getByText("Sold out").first()).toBeVisible();
    await expect(card.getByRole("button", { name: "Add Veg Thali" })).toBeDisabled();

    await page.getByRole("button", { name: "Non-veg" }).click();
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article", { name: "Chicken Kathi Roll" })).toBeVisible();

    await page.getByRole("button", { name: "All" }).click();
    await page.getByLabel("Available only").check();
    await expect(page.getByRole("article", { name: "Veg Thali" })).toHaveCount(0);
  } finally {
    await sql("update public.menu_items set manual_status = 'available' where id = $1", [thali]);
  }
});

test("stock changes reach an open menu live", async ({ page }) => {
  const roll = "00000000-0000-4000-d000-000000000007";
  await page.goto("/outlets/dev-south-canteen");
  const card = page.getByRole("article", { name: "Chicken Kathi Roll" });
  await expect(card).toBeVisible();
  const [row] = await sql<{ q: number }>(
    "select quantity_available as q from public.inventory where menu_item_id = $1",
    [roll],
  );
  const q = row?.q ?? 0;
  try {
    await sql("update public.inventory set quantity_available = 0 where menu_item_id = $1", [roll]);
    await expect(card.getByText("Sold out").first()).toBeVisible();
  } finally {
    await sql("update public.inventory set quantity_available = $2 where menu_item_id = $1", [
      roll,
      q,
    ]);
  }
});
