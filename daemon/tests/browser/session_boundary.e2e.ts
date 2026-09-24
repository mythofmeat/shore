import { openWorkspacePanel } from "./navigation.ts";
import { expect, test } from "./fixtures.ts";

test("sign-out in another tab clears private dialogs before a new sign-in", async ({ page, context }) => {
  await page.goto("/workspace");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByLabel("Character name", { exact: true }).fill("nova");
  await create.getByRole("button", { name: "Run action" }).click();
  await expect(create.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await create.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await openWorkspacePanel(page, "Keyboard shortcuts");
  const keyboard = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await keyboard.getByLabel("Shortcut key", { exact: true }).fill("alt+u");
  await keyboard.getByLabel("Shortcut scope", { exact: true }).selectOption("global");
  await keyboard.getByLabel("Shortcut action", { exact: true }).selectOption("operation:character_info");
  await keyboard.getByLabel("When pressed", { exact: true }).selectOption("run");
  await keyboard.getByRole("button", { name: "Save shortcut", exact: true }).click();
  await expect(keyboard.getByRole("status")).toHaveText("Shortcut applied");
  await keyboard.getByRole("button", { name: "Close dialog" }).click();
  await page.keyboard.press("Alt+u");
  await expect(page.getByRole("dialog", { name: "Shortcut result", exact: true })).toContainText("nova");
  const other = await context.newPage();
  try {
    await other.goto(page.url());
    await expect(other.getByRole("heading", { name: "nova / main" })).toBeVisible();
    await openWorkspacePanel(other, "Disconnect");
    await expect(page.getByLabel("Daemon token", { exact: true })).toBeVisible();
    await page.getByLabel("Daemon token").fill("browser-test-token");
    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(page.locator(".connection.online")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Shortcut result", exact: true })).toHaveCount(0);
  } finally { await other.close(); }
});
