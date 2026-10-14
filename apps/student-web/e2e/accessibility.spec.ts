import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createStudent, signIn } from "./helpers";

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("public pages have no serious accessibility violations", async ({ page }) => {
  for (const path of ["/", "/outlets/dev-north-cafe", "/login", "/register"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await seriousViolations(page), path).toEqual([]);
  }
});

test("signed-in pages have no serious accessibility violations", async ({ page }) => {
  const student = await createStudent();
  await signIn(page, student.email);
  await page.goto("/outlets/dev-north-cafe");
  await page.getByRole("button", { name: "Add Masala Chai" }).click();
  for (const path of ["/cart", "/orders", "/profile"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await seriousViolations(page), path).toEqual([]);
  }
});
