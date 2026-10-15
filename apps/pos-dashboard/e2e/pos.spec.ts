import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  COLD_COFFEE,
  EGG_ROLL,
  PANEER_SANDWICH,
  PASSWORD,
  api,
  confirmPaymentStandIn,
  createStudent,
  makeNoShow,
  placePaidOrder,
  signInStaff,
  sql,
} from "./helpers";

const KITCHEN = "kitchen.north@campuscart.test";

/** The card for one order on the board (located by its token). */
function card(page: Page, token: string) {
  return page.getByRole("listitem", { name: `Order ${token}` });
}

test("a paid order appears live and goes through the kitchen to pickup", async ({ page }) => {
  await signInStaff(page, KITCHEN);
  await expect(page.getByRole("heading", { name: /^New/ })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  // Placed after the board is open: it must arrive over Realtime, without a reload.
  const student = await createStudent("Pos Flow Student");
  const order = await placePaidOrder(student.email, [
    { menu_item_id: EGG_ROLL, quantity: 2 },
    { menu_item_id: COLD_COFFEE, quantity: 1 },
  ]);
  const token = order.token_label as string;
  const newColumn = page.getByRole("region", { name: /^New/ });
  await expect(newColumn.getByRole("listitem", { name: `Order ${token}` })).toBeVisible();
  await expect(card(page, token)).toContainText("Pos Flow Student");
  await expect(card(page, token)).toContainText("Cold Coffee · packaged");

  await card(page, token).getByRole("button", { name: "Accept" }).click();
  await expect(
    page
      .getByRole("region", { name: /^Accepted/ })
      .getByRole("listitem", { name: `Order ${token}` }),
  ).toBeVisible();
  await card(page, token).getByRole("button", { name: "Start preparing" }).click();
  await card(page, token).getByRole("button", { name: "Mark ready" }).click();
  const ready = page.getByRole("region", { name: /^Ready for pickup/ });
  await expect(ready.getByRole("listitem", { name: `Order ${token}` })).toContainText("Collect by");

  // The student's own screen would show this status too; check it through the API.
  const live = await api<{ status: string }>(student.email, `/orders/${order.id}`);
  expect(live.status).toBe("ready_for_pickup");

  const codeField = card(page, token).getByLabel(`Pickup code for ${token}`);
  await codeField.fill("WRONG2");
  await card(page, token).getByRole("button", { name: "Hand over" }).click();
  await expect(card(page, token).getByRole("alert")).toContainText("Pickup code does not match");

  await codeField.fill(order.pickup_code as string);
  await card(page, token).getByRole("button", { name: "Hand over" }).click();
  await expect(page.getByTestId("announcement")).toHaveText(`${token} collected`);
  await expect(card(page, token)).toHaveCount(0);
  expect((await api<{ status: string }>(student.email, `/orders/${order.id}`)).status).toBe(
    "completed",
  );
});

test("rejecting needs a reason, and the paid student is owed a refund", async ({ page }) => {
  await signInStaff(page, KITCHEN);
  const student = await createStudent("Pos Reject Student");
  const order = await placePaidOrder(student.email, [{ menu_item_id: EGG_ROLL, quantity: 1 }]);
  const token = order.token_label as string;
  await card(page, token).getByRole("button", { name: "Reject" }).click();
  const reject = card(page, token).getByRole("button", { name: "Reject order" });
  await expect(reject).toBeDisabled();
  await card(page, token).getByLabel("Reason (shown to the student)").fill("Out of eggs");
  await reject.click();
  await expect(card(page, token)).toHaveCount(0);
  const after = await api<{ status: string; refund_status: string; cancel_reason: string }>(
    student.email,
    `/orders/${order.id}`,
  );
  expect(after).toMatchObject({ status: "rejected", cancel_reason: "Out of eggs" });
  // Owed, or already paid into the wallet by the minute payout job (D-20).
  expect(["required", "refunded"]).toContain(after.refund_status);
});

test("a scanned pickup QR completes the right order", async ({ page }) => {
  await signInStaff(page, KITCHEN);
  const student = await createStudent("Pos Scan Student");
  const order = await placePaidOrder(student.email, [{ menu_item_id: EGG_ROLL, quantity: 1 }]);
  const token = order.token_label as string;
  for (const step of ["Accept", "Start preparing", "Mark ready"]) {
    await card(page, token).getByRole("button", { name: step }).click();
  }
  await expect(
    page
      .getByRole("region", { name: /^Ready for pickup/ })
      .getByRole("listitem", { name: `Order ${token}` }),
  ).toBeVisible();

  const scanner = page.getByLabel("Scan a pickup QR");
  await scanner.fill("A-12 not a pass");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That isn't a CampusCart pickup QR")).toBeVisible();
  // What a USB/Bluetooth scanner types from the student's Digital Food Pass.
  await scanner.fill(`campuscart:pickup:${order.id}:${order.pickup_code}`);
  await scanner.press("Enter");
  await expect(page.getByTestId("announcement")).toHaveText(`${token} collected`);
});

test("an uncollected order becomes a deal and the counter sees the new owner", async ({ page }) => {
  await signInStaff(page, KITCHEN);
  const owner = await createStudent("Pos NoShow Owner");
  const order = await placePaidOrder(owner.email, [
    { menu_item_id: PANEER_SANDWICH, quantity: 1 },
    { menu_item_id: COLD_COFFEE, quantity: 1 },
  ]);
  const token = order.token_label as string;
  for (const step of ["Accept", "Start preparing", "Mark ready"]) {
    await card(page, token).getByRole("button", { name: step }).click();
  }
  await expect(card(page, token)).toContainText("Collect by");

  await makeNoShow(order.id);
  await expect(card(page, token)).toHaveCount(0);
  const dealRow = page.getByTestId("staff-deal").filter({ hasText: `From ${token}` });
  await expect(dealRow).toContainText("On sale");
  await expect(dealRow).toContainText("1 × Paneer Sandwich · ₹35");
  await expect(dealRow).not.toContainText("Cold Coffee"); // packaged: back in stock instead
  const ledger = await sql<{ reason: string }>(
    "select reason::text from public.inventory_movements where order_id = $1 and menu_item_id = $2 order by id",
    [order.id, COLD_COFFEE],
  );
  expect(ledger.map((r) => r.reason)).toEqual(["order_reserved", "no_show_return"]);

  // Another student buys the deal; once their payment is verified, the counter shows them.
  const buyer = await createStudent("Pos Deal Buyer");
  const deals = await api<{ id: string; items: { item_name: string }[] }[]>(
    buyer.email,
    "/outlets/00000000-0000-4000-b000-000000000001/deals",
  );
  const [deal] = await sql<{ id: string }>(
    "select id from public.surplus_deals where source_order_id = $1",
    [order.id],
  );
  expect(deals.map((d) => d.id)).toContain(deal?.id);
  const bought = await api<{ id: string }>(
    buyer.email,
    `/deals/${deal?.id}/claim`,
    { method: "POST", headers: { "Idempotency-Key": `e2e-claim-${order.id}` } },
    201,
  );
  await confirmPaymentStandIn(bought.id);
  const paid = await api<{ token_label: string; pickup_code: string }>(
    buyer.email,
    `/orders/${bought.id}`,
  );

  const resold = card(page, paid.token_label);
  await expect(resold).toContainText("Pos Deal Buyer");
  await expect(resold).toContainText(`Deal · was ${token}`);
  await expect(dealRow).toContainText(`From ${token} → ${paid.token_label}`);
  await expect(dealRow).toContainText("Sold");

  await resold.getByLabel(`Pickup code for ${paid.token_label}`).fill(paid.pickup_code);
  await resold.getByRole("button", { name: "Hand over" }).click();
  await expect(page.getByTestId("announcement")).toHaveText(`${paid.token_label} collected`);
});

test("kitchen staff can withdraw a deal with a reason", async ({ page }) => {
  await signInStaff(page, KITCHEN);
  const owner = await createStudent("Pos Withdraw Owner");
  const order = await placePaidOrder(owner.email, [{ menu_item_id: EGG_ROLL, quantity: 1 }]);
  const token = order.token_label as string;
  for (const step of ["Accept", "Start preparing", "Mark ready"]) {
    await card(page, token).getByRole("button", { name: step }).click();
  }
  await expect(card(page, token)).toContainText("Collect by");
  await makeNoShow(order.id);
  const dealRow = page.getByTestId("staff-deal").filter({ hasText: `From ${token}` });
  await dealRow.getByRole("button", { name: "Withdraw" }).click();
  await dealRow.getByLabel("Reason (shown to the student)").fill("Given away at closing");
  await dealRow.getByRole("button", { name: "Withdraw deal" }).click();
  await expect(dealRow).toContainText("Withdrawn");
  await expect(dealRow).toContainText("Given away at closing");
});

test("only outlet staff get in", async ({ page }) => {
  const student = await createStudent("Pos Outsider");
  await signInStaff(page, student.email, PASSWORD);
  // (Next.js also renders an empty role=alert route announcer, so match on text.)
  await expect(
    page.getByRole("alert").filter({ hasText: "isn't on any outlet's staff" }),
  ).toHaveText("This account isn't on any outlet's staff. Ask your outlet manager to add you.");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill("kitchen.north@campuscart.test");
  await page.getByLabel("Password").fill("not-the-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "incorrect" })).toHaveText(
    "Email or password is incorrect.",
  );
});

test("the board is accessible and fits the screen", async ({ page }) => {
  await signInStaff(page, KITCHEN);
  await expect(page.getByRole("heading", { name: /^New/ })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
