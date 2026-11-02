import { expect, test } from "./fixtures.ts";
import { signIn, watchPage } from "./helpers.ts";

test("a key typed into the Providers page is checked first, never shown again, and can be tested and removed", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await page.evaluate("location.hash = '#settings/providers'");
  const card = page.locator(".provider", { has: page.locator(".setting-label", { hasText: /^fixture$/ }) });
  await card.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a key to fixture" });
  await dialog.getByLabel("Name").fill("spare");
  await dialog.getByLabel("API key").fill("a-key-the-fixture-turns-away");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("rejected: HTTP 401");

  await dialog.getByLabel("API key").fill("private-discovery-fixture-key");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = card.locator("li.credential", { hasText: "spare" });
  await expect(row).toContainText("Works");
  await expect(row).toContainText("Saved on the daemon …-key");
  await expect(card.locator("li.credential").first()).toContainText("default");
  await expect(page.locator("body")).not.toContainText("private-discovery-fixture-key");
  await expect(card.locator("li.credential", { hasText: "default" })).toContainText("Not checked yet");
  await expect(card.locator("li.credential", { hasText: "default" })).toContainText("In use");

  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText("spare: 2 models")).toBeVisible();

  await row.getByRole("button", { name: "Actions for spare" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByRole("dialog", { name: "Remove spare?" }).getByRole("button", { name: "Remove key", exact: true }).click();
  await expect(card.locator("li.credential", { hasText: "spare" })).toHaveCount(0);
  await check();
});
