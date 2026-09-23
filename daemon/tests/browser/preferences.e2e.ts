import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const picture = { name: "display.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMUqdjCwMDAxMDAwMDAAAAOigFED/mW/QAAAABJRU5ErkJggg==", "base64") };

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
}
async function character(page: Page) {
  await signIn(page);
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create character", exact: true });
  await create.getByLabel("Character name", { exact: true }).fill("nova");
  await create.getByRole("button", { name: "Run action" }).click();
  await expect(create.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await create.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
}
async function preferences(page: Page) {
  await page.getByRole("button", { name: "Display preferences", exact: true }).click();
  return page.getByRole("dialog", { name: "Display preferences", exact: true });
}
async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

test("display preferences change the conversation, persist and merge across tabs", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await character(page);
  await page.getByLabel("Attach images", { exact: true }).setInputFiles(picture);
  await send(page, "Display the uploaded image");
  const user = page.getByRole("article", { name: "user message" });
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Display the uploaded image");
  await expect(page.getByRole("article", { name: "assistant message" }).getByLabel("Message metadata", { exact: true })).toContainText("in: 4 · out: 2");
  await expect(user.locator("time")).toBeVisible();
  await expect(user.getByLabel("Message metadata", { exact: true })).toBeVisible();
  await expect(user.getByRole("img")).toBeVisible();
  const dialog = await preferences(page);
  for (const label of ["Timestamps", "Reasoning", "Tool calls and results", "Subagent activity", "Compaction activity", "Inline images", "Message metadata"]) await expect(dialog.getByRole("checkbox", { name: label, exact: true })).toBeChecked();
  for (const label of ["Timestamps", "Inline images", "Message metadata"]) await dialog.getByRole("checkbox", { name: label, exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(user.locator("time")).toHaveCount(0);
  await expect(user.getByLabel("Message metadata", { exact: true })).toHaveCount(0);
  await expect(user.getByRole("img")).toHaveCount(0);
  await user.getByRole("button", { name: /View image:/ }).click();
  await expect(page.getByRole("dialog", { name: "Image", exact: true }).getByRole("img")).toBeVisible();
  await page.getByRole("dialog", { name: "Image", exact: true }).getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await expect(user.locator("time")).toHaveCount(0);
  await expect(user.getByRole("button", { name: /View image:/ })).toBeVisible();
  const other = await context.newPage();
  await other.goto(page.url());
  const otherPreferences = await preferences(other);
  await otherPreferences.getByRole("checkbox", { name: "Timestamps", exact: true }).check();
  await expect(user.locator("time")).toBeVisible();
  await preferences(page);
  await dialog.getByRole("checkbox", { name: "Message metadata", exact: true }).check();
  await expect(otherPreferences.getByRole("checkbox", { name: "Message metadata", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Inline images", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await other.close();
  await send(page, "hold this request");
  const live = page.getByRole("article", { name: "Streaming response", exact: true });
  await live.getByText("Reasoning", { exact: true }).click();
  await expect(live).toContainText("Considering the question");
  await preferences(page);
  await dialog.getByRole("checkbox", { name: "Reasoning", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(live.getByText("Reasoning", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Reasoning", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await preferences(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.screenshot({ path: "../out/issue-214/preferences-mobile.png" });
  await expect.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
  await dialog.getByRole("button", { name: "Reset display preferences", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Inline images", exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});

test("subagent tool blocks and compaction progress obey their separate visibility controls", async ({ page }) => {
  await character(page);
  await send(page, "run worker display fixture");
  await expect(page.getByRole("article", { name: "assistant message" }).last()).toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const worker = page.getByRole("region", { name: "Subagent worker", exact: true });
  await expect(worker.last()).toContainText("Inspected the fixture workspace");
  await expect(worker.getByText("Tool · bash", { exact: true })).toBeVisible();
  const dialog = await preferences(page);
  await dialog.getByRole("checkbox", { name: "Tool calls and results", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(worker.getByText("Tool · bash", { exact: true })).toHaveCount(0);
  await preferences(page);
  await dialog.getByRole("checkbox", { name: "Subagent activity", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(worker).toHaveCount(0);
  await send(page, "cancel memory once");
  await expect(page.getByRole("article", { name: "assistant message" }).last()).toContainText("cancel memory once");
  await page.getByRole("button", { name: "Memory & segments", exact: true }).click();
  const memory = page.getByRole("dialog", { name: "Memory & segments", exact: true });
  await memory.getByLabel("Retain recent turns", { exact: true }).fill("0");
  await memory.getByRole("button", { name: "Compact context", exact: true }).click();
  await memory.getByRole("button", { name: "Confirm archive", exact: true }).click();
  await expect(memory).toContainText("Waiting for compaction cancellation");
  await memory.getByRole("button", { name: "Close dialog" }).click();
  const compaction = page.getByRole("region", { name: "Compaction activity", exact: true });
  await expect(compaction.last()).toContainText("Waiting for compaction cancellation");
  await preferences(page);
  await dialog.getByRole("checkbox", { name: "Compaction activity", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(compaction).toHaveCount(0);
  await page.getByRole("button", { name: "Memory & segments", exact: true }).click();
  await expect(memory.getByText("Compaction progress", { exact: true })).toHaveCount(0);
  await memory.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await preferences(page);
  await dialog.getByRole("button", { name: "Reset display preferences", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(worker.first()).toBeVisible();
  await expect(worker.getByText("Tool · bash", { exact: true })).toBeVisible();
  await expect(compaction.first()).toBeVisible();
});

test("failed preference writes retain current choices and can be retried", async ({ page }) => {
  await signIn(page);
  const dialog = await preferences(page);
  await page.evaluate(`{
    const original = Storage.prototype.setItem;
    globalThis.restorePreferencesFixture = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("shore.view.v1.")) throw new DOMException("Fixture storage full", "QuotaExceededError"); return original.call(this, key, value); };
  }`);
  await dialog.getByRole("checkbox", { name: "Inline images", exact: true }).uncheck();
  await expect(dialog.getByRole("alert")).toContainText("not saved");
  await expect(dialog.getByRole("checkbox", { name: "Inline images", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Display preferences are not saved" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Reasoning", exact: true }).uncheck();
  await page.getByRole("button", { name: "Review display preferences", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Reasoning", exact: true })).not.toBeChecked();
  await page.evaluate("restorePreferencesFixture()");
  await dialog.getByRole("button", { name: "Retry saving preferences", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await preferences(page);
  await expect(dialog.getByRole("checkbox", { name: "Inline images", exact: true })).not.toBeChecked();
});

test.describe("budget display", () => {
  test.use({ usageSeed: true, calmBudget: true });
  test("usage modes and named cap and pace focus affect the live reading", async ({ page }) => {
    await signIn(page);
    const dialog = await preferences(page);
    await dialog.getByLabel("Usage display", { exact: true }).selectOption("always");
    await dialog.getByLabel("Budget focus", { exact: true }).selectOption("cap");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    const readout = page.getByLabel("Usage readout", { exact: true });
    await expect(readout).toContainText("Nova monthly · Cap");
    await expect(readout).toContainText("188%");
    await preferences(page);
    await dialog.getByLabel("Budget focus", { exact: true }).selectOption("pace");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(readout).toContainText("Nova monthly · Pace");
    await preferences(page);
    await dialog.getByLabel("Budget focus", { exact: true }).selectOption("Nova monthly");
    await dialog.getByLabel("Named budget scope", { exact: true }).selectOption("cap");
    await dialog.getByLabel("Usage display", { exact: true }).selectOption("warn");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(readout).toContainText("Nova monthly · Cap");
    await readout.getByRole("button", { name: "Inspect budget Nova monthly", exact: true }).click();
    const usage = page.getByRole("dialog", { name: "Usage & budgets", exact: true });
    await expect(usage).toContainText("Nova monthly");
    await usage.getByRole("button", { name: "Close dialog" }).click();
    await page.reload();
    await expect(readout).toContainText("188%");
    await preferences(page);
    await expect(dialog.getByLabel("Budget focus", { exact: true })).toHaveValue("Nova monthly");
    await expect(dialog.getByLabel("Named budget scope", { exact: true })).toHaveValue("cap");
    await dialog.getByLabel("Budget focus", { exact: true }).selectOption("Quiet");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(readout).toHaveCount(0);
    await preferences(page);
    await dialog.getByLabel("Usage display", { exact: true }).selectOption("always");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(readout).toContainText("Quiet · Cap");
    await expect(readout).toContainText("0%");
    await preferences(page);
    await dialog.getByLabel("Budget focus", { exact: true }).selectOption("pace");
    await dialog.getByRole("button", { name: "Cycle budget focus", exact: true }).click();
    await expect(dialog.getByLabel("Budget focus", { exact: true })).toHaveValue("Nova monthly");
    await dialog.getByRole("button", { name: "Cycle budget focus", exact: true }).click();
    await expect(dialog.getByLabel("Budget focus", { exact: true })).toHaveValue("Quiet");
    await dialog.getByLabel("Usage display", { exact: true }).selectOption("warn");
    await dialog.getByRole("button", { name: "Cycle usage display", exact: true }).click();
    await expect(dialog.getByLabel("Usage display", { exact: true })).toHaveValue("off");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(readout).toHaveCount(0);
  });
});
