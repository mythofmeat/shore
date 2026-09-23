import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function openCharacter(page: Page): Promise<void> {
  await page.goto("/workspace");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Character name", { exact: true }).fill("nova");
  await dialog.getByRole("button", { name: "Run action" }).click();
  await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
}

test("text undo restores a confirmed send without sending another message", async ({ page }) => {
  await openCharacter(page);
  const input = page.getByLabel("Message", { exact: true });
  await input.pressSequentially("A draft worth recovering");
  await page.getByLabel("Attach images", { exact: true }).setInputFiles({ name: "undo.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMUqdjCwMDAxMDAwMDAAAAOigFED/mW/QAAAABJRU5ErkJggg==", "base64") });
  await expect(page.getByRole("button", { name: "Remove undo.png", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.focus();
  await page.keyboard.press("Control+z");
  await expect(input).toHaveValue("A draft worth recovering");
  await expect(page.getByRole("article", { name: "user message", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove undo.png", exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(input).toHaveValue("");
});

test("expanded editing keeps reply context separate and saves draft changes across reload", async ({ page }) => {
  await openCharacter(page);
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("Explain this first");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.fill("My next question");
  await page.getByRole("button", { name: "Expand editor", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Draft editor", exact: true });
  await expect(editor.getByRole("region", { name: "Last assistant reply", exact: true })).toContainText("Explain this first");
  const expanded = editor.getByLabel("Expanded draft", { exact: true });
  await expect(expanded).toHaveValue("My next question");
  await expanded.fill("My next question\nwith another line 🌊");
  await editor.getByRole("button", { name: "Return to composer", exact: true }).click();
  await expect(input).toHaveValue("My next question\nwith another line 🌊");
  await page.getByRole("button", { name: "Undo text change", exact: true }).click();
  await expect(input).toHaveValue("My next question");
  await page.getByRole("button", { name: "Redo text change", exact: true }).click();
  await expect(input).toHaveValue("My next question\nwith another line 🌊");
  await page.getByRole("button", { name: "Expand editor", exact: true }).click();
  await expanded.fill("Keep this expanded draft on reload");
  await expect(editor.getByRole("status")).toContainText("Draft saved on this device");
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.screenshot({ path: "../out/issue-214/editor-mobile.png" });
  await expect.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
  await page.reload();
  await expect(input).toHaveValue("Keep this expanded draft on reload");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("article", { name: "user message", exact: true }).last()).toContainText("Keep this expanded draft on reload");
  await expect(page.getByRole("article", { name: "user message", exact: true }).last()).not.toContainText("Answer 1");
});

test("keyboard editing preserves Unicode selection, supports browser undo events and isolates other fields", async ({ page }) => {
  await openCharacter(page);
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("🌊 café\nsecond line");
  await input.press("Home");
  await input.press("Control+Shift+ArrowRight");
  const originalSelection = await page.evaluate<number[]>('(() => { const element = document.getElementById("message-composer"); return [element.selectionStart, element.selectionEnd]; })()');
  await input.pressSequentially("replaced");
  await input.press("Control+z");
  await expect(input).toHaveValue("🌊 café\nsecond line");
  expect(await page.evaluate<number[]>('(() => { const element = document.getElementById("message-composer"); return [element.selectionStart, element.selectionEnd]; })()')).toEqual(originalSelection);
  expect(await page.evaluate<boolean>('document.getElementById("message-composer").dispatchEvent(new InputEvent("beforeinput", { inputType: "historyRedo", bubbles: true, cancelable: true }))')).toBe(false);
  await expect(input).toHaveValue("🌊 café\nreplaced line");
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await shortcuts.getByLabel("Shortcut key", { exact: true }).fill("alt+e");
  await shortcuts.getByLabel("Shortcut scope", { exact: true }).selectOption("global");
  await shortcuts.getByLabel("Shortcut action", { exact: true }).selectOption("local:editor");
  await shortcuts.getByRole("button", { name: "Save shortcut", exact: true }).click();
  await expect(shortcuts.getByRole("status")).toContainText("Shortcut applied");
  await shortcuts.getByRole("button", { name: "Close dialog" }).click();
  await input.focus(); await page.keyboard.press("Alt+e");
  const editor = page.getByRole("dialog", { name: "Draft editor", exact: true });
  await expect(editor.getByLabel("Expanded draft", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Message options", exact: true }).click();
  await page.keyboard.press("Control+z");
  await page.getByRole("dialog", { name: "Message options", exact: true }).getByRole("button", { name: "Close dialog" }).click();
  await expect(input).toHaveValue("🌊 café\nreplaced line");
});
