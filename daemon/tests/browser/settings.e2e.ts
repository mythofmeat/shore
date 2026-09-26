import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures.ts";
import { createCharacter, send, signIn, watchPage } from "./helpers.ts";

test.use({ usageSeed: true });

const PAGES = ["Models", "Characters", "Appearance", "Keyboard shortcuts", "Providers", "Usage & budgets", "Configuration", "Memory & segments", "Diagnostics", "Traces & call log", "Tool runner", "Character archives", "Debug"];

test("every settings page renders readable content without raw objects or page errors", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "nova");
  await send(page, "Hello there");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Settings" });
  for (const name of PAGES) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".settings-page h1")).toHaveText(name);
    await expect(page.locator(".settings-page .spinner")).toHaveCount(0);
    await expect(page.locator(".settings-page")).not.toContainText("[object Object]");
    await expect(page.locator(".settings-page [role=alert]")).toHaveCount(0);
  }
  await nav.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.locator("article.message.user")).toContainText("Hello there");
  await check();
});

test("models page pins a background model, inspects a model and resets", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "ada");
  await page.goto(`${new URL(page.url()).pathname}#settings/models`);
  const heartbeat = page.locator(".setting-row", { hasText: "Heartbeat" });
  await heartbeat.getByRole("button").click();
  const picker = page.getByRole("dialog", { name: /Model for heartbeat/ });
  await picker.getByRole("option", { name: /anthropic:fast-fixture/ }).click();
  await expect(heartbeat.getByRole("button")).toContainText("anthropic:fast-fixture");
  await heartbeat.getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Use the configured default" }).click();
  await expect(heartbeat.getByRole("button")).not.toContainText("fast-fixture");
  await page.getByLabel("Show details for").selectOption("model:anthropic:fast-fixture");
  await expect(page.locator(".kv")).toContainText("fast-fixture");
  await check();
});

test("usage reports summarize, break down, show budgets and export CSV", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "nova");
  await page.goto(`${new URL(page.url()).pathname}#settings/usage`);
  await expect(page.locator(".data-table")).toContainText("usage-model-a");
  await page.getByRole("radio", { name: "Breakdown" }).click();
  await page.getByLabel("Group by").selectOption("provider");
  await expect(page.locator(".data-table th").first()).toHaveText("Provider");
  await page.getByRole("radio", { name: "Budgets" }).click();
  await expect(page.getByRole("progressbar").first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("shore-usage.csv");
  expect(await readFile(await file.path(), "utf8")).toContain("usage-model-a");
  await page.getByLabel("Usage display").selectOption("always");
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.locator(".budget-chip")).toBeVisible();
  await check();
});

test("configuration checks, searches and edits a setting; the palette jumps to it", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "iris");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("radio", { name: "Settings keys" }).click();
  await palette.getByLabel("Search commands").fill("tools.bash.max_result_chars");
  await expect(palette.getByRole("option", { name: /tools\.bash\.max_result_chars/ })).toBeVisible();
  await palette.getByLabel("Search commands").press("Enter");
  await expect(page.locator(".settings-page h1")).toHaveText("Configuration");
  await expect(page.getByLabel("Search settings")).toHaveValue("tools.bash.max_result_chars");
  const row = page.locator(".config-row", { hasText: "tools.bash.max_result_chars" });
  await expect(row).toContainText("1024");
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("tools.bash.max_result_chars").fill("2048");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("2048");
  await page.getByRole("button", { name: "Check configuration" }).click();
  const result = page.locator(".notice-box");
  await expect(result).toContainText("Config folder");
  await expect(result).toContainText("ANTHROPIC_API_KEY not set");
  await check();
});

test("tool runner runs bash from a form and from key=value lines", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "wren");
  await page.goto(`${new URL(page.url()).pathname}#settings/tools`);
  await page.getByLabel("Tool", { exact: true }).selectOption("bash");
  await page.getByLabel("Command", { exact: true }).fill("printf 'from the form'");
  await page.getByRole("button", { name: "Run tool" }).click();
  await expect(page.locator(".readout")).toContainText("from the form");
  await page.getByRole("radio", { name: "key=value lines" }).click();
  await page.getByLabel("Arguments as key=value lines").fill("command=printf 'from pairs'");
  await page.getByRole("button", { name: "Run tool" }).click();
  await expect(page.locator(".readout").first()).toContainText("from pairs");
  await check();
});

test("characters can be exported to a download and deleted after typing the name", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "temp");
  await page.goto(`${new URL(page.url()).pathname}#settings/archives`);
  await page.getByLabel("Character to export", { exact: true }).selectOption("temp");
  await page.getByRole("button", { name: "Export and download" }).click();
  const archive = page.locator(".archive", { hasText: "temp" });
  await expect(archive.getByRole("button", { name: "Download" })).toBeVisible({ timeout: 20_000 });
  const download = page.waitForEvent("download");
  await archive.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toContain("temp");
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete temp?" });
  await expect(dialog.getByRole("button", { name: "Delete character" })).toBeDisabled();
  await dialog.getByLabel(/Type/).fill("temp");
  await dialog.getByRole("button", { name: "Delete character" }).click();
  await expect(page.getByRole("navigation", { name: "Characters" }).getByText("temp")).toHaveCount(0);
  await check();
});

test("keyboard: arrow keys in an empty composer edit the last message and swipe responses", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "kai");
  await send(page, "First question");
  const box = page.getByLabel("Message", { exact: true });
  await box.focus();
  await box.press("ArrowRight");
  await expect(page.locator("article.message.assistant").last().getByRole("button", { name: /Response 2 of 2/ })).toBeVisible();
  await box.press("ArrowLeft");
  await expect(page.locator("article.message.assistant").last().getByRole("button", { name: /Response 1 of 2/ })).toBeVisible();
  await box.press("ArrowUp");
  await expect(page.getByLabel("Edit message")).toBeVisible();
  await page.getByLabel("Edit message").press("Escape");
  await page.keyboard.press("?");
  await expect(page.locator(".settings-page h1")).toHaveText("Keyboard shortcuts");
  await check();
});
