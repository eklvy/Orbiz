import { expect, test } from "@playwright/test";
import { createStudent, signIn } from "./helpers";

// Regression guard: no page may scroll sideways on a phone (the header once overflowed at 412 px).
test("no page scrolls horizontally", async ({ page }) => {
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  const student = await createStudent();
  await signIn(page, student.email);
  await page.goto("/outlets/dev-north-cafe");
  await page.getByRole("button", { name: "Add Masala Chai" }).click();
  for (const path of [
    "/",
    "/outlets/dev-north-cafe",
    "/cart",
    "/orders",
    "/profile",
    "/login",
    "/register",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const offenders = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`),
    );
    expect(
      await overflow(),
      `${path} overflows horizontally: ${offenders.join(" | ")}`,
    ).toBeLessThanOrEqual(0);
  }
});
