import { expect, test } from "@playwright/test";
import {
  MANAGER_NORTH,
  apiAs,
  confirmPaymentStandIn,
  createStudent,
  kitchen,
  makeNoShow,
  orderIdFromUrl,
  signIn,
} from "./helpers";

const NORTH = "00000000-0000-4000-b000-000000000001";
const EGG_ROLL = "00000000-0000-4000-d000-000000000004"; // prepared, ₹55

/** A paid Dev North Café order placed through the API, taken to ready by the kitchen. */
async function readyOrder(email: string, quantity: number): Promise<{ id: string }> {
  const slots = await apiAs<{ id: string; bookable: boolean; starts_at: string }[]>(
    email,
    `/outlets/${NORTH}/pickup-slots`,
  );
  const slot = slots.find((s) => s.bookable && Date.parse(s.starts_at) > Date.now() + 10 * 60_000);
  const order = await apiAs<{ id: string }>(
    email,
    "/orders",
    {
      method: "POST",
      headers: { "Idempotency-Key": `e2e-${crypto.randomUUID()}` },
      body: {
        outlet_id: NORTH,
        pickup_slot_id: slot?.id,
        items: [{ menu_item_id: EGG_ROLL, quantity }],
      },
    },
    { status: 201 },
  );
  await confirmPaymentStandIn(order.id);
  for (const to_status of ["confirmed", "preparing", "ready_for_pickup"]) {
    await kitchen(`/staff/orders/${order.id}/transition`, { to_status });
  }
  return order;
}

test("an uncollected order explains the policy, and another student buys its food as a deal", async ({
  browser,
  page,
}, testInfo) => {
  // Different quantities per project, so parallel runs don't compete for the same deal.
  const quantity = testInfo.project.name === "desktop" ? 3 : 4;
  const owner = await createStudent("Deal Owner");
  const order = await readyOrder(owner.email, quantity);
  await signIn(page, owner.email);
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("pickup-deadline")).toContainText("Collect by");

  await makeNoShow(order.id);
  // Live, without a reload.
  await expect(page.getByText("This order wasn't collected in time")).toBeVisible();
  await expect(page.getByText(/there's no refund/)).toBeVisible();
  await expect(page.getByLabel("Pickup pass")).toHaveCount(0);
  await expect(page.getByText("Not collected", { exact: true }).first()).toBeVisible(); // badge

  const buyerContext = await browser.newContext();
  const buyerPage = await buyerContext.newPage();
  try {
    const buyer = await createStudent("Deal Buyer");
    await signIn(buyerPage, buyer.email);
    await buyerPage.goto("/outlets/cafe-1");
    await expect(
      buyerPage.getByRole("heading", { name: "Ready now, at a discount" }),
    ).toBeVisible();
    const deal = buyerPage
      .getByTestId("deal")
      .filter({ hasText: `${quantity} × Egg Roll` })
      .first();
    const price = quantity === 3 ? "₹82.50" : "₹110";
    await expect(deal).toContainText(price);
    await expect(deal).toContainText("50% off");
    await deal.getByRole("button", { name: /^Buy deal/ }).click();

    await expect(buyerPage).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    await expect(buyerPage.getByText("Surplus deal · pick up at the counter")).toBeVisible();
    await expect(buyerPage.getByText(/Awaiting payment — deal held for/)).toBeVisible();
    const dealOrderId = orderIdFromUrl(buyerPage);
    await confirmPaymentStandIn(dealOrderId);
    await expect(buyerPage.getByTestId("token")).toHaveText(/^N-\d+$/);
    await expect(buyerPage.getByTestId("pickup-deadline")).toContainText("Collect by");
  } finally {
    await buyerContext.close();
  }
});

test("a student asks for a refund after pickup and sees the manager's decision", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const student = await createStudent("Refund Student");
  const order = await readyOrder(student.email, 1);
  const { pickup_code } = await apiAs<{ pickup_code: string }>(
    student.email,
    `/orders/${order.id}`,
  );
  await kitchen(`/staff/orders/${order.id}/verify-pickup`, { code: pickup_code });

  await signIn(page, student.email);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole("button", { name: "Something wrong? Ask for a refund" }).click();
  const form = page.getByRole("form", { name: "Ask for a refund" });
  await expect(form.getByRole("button", { name: "Send request" })).toBeDisabled();
  await form.getByLabel("What went wrong?").fill("The roll was raw inside");
  await form.getByRole("button", { name: "Send request" }).click();
  const request = page.getByTestId("refund-request");
  await expect(request).toContainText("waiting for the outlet manager");

  const desk = await apiAs<{ pending: { id: string; order_id: string }[] }>(
    MANAGER_NORTH.email,
    `/manage/outlets/${NORTH}/refunds`,
    {},
    { password: MANAGER_NORTH.password },
  );
  const entry = desk.pending.find((p) => p.order_id === order.id);
  await apiAs(
    MANAGER_NORTH.email,
    `/manage/refund-requests/${entry?.id}/decision`,
    { method: "POST", body: { decision: "approve" } },
    { password: MANAGER_NORTH.password, status: 204 },
  );
  // Live, without a reload.
  await expect(request).toContainText("Refund approved");
});
