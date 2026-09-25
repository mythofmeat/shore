import { expect, test } from "./fixtures.ts";

test("a wrong token is rejected with a readable error and the right token connects", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); });
  await page.addInitScript("window.shorePolicyViolations = []; document.addEventListener('securitypolicyviolation', event => window.shorePolicyViolations.push(event.violatedDirective));");
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Connect to your daemon" })).toBeVisible();
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeDisabled();
  await page.getByLabel("Access token").fill("wrong-token");
  await connect.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Access token").fill("browser-test-token");
  await connect.click();
  await expect(page.getByRole("heading", { name: "Connect to your daemon" })).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  expect(await page.evaluate("window.shorePolicyViolations")).toEqual([]);
  expect(errors).toEqual([]);
});
