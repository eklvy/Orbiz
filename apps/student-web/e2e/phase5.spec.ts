import { expect, test } from "@playwright/test";
import {
  MANAGER_NORTH,
  apiAs,
  awardPointsStandIn,
  createStudent,
  fundWalletStandIn,
  kitchen,
  orderIdFromUrl,
  signIn,
} from "./helpers";

test.beforeEach(({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
});

test("voucher + wallet payment, live token, review, points and notifications", async ({ page }) => {
  const student = await createStudent("Wallet Student");
  await fundWalletStandIn(student.id, 50000);
  await awardPointsStandIn(student.id, 100);
  await signIn(page, student.email);

  await page.goto("/rewards");
  await expect(page.getByTestId("points-balance")).toContainText("100");
  await page.getByRole("button", { name: /Get a ₹10 voucher for 100 points/ }).click();
  const code = (await page.getByTestId("voucher-code").first().textContent())?.trim() ?? "";
  expect(code).toMatch(/^CC-[A-Z2-9]{8}$/);

  await page.goto("/outlets/cafe-1");
  await page.getByRole("button", { name: "Add Egg Roll" }).click();
  await page.getByRole("link", { name: "Choose pickup time" }).click();
  await page.locator('label:has(input[name="pickup-slot"]:not([disabled]))').first().click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderId = orderIdFromUrl(page);

  await expect(page.getByTestId("amount-due")).toHaveText("₹55");
  await page.getByLabel("Have a voucher?").fill(code);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("amount-due")).toHaveText("₹45");
  await expect(page.getByTestId("wallet-balance")).toContainText("₹500");
  await page.getByRole("button", { name: "Pay ₹45 from wallet" }).click();
  await expect(page.getByTestId("token")).toHaveText(/^N-\d+$/);
  await expect(page.getByTestId("points-earned")).toHaveText("+4 loyalty points");

  const { pickup_code } = await apiAs<{ pickup_code: string }>(student.email, `/orders/${orderId}`);
  for (const to_status of ["confirmed", "preparing", "ready_for_pickup"]) {
    await kitchen(`/staff/orders/${orderId}/transition`, { to_status });
  }
  await kitchen(`/staff/orders/${orderId}/verify-pickup`, { code: pickup_code });
  const form = page.getByRole("form", { name: "Rate your order" });
  await expect(form).toBeVisible();
  for (const dimension of ["Taste", "Hygiene", "Pickup speed", "Value"]) {
    await form.getByText(`5 stars for ${dimension}`).click();
  }
  await form.getByRole("button", { name: "Post review" }).click();
  await expect(page.getByRole("region", { name: "Your review" })).toContainText("Taste 5");

  // Notifications arrived as things happened (unread badge in the header).
  await expect(page.getByTestId("unread-count")).toBeVisible();
  await page.getByRole("link", { name: /^Notifications/ }).click();
  await expect(page.getByTestId("notification").filter({ hasText: "placed" })).toHaveCount(1);
  await expect(
    page.getByTestId("notification").filter({ hasText: "You earned 15 points" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: /Mark all as read/ }).click();
  await expect(page.getByTestId("unread-count")).toHaveCount(0);

  await page.goto("/wallet");
  await expect(page.getByTestId("wallet-balance")).toHaveText("₹455");
  await expect(page.getByText("Online top-up isn't set up on this server yet")).toBeVisible();
});

test("group order: friends join with a code, split by dish and each pay their share", async ({
  page,
  browser,
}) => {
  const host = await createStudent("Squad Host");
  const friend = await createStudent("Squad Friend");
  await fundWalletStandIn(host.id, 20000);
  await fundWalletStandIn(friend.id, 20000);
  await signIn(page, host.email);
  await page.goto("/groups");
  const start = page.getByRole("form", { name: "Start a group order" });
  await start.getByLabel("Outlet").selectOption({ label: "Cafe 1" });
  await start.getByLabel("Pickup time").selectOption({ index: 2 });
  await start.getByRole("button", { name: "Start group order" }).click();
  await expect(page).toHaveURL(/\/groups\/[0-9a-f-]{36}$/);
  const code = (await page.getByTestId("invite-code").textContent())?.trim() ?? "";

  const friendContext = await browser.newContext();
  const friendPage = await friendContext.newPage();
  try {
    await signIn(friendPage, friend.email);
    await friendPage.goto("/groups");
    await friendPage
      .getByRole("form", { name: "Join a group order" })
      .getByLabel("Invite code")
      .fill(code);
    await friendPage.getByRole("button", { name: "Join" }).click();
    await expect(friendPage).toHaveURL(page.url());
    await friendPage.getByRole("button", { name: "One more Egg Roll" }).click();
    // The host sees the friend and their dish live.
    await expect(page.getByRole("listitem", { name: "Squad Friend's items" })).toContainText(
      "1 × Egg Roll",
    );

    await page.getByRole("button", { name: "One more Masala Chai" }).click();
    await page.getByRole("button", { name: "Check out the group order" }).click();
    await expect(page.getByTestId("group-total")).toHaveText("₹75");
    await page.getByRole("button", { name: /Pay my share ₹20 from wallet/ }).click();
    await expect(
      friendPage.getByRole("button", { name: /Pay my share ₹55 from wallet/ }),
    ).toBeVisible();
    await friendPage.getByRole("button", { name: /Pay my share ₹55 from wallet/ }).click();
    await expect(page.getByText(/Everyone paid\. Token N-\d+ is with the kitchen/)).toBeVisible();
  } finally {
    await friendContext.close();
  }
});

test("today's special price and a live poll vote", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "creates a shared special and poll once");
  // South Canteen's Rajma Chawal (₹80) isn't used by other tests, so their prices are unaffected.
  const south = "00000000-0000-4000-b000-000000000002";
  const rajma = "00000000-0000-4000-d000-000000000005";
  const thali = "00000000-0000-4000-d000-000000000006";
  const manager = { email: "manager.south@campuscart.test", password: MANAGER_NORTH.password };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const specials = await apiAs<{ id: string; menu_item_id: string }[]>(
    manager.email,
    `/manage/outlets/${south}/specials`,
    {
      method: "PUT",
      body: { menu_item_id: rajma, special_date: today, discount_percent: 20, portions: 50 },
    },
    { password: manager.password },
  );
  const special = specials.find((s) => s.menu_item_id === rajma);
  try {
    const question = `Pick a dish ${Date.now()}`;
    await apiAs(
      manager.email,
      `/manage/outlets/${south}/polls`,
      {
        method: "POST",
        body: {
          question,
          menu_item_ids: [rajma, thali],
          closes_at: new Date(Date.now() + 3_600_000).toISOString(),
          special_date: today,
          special_discount_percent: 15,
          special_portions: 20,
        },
      },
      { password: manager.password, status: 201 },
    );
    const student = await createStudent("Voting Student");
    await signIn(page, student.email);
    await page.goto("/outlets/cafe-10");
    await expect(
      page.getByRole("article", { name: "Rajma Chawal" }).getByTestId("special-price"),
    ).toContainText("₹64");
    const poll = page.getByRole("group", { name: question });
    await poll.getByRole("button", { name: /^Rajma Chawal: 0%\. Vote$/ }).click();
    await expect(
      poll.getByRole("button", { name: /^Rajma Chawal: 100%, your vote$/ }),
    ).toBeVisible();
  } finally {
    if (special) {
      await apiAs(
        manager.email,
        `/manage/specials/${special.id}`,
        { method: "DELETE" },
        { password: manager.password, status: 204 },
      );
    }
  }
});

test("budget planner shows spending against the limit", async ({ page }) => {
  const student = await createStudent("Budget Student");
  await signIn(page, student.email);
  await page.goto("/budget");
  await expect(page.getByTestId("month-spent")).toHaveText("₹0");
  await page.getByLabel("Monthly limit (₹)").fill("2000");
  await page.getByRole("button", { name: "Save budget" }).click();
  await expect(page.getByText("On track")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "This month spending" })).toBeVisible();
});
