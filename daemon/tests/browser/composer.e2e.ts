import { expect, test } from "./fixtures.ts";
import { createCharacter, signIn, watchPage } from "./helpers.ts";

test("with Enter sends turned off, Enter adds a line and Mod+Enter sends", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "nova");
  await page.goto(`${new URL(page.url()).pathname}#settings/keyboard`);
  await page.getByRole("switch", { name: "Enter sends" }).click();
  await expect(page.locator(".settings-page")).toContainText("Send (Enter for a new line)");
  await page.reload();
  await expect(page.getByRole("switch", { name: "Enter sends" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Back to chat" }).click();
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("first line");
  await box.press("Enter");
  await box.pressSequentially("second line");
  await expect(box).toHaveValue("first line\nsecond line");
  await expect(page.locator("article.message.user")).toHaveCount(0);
  await box.press("ControlOrMeta+Enter");
  await expect(page.locator("article.message.user")).toContainText("second line");
  await expect(box).toHaveValue("");
  await check();
});
