import type { Page } from "@playwright/test";

export async function openWorkspaceSettings(page: Page) {
  await page.locator(".workspace").waitFor();
  const button = page.getByRole("button", { name: "Workspace settings", exact: true });
  if (!await button.isVisible()) await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await button.click();
  return page.getByRole("dialog", { name: "Workspace settings", exact: true });
}

export async function openWorkspacePanel(page: Page, name: string) {
  const dialog = await openWorkspaceSettings(page);
  await dialog.getByRole("button", { name, exact: true }).click();
}

export async function conversationAction(page: Page, name: string) {
  const summary = page.getByLabel("Conversation options", { exact: true });
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
  await page.locator(".topbar .utility-menu").getByRole("button", { name, exact: true }).click();
}

export async function draftAction(page: Page, name: string) {
  const summary = page.getByLabel("Draft tools", { exact: true });
  if (await summary.locator("..").getAttribute("open") === null) await summary.click();
  await page.locator(".composer .utility-menu").getByRole("button", { name, exact: true }).click();
}
