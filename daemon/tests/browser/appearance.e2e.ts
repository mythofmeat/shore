import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openWorkspacePanel, openWorkspaceSettings } from "./navigation.ts";

async function connect(page: Page) {
  await page.goto("/workspace");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

async function appearance(page: Page) {
  await page.getByRole("button", { name: "Display preferences", exact: true }).click();
  return page.getByRole("dialog", { name: "Display preferences", exact: true });
}

test("appearance changes the rendered theme and typography, persists and synchronizes across tabs", async ({ page, context }) => {
  await connect(page);
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveCSS("color-scheme", "dark");
  await expect(page.locator(".sidebar").getByRole("button", { name: "Character archives" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  const dialog = await appearance(page);
  await dialog.getByRole("button", { name: "Light", exact: true }).click();
  await dialog.getByRole("button", { name: "Blue", exact: true }).click();
  await dialog.getByLabel("Conversation font").selectOption("sans");
  await dialog.getByLabel("Text size").selectOption("large");
  await dialog.getByLabel("Reading width").selectOption("wide");
  await expect(root).toHaveCSS("color-scheme", "light");
  await expect(root).toHaveAttribute("data-accent", "blue");
  await expect(dialog.locator(".appearance-preview .message-text")).toHaveCSS("font-size", "20.8px");
  await expect(dialog.locator(".appearance-preview .message-text")).toHaveCSS("font-family", "ui-sans-serif, system-ui, sans-serif");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveAttribute("data-width", "wide");
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.locator("html")).toHaveAttribute("data-accent", "blue");
  const otherDialog = await appearance(other);
  await otherDialog.getByRole("button", { name: "Amber", exact: true }).click();
  await expect(root).toHaveAttribute("data-accent", "amber");
  await otherDialog.getByRole("button", { name: "System", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  await otherDialog.getByRole("button", { name: "Reset appearance" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-font", "serif");
  await expect(root).toHaveAttribute("data-size", "medium");
  await expect(root).toHaveAttribute("data-width", "focused");
  await other.close();
});

test("appearance survives unavailable storage, reports unsaved changes and retries", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("shore.appearance.v1", JSON.stringify({ theme: "invalid", accent: "invalid", size: 50 })));
  await connect(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dialog = await appearance(page);
  await page.evaluate(`{
    const original = Storage.prototype.setItem;
    globalThis.restoreAppearanceStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) { if (key === "shore.appearance.v1") throw new DOMException("Full", "QuotaExceededError"); return original.call(this, key, value); };
  }`);
  await dialog.getByRole("button", { name: "Rose", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Appearance preferences are not saved");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "rose");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("alert")).toContainText("Appearance preferences are not saved");
  await page.getByRole("button", { name: "Review appearance" }).click();
  await page.evaluate("restoreAppearanceStorage()");
  await dialog.getByRole("button", { name: "Retry saving appearance" }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate<string>('JSON.parse(localStorage.getItem("shore.appearance.v1") ?? "{}").accent')).toBe("rose");
});

test("phone navigation, settings and conversation menus remain usable without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  await expect(page.getByRole("button", { name: "Workspace settings", exact: true })).toHaveCount(0);
  const settings = await openWorkspaceSettings(page);
  await expect(settings.getByRole("button", { name: "Character archives", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Display preferences", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Display preferences", exact: true });
  await dialog.getByRole("button", { name: "Rose", exact: true }).click();
  await dialog.screenshot({ path: "../out/ui-redesign/appearance-mobile.png" });
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const options = page.getByLabel("Conversation options", { exact: true });
  await options.click();
  await expect(page.getByRole("button", { name: "Request history", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toBeFocused();
  await expect(page.getByRole("button", { name: "Request history", exact: true })).toHaveCount(0);
  await options.click();
  await page.getByLabel("Message", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Request history", exact: true })).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await page.getByLabel("Draft tools", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved drafts", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    await page.keyboard.press("Escape");
  }
  await openWorkspacePanel(page, "Disconnect");
  await expect(page.getByLabel("Daemon token")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "rose");
});
