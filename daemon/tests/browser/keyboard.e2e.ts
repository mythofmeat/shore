import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function open(page: Page) {
  await page.goto("/workspace");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
}
async function editor(page: Page, key: string, target: string, scope = "global", mode = "run") {
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await dialog.getByLabel("Shortcut key", { exact: true }).fill(key);
  await dialog.getByLabel("Shortcut scope", { exact: true }).selectOption(scope);
  await dialog.getByLabel("Shortcut action", { exact: true }).selectOption(target);
  if (target.startsWith("operation:") || target.startsWith("request:")) await dialog.getByLabel("When pressed", { exact: true }).selectOption(mode);
  return dialog;
}
async function save(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await dialog.getByRole("button", { name: "Save shortcut", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Shortcut applied");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
}
async function create(page: Page) {
  const dialog = await editor(page, "alt+n", "operation:create_character");
  await dialog.getByLabel("Character name", { exact: true }).fill("nova");
  await save(page);
  await page.keyboard.press("Alt+n");
  const result = page.getByRole("dialog", { name: "Shortcut result", exact: true });
  await expect(result.getByRole("heading", { level: 3 })).toContainText("Create character");
  await result.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
}

test("bindings persist, follow typing scope, synchronize across tabs and can be removed", async ({ page, context }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await open(page); await create(page);
  const dialog = await editor(page, "j", "view:thinking", "normal");
  await save(page);
  await page.getByLabel("Message", { exact: true }).fill("draft");
  await page.keyboard.press("j");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("draftj");
  await expect(page.getByRole("checkbox", { name: "Reasoning", exact: true })).toBeChecked();
  await page.getByRole("heading", { name: "nova / main" }).click();
  await page.keyboard.down("j"); await page.keyboard.down("j"); await page.keyboard.up("j");
  await expect(page.getByRole("checkbox", { name: "Reasoning", exact: true })).not.toBeChecked();
  await page.evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", isComposing: true, bubbles: true }))');
  await expect(page.getByRole("checkbox", { name: "Reasoning", exact: true })).not.toBeChecked();
  await page.reload();
  const other = await context.newPage(); await other.goto(page.url());
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove normal:j", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await other.getByRole("heading", { name: "nova / main" }).click();
  await other.keyboard.press("j");
  await expect(other.getByRole("checkbox", { name: "Reasoning", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove global:ctrl+k", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.reload(); await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "All actions", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await dialog.getByRole("button", { name: "Reset keyboard shortcuts", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm reset shortcuts", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.evaluate("element => { element.scrollTop = 0; }");
  await dialog.screenshot({ path: "../out/issue-214/keyboard-mobile.png" });
  await expect(dialog.locator("kbd").filter({ hasText: "ctrl+k" })).toBeVisible();
  await expect.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "All actions", exact: true })).toBeVisible();
  expect(errors).toEqual([]); await other.close();
});

test("saved command arguments use shared handlers and keep destructive confirmation and cancellation", async ({ page }) => {
  await open(page); await create(page);
  let dialog = await editor(page, "alt+s", "request:message");
  await dialog.getByLabel("Message", { exact: true }).fill("Keyboard message template");
  await save(page);
  await page.getByLabel("Message", { exact: true }).fill("Keep this unsent draft");
  await page.keyboard.press("Alt+s");
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Keyboard message template");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this unsent draft");
  dialog = await editor(page, "alt+c", "request:cancel"); await save(page);
  await page.getByLabel("Message", { exact: true }).fill("hold this request");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("article", { name: "Streaming response" })).toBeVisible();
  await page.getByRole("button", { name: "Display preferences", exact: true }).click();
  await page.keyboard.press("Alt+c");
  await page.getByRole("dialog", { name: "Display preferences", exact: true }).getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  dialog = await editor(page, "alt+d", "operation:delete_character");
  await dialog.getByLabel("Character", { exact: true }).fill("nova");
  await dialog.getByLabel("Repeat character name", { exact: true }).fill("nova"); await save(page);
  await page.keyboard.press("Alt+d");
  const confirmation = page.getByRole("dialog", { name: "Delete character", exact: true });
  await expect(confirmation.locator(".confirmation")).toContainText('"character": "nova"');
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" })).toBeVisible();
  await page.keyboard.press("Alt+d");
  await confirmation.getByRole("button", { name: /^Confirm / }).click();
  await expect(confirmation.getByRole("heading", { name: "Action completed", exact: true })).toBeVisible();
  await confirmation.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" })).toHaveCount(0);
});

test("key recording, reserved keys and storage failure remain recoverable", async ({ page }) => {
  await open(page);
  const dialog = await editor(page, "ctrl+c", "local:usage");
  await dialog.getByRole("button", { name: "Save shortcut", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("reserved");
  await dialog.getByLabel("Record a shortcut", { exact: true }).focus();
  await page.keyboard.press("Alt+u");
  await expect(dialog.getByLabel("Shortcut key", { exact: true })).toHaveValue("alt+u");
  await page.evaluate(`{
    const original = Storage.prototype.setItem;
    globalThis.restoreKeyboardStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("shore.keyboard.v1.")) throw new DOMException("Fixture storage full", "QuotaExceededError"); return original.call(this, key, value); };
  }`);
  await dialog.getByRole("button", { name: "Save shortcut", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("not saved");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("alert")).toContainText("not saved");
  await page.keyboard.press("Alt+u");
  const usage = page.getByRole("dialog", { name: "Usage & budgets", exact: true });
  await expect(usage).toBeVisible();
  await usage.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate("restoreKeyboardStorage()");
  await page.getByRole("button", { name: "Review keyboard shortcuts", exact: true }).click();
  await dialog.getByRole("button", { name: "Retry saving shortcuts", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.reload(); await page.keyboard.press("Alt+u");
  await expect(usage).toBeVisible();
});

test("preset forms open without running, and configuration secrets stay out of saved bindings", async ({ page }) => {
  await open(page);
  let dialog = await editor(page, "alt+n", "operation:create_character", "global", "open");
  await dialog.getByLabel("Character name", { exact: true }).fill("preset-character");
  await save(page); await page.keyboard.press("Alt+n");
  const form = page.getByRole("dialog", { name: "Create character", exact: true });
  await expect(form.getByLabel("Character name", { exact: true })).toHaveValue("preset-character");
  await expect(page.getByRole("navigation", { name: "Characters" })).not.toContainText("preset-character");
  await form.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(form.getByRole("heading", { name: "Action completed", exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Close dialog" }).click();
  dialog = await editor(page, "alt+b", "operation:config", "global", "open");
  await dialog.getByRole("checkbox", { name: "Set Configuration key", exact: true }).check();
  await dialog.getByLabel("Configuration key", { exact: true }).fill("notifications.topic");
  await dialog.getByRole("checkbox", { name: "Set New value", exact: true }).check();
  await expect(dialog.getByLabel("New value", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByLabel("New value", { exact: true }).fill("keyboard-fixture-secret");
  await dialog.getByRole("button", { name: "Save shortcut", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("cannot be saved in shortcuts");
  expect(await page.evaluate<string>("JSON.stringify(localStorage)")).not.toContain("keyboard-fixture-secret");
  await dialog.getByRole("checkbox", { name: "Set New value", exact: true }).uncheck();
  await save(page); await page.keyboard.press("Alt+b");
  const config = page.getByRole("dialog", { name: "Read or edit configuration", exact: true });
  await expect(config.getByLabel("Configuration key", { exact: true })).toHaveValue("notifications.topic");
  await config.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate(`localStorage.setItem("shore.keyboard.v1.global:alt+b", JSON.stringify({key:"alt+b",scope:"global",target:"operation:config",mode:"run",args:{key:"notifications.topic",value:"injected-fixture-secret"}}))`);
  await page.reload();
  await page.getByRole("button", { name: "All actions", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "All actions", exact: true });
  await expect(palette.getByRole("button", { name: "Read or edit configuration", exact: false })).toBeEnabled();
  await palette.getByRole("button", { name: "Close dialog" }).click();
  await page.keyboard.press("Alt+b");
  await expect(page.getByRole("alert")).toContainText("cannot be saved in shortcuts");
  await expect(config).toHaveCount(0);
});
