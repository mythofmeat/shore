import { expect, test } from "./fixtures.ts";
import { createCharacter, send, signIn, watchPage } from "./helpers.ts";

test("selecting part of a message offers Quote, which adds it to the message box as a > quote", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "nova");
  await send(page, "First paragraph here\n\nSecond paragraph here");
  const quote = page.getByRole("button", { name: "Quote", exact: true });
  await expect(quote).toHaveCount(0);
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("my reply");
  await page.locator("article.message.assistant .prose p").last().click({ clickCount: 3 });
  await expect(quote).toBeVisible();
  await quote.click();
  await expect(quote).toHaveCount(0);
  await expect(box).toHaveValue("my reply\n\n> Second paragraph here\n\n");
  await expect(box).toBeFocused();
  expect(await page.evaluate("document.activeElement.selectionStart === document.activeElement.value.length")).toBe(true);
  await box.fill("");
  await page.evaluate("(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('article.message.assistant .prose')); getSelection().removeAllRanges(); getSelection().addRange(range); })()");
  await quote.click();
  await expect(box).toHaveValue(/^> Answer 1: First paragraph here\n>\n> Second paragraph here\n\n$/);
  await page.locator(".message-meta").first().click({ clickCount: 3 });
  await expect(quote).toHaveCount(0);
  await check();
});

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
