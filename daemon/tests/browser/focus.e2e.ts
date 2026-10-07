import { expect, test } from "./fixtures.ts";
import { createCharacter, signIn, watchPage } from "./helpers.ts";

test("dialogs put the cursor in their first field so typing starts at once, and Escape closes a search dialog even with text typed", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "nova");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette.getByLabel("Search commands")).toBeFocused();
  await page.keyboard.type("appear");
  await expect(palette.getByRole("option").first()).toContainText("Appearance");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await page.getByRole("button", { name: "Conversation options" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await expect(page.getByRole("dialog", { name: "Rename conversation" }).getByLabel("Label")).toBeFocused();
  await check();
});
