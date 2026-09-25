import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

export async function watchPage(page: Page): Promise<() => Promise<void>> {
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); });
  await page.addInitScript("window.shorePolicyViolations = []; document.addEventListener('securitypolicyviolation', event => window.shorePolicyViolations.push(event.violatedDirective));");
  return async () => {
    expect(await page.evaluate("window.shorePolicyViolations")).toEqual([]);
    expect(errors).toEqual([]);
  };
}

export async function signIn(page: Page, path = "/workspace"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Access token").fill("browser-test-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}

export async function createCharacter(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New character", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".topbar-name")).toHaveText(name);
}

export async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await box.press("Enter");
  await expect(page.locator("article.message.assistant").last()).toContainText(text.split("\n")[0]?.replace(/[*_`]/g, "") ?? text);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
}
