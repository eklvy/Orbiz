import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
// One helper module for both dashboard suites (it lives with the POS suite).
import {
  COLD_COFFEE,
  EGG_ROLL,
  NORTH_CAFE,
  api,
  createStudent,
  placePaidOrder,
  signInStaff,
  sql,
} from "../../pos-dashboard/e2e/helpers";

const NORTH_MANAGER = "manager.north@campuscart.test";
const SOUTH_MANAGER = "manager.south@campuscart.test";
const KITCHEN = "kitchen.north@campuscart.test";
const SEED_PASSWORD = "DevOnly-CampusCart-2026";
const SOUTH_CANTEEN = "00000000-0000-4000-b000-000000000002";

async function openSection(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Manager sections" })
    .getByRole("link", { name })
    .click();
}

/** Takes a paid order at North Café through the kitchen to pickup (as the dev kitchen account). */
async function collectedOrder(email: string): Promise<{ id: string; token_label: string }> {
  const order = await placePaidOrder(email, [{ menu_item_id: EGG_ROLL, quantity: 1 }]);
  for (const to_status of ["confirmed", "preparing", "ready_for_pickup"]) {
    await api(KITCHEN, `/staff/orders/${order.id}/transition`, {
      method: "POST",
      body: { to_status },
      password: SEED_PASSWORD,
    });
  }
  await api(KITCHEN, `/staff/orders/${order.id}/verify-pickup`, {
    method: "POST",
    body: { code: order.pickup_code },
    password: SEED_PASSWORD,
  });
  return { id: order.id, token_label: order.token_label as string };
}

// These two change shared outlet state (status, a slot, settings), so they run once, on the
// desktop project; the mobile layout of the same pages is covered by the accessibility test.
test("cafe status: take a break with a public reason, then reopen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "changes shared outlet state");
  // South Canteen: other suites order at North Café in parallel.
  await signInStaff(page, SOUTH_MANAGER);
  await expect(
    page.getByRole("heading", { level: 1, name: "Dev Sample South Canteen" }),
  ).toBeVisible();
  try {
    await page.getByRole("button", { name: "Take a break" }).click();
    await page.getByLabel("Break length").selectOption("30");
    await page.getByLabel("Reason shown to students (optional)").fill("Restocking the counter");
    await page.getByRole("button", { name: "Start break" }).click();
    await expect(page.getByTestId("outlet-status")).toHaveText("On a break");
    await expect(page.getByText("Students see: “Restocking the counter”")).toBeVisible();

    const publicView = await fetch(`${process.env.E2E_API_URL}/api/v1/outlets/${SOUTH_CANTEEN}`);
    expect(await publicView.json()).toMatchObject({
      status: "on_break",
      accepting_orders: false,
      status_reason: "Restocking the counter",
    });
    // The fleet table updates live too.
    await expect(page.getByRole("row", { name: /Dev Sample South Canteen/ })).toContainText(
      "On a break",
    );
  } finally {
    await page.getByRole("button", { name: "Open", exact: true }).click();
  }
  await expect(page.getByTestId("outlet-status")).toHaveText("Open");
});

test("menu: add a packaged item, reprice it, mark it sold out, and restock", async ({ page }) => {
  const name = `E2E Water ${randomUUID().slice(0, 6)}`;
  await signInStaff(page, NORTH_MANAGER);
  await openSection(page, "Menu & stock");
  try {
    await page.getByRole("button", { name: "Add item" }).click();
    const form = page.getByRole("form", { name: "New menu item" });
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Price (₹)").fill("19.999");
    await form.getByRole("button", { name: "Add item" }).click();
    await expect(form.getByText("Enter a price in rupees")).toBeVisible();
    await form.getByLabel("Price (₹)").fill("19.50");
    await form.getByLabel("Category").selectOption({ label: "Beverages" });
    await form.getByLabel("Packaged item").check();
    await form.getByRole("button", { name: "Add item" }).click();

    const row = page.getByRole("listitem", { name });
    await expect(row).toContainText("₹19.50");
    await expect(row).toContainText("Packaged");
    const menu = await (
      await fetch(`${process.env.E2E_API_URL}/api/v1/outlets/${NORTH_CAFE}/menu`)
    ).json();
    const beverages = (
      menu as { categories: { name: string; items: { name: string; price_paise: number }[] }[] }
    ).categories.find((c) => c.name === "Beverages");
    expect(beverages?.items.find((i) => i.name === name)?.price_paise).toBe(1950);

    await row.getByRole("button", { name: "Edit details" }).click();
    const edit = page.getByRole("form", { name: `Edit ${name}` });
    await edit.getByLabel("Price (₹)").fill("25");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(row).toContainText("₹25");

    await row
      .getByRole("group", { name: `Availability of ${name}` })
      .getByRole("button", { name: "Sold out" })
      .click();
    await expect(row.getByText("Sold out", { exact: true }).first()).toBeVisible();
    const [stored] = await sql<{ stock_status: string; price_paise: number; is_packaged: boolean }>(
      "select stock_status::text, price_paise, is_packaged from public.menu_items where outlet_id = $1 and name = $2",
      [NORTH_CAFE, name],
    );
    expect(stored).toEqual({ stock_status: "sold_out", price_paise: 2500, is_packaged: true });
  } finally {
    await sql("update public.menu_items set is_active = false where outlet_id = $1 and name = $2", [
      NORTH_CAFE,
      name,
    ]);
  }

  // Restocking a counted item writes the stock ledger.
  const coffee = page.getByRole("listitem", { name: "Cold Coffee" });
  await coffee.getByLabel("Restock Cold Coffee").fill("3");
  await coffee.getByRole("button", { name: "Add stock" }).click();
  await expect(coffee.getByLabel("Restock Cold Coffee")).toHaveValue("");
  const [movement] = await sql<{ delta: number; reason: string }>(
    "select delta, reason::text from public.inventory_movements where menu_item_id = $1 and reason = 'restock' order by id desc limit 1",
    [COLD_COFFEE],
  );
  expect(movement).toEqual({ delta: 3, reason: "restock" });
});

test("refunds desk: approve and decline student requests", async ({ page }) => {
  const first = await createStudent("Refund Desk One");
  const second = await createStudent("Refund Desk Two");
  const a = await collectedOrder(first.email);
  const b = await collectedOrder(second.email);

  await signInStaff(page, NORTH_MANAGER);
  await openSection(page, "Refunds");
  await expect(page.getByRole("heading", { name: "Pending requests" })).toBeVisible();

  // Requests arrive live while the desk is open.
  for (const [student, order, reason] of [
    [first, a, "Roll was cold in the middle"],
    [second, b, "Got the wrong order"],
  ] as const) {
    await api(
      student.email,
      `/orders/${order.id}/refund-request`,
      { method: "POST", body: { reason } },
      201,
    );
  }
  const requestA = page.getByRole("listitem", { name: `Refund request for ${a.token_label}` });
  const requestB = page.getByRole("listitem", { name: `Refund request for ${b.token_label}` });
  await expect(requestA).toContainText("Refund Desk One");
  await expect(requestA).toContainText("Roll was cold in the middle");

  await requestA.getByRole("button", { name: /^Approve ₹55 refund$/ }).click();
  await expect(requestA).toHaveCount(0);
  // Owed, or already paid into the wallet by the minute payout job (D-20).
  expect(["required", "refunded"]).toContain(
    (await api<{ refund_status: string }>(first.email, `/orders/${a.id}`)).refund_status,
  );

  await requestB.getByRole("button", { name: "Decline" }).click();
  await requestB.getByLabel("Note for the student").fill("The kitchen log shows the right order");
  await requestB.getByRole("button", { name: "Decline request" }).click();
  await expect(requestB).toHaveCount(0);
  const declined = await api<{ refund_request: { status: string; decision_note: string } }>(
    second.email,
    `/orders/${b.id}`,
  );
  expect(declined.refund_request).toMatchObject({
    status: "declined",
    decision_note: "The kitchen log shows the right order",
  });
  await expect(page.getByRole("heading", { name: "Recent decisions" })).toBeVisible();
});

test("staff: add kitchen staff by email and remove them", async ({ page }) => {
  const newcomer = await createStudent("New Kitchen Hire");
  await signInStaff(page, NORTH_MANAGER);
  await openSection(page, "Staff");
  await page.getByLabel("Add kitchen staff by email").fill("nobody-at-all@campuscart.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("No CampusCart account uses that email")).toBeVisible();

  await page.getByLabel("Add kitchen staff by email").fill(newcomer.email.toUpperCase());
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const member = page.getByRole("listitem").filter({ hasText: newcomer.email });
  await expect(member).toContainText("New Kitchen Hire");
  await expect(member).toContainText("Kitchen staff");
  await api(newcomer.email, `/staff/outlets/${NORTH_CAFE}/orders`);

  page.once("dialog", (dialog) => void dialog.accept());
  await member.getByRole("button", { name: "Remove" }).click();
  await expect(member).toHaveCount(0);
  await api(newcomer.email, `/staff/outlets/${NORTH_CAFE}/orders`, {}, 403);
});

test("slots and settings", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "changes shared outlet state");
  await signInStaff(page, SOUTH_MANAGER);
  await openSection(page, "Slots & hours");
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(Date.now() + 86_400_000),
  );
  await page.getByLabel("Date").fill(tomorrow);
  const firstSlot = page.getByRole("listitem", { name: /^Slot / }).first();
  await expect(firstSlot).toBeVisible();
  const capacity = firstSlot.getByLabel(/^Capacity/);
  const before = await capacity.inputValue();
  try {
    await capacity.fill("7");
    await firstSlot.getByRole("button", { name: "Save" }).click();
    await expect(firstSlot).toContainText("booked of 7");
    await firstSlot.getByRole("button", { name: "Stop bookings" }).click();
    await expect(firstSlot).toContainText("Not taking bookings");
    await firstSlot.getByRole("button", { name: "Resume bookings" }).click();
    await expect(firstSlot).not.toContainText("Not taking bookings");
  } finally {
    await capacity.fill(before);
    await firstSlot.getByRole("button", { name: "Save" }).click();
  }

  await openSection(page, "Settings");
  const grace = page.getByLabel("Pickup grace period (minutes)");
  await expect(grace).toHaveValue("15"); // the D-19 default
  try {
    await grace.fill("20");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    const [row] = await sql<{ g: number }>(
      "select no_show_grace_minutes as g from public.outlets where id = $1",
      [SOUTH_CANTEEN],
    );
    expect(row?.g).toBe(20);
  } finally {
    await sql("update public.outlets set no_show_grace_minutes = 15 where id = $1", [
      SOUTH_CANTEEN,
    ]);
  }
});

test("kitchen staff and students cannot use the manager console", async ({ page }) => {
  await signInStaff(page, KITCHEN);
  await expect(page.getByRole("alert").filter({ hasText: "doesn't manage" })).toHaveText(
    "This account doesn't manage any outlet. Ask an administrator for access.",
  );
  // The API refuses regardless of what the UI shows.
  await api(KITCHEN, `/manage/outlets/${NORTH_CAFE}/refunds`, { password: SEED_PASSWORD }, 403);
});

test("every section is accessible and fits the screen", async ({ page }) => {
  await signInStaff(page, NORTH_MANAGER);
  const sections: [string, string, RegExp][] = [
    ["Overview", "/", /^Dev Sample North Café$/],
    ["Kitchen", "/kitchen", /^Kitchen queue$/],
    ["Menu & stock", "/menu", /^Menu & stock$/],
    ["Refunds", "/refunds", /^Refunds & cancellations$/],
    ["Slots & hours", "/slots", /^Slots & hours$/],
    ["Staff", "/staff", /^Staff$/],
    ["Settings", "/settings", /^Settings$/],
  ];
  for (const [section, path, heading] of sections) {
    await openSection(page, section);
    // Wait for this section (not the previous one) to finish loading before scanning it.
    await expect(page).toHaveURL(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("status", { name: /^Loading/ })).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const serious = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(serious, `${section}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${section} scrolls sideways`).toBeLessThanOrEqual(0);
  }
});
