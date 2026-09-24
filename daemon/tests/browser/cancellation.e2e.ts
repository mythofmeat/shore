import { openWorkspacePanel } from "./navigation.ts";
import type { Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

async function openCharacter(page: Page) {
  await page.goto("/");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create character", exact: true });
  await create.getByLabel("Character name", { exact: true }).fill("nova");
  await create.getByRole("button", { name: "Run action" }).click();
  await expect(create.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await create.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
}

test("a browser can stop a running manual tool and inspect changes already made", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "shore-browser-cancel-"));
  const marker = join(root, "started");
  const later = join(root, "finished");
  try {
    await openCharacter(page);
    await openWorkspacePanel(page, "Tool workbench");
    const dialog = page.getByRole("dialog", { name: "Tool workbench", exact: true });
    await dialog.getByRole("navigation", { name: "Available tools" }).getByRole("button", { name: "bash", exact: true }).click();
    const selected = dialog.getByRole("region", { name: "Selected tool" });
    await selected.getByLabel("command", { exact: true }).fill(`printf '%s' "$$" > '${marker}'; sleep 60; printf finished > '${later}'`);
    await selected.getByRole("button", { name: "Review tool run", exact: true }).click();
    await dialog.getByRole("button", { name: "Run tool now", exact: true }).click();
    await expect.poll(async () => (await readFile(marker, "utf8").catch(() => ""))).toMatch(/^\d+$/);
    const pid = Number(await readFile(marker, "utf8"));
    await dialog.getByRole("button", { name: "Stop active work", exact: true }).click({ timeout: 8000 });
    const report = dialog.getByRole("region", { name: "Tool result" });
    await expect(report).toContainText("Tool failed", { timeout: 5000 });
    await expect(dialog).toContainText("Changes already made may remain");
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    expect(await readFile(later, "utf8").catch(() => null)).toBeNull();
    await selected.getByLabel("command", { exact: true }).fill(`cat '${marker}'`);
    await selected.getByRole("button", { name: "Review tool run", exact: true }).click();
    await dialog.getByRole("button", { name: "Run tool now", exact: true }).click();
    await expect(report).toContainText("Tool completed");
    await expect(report).toContainText(String(pid));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compaction cancellation preserves its checkpoint, partial writes and active history for resume", async ({ page }) => {
  await openCharacter(page);
  for (const text of ["cancel memory once", "Keep the recent turn"]) {
    await page.getByLabel("Message", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("article", { name: "assistant message" }).last()).toContainText(text);
  }
  await openWorkspacePanel(page, "Memory & segments");
  const dialog = page.getByRole("dialog", { name: "Memory & segments", exact: true });
  await dialog.getByLabel("Retain recent turns", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Compact context", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm archive", exact: true }).click();
  await expect(dialog).toContainText("Waiting for compaction cancellation");
  await dialog.getByRole("button", { name: "Stop active work", exact: true }).click();
  const report = dialog.getByRole("region", { name: "Compaction result" });
  await expect(report).toContainText("Compaction paused", { timeout: 5000 });
  await expect(dialog.getByText("No archived segments yet.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(2);
  await openWorkspacePanel(page, "Memory & segments");
  await dialog.getByLabel("Retain recent turns", { exact: true }).fill("1");
  await dialog.getByRole("button", { name: "Compact context", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm archive", exact: true }).click();
  await expect(report).toContainText("Context compacted");
  await expect(report).toContainText("fixture.md");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(1);
});

test("generated actions report unconfirmed MCP cancellation without repeating a late external effect", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "shore-browser-mcp-cancel-"));
  const marker = join(root, "effect");
  try {
    await openCharacter(page);
    await openWorkspacePanel(page, "Tool workbench");
    const workbench = page.getByRole("dialog", { name: "Tool workbench", exact: true });
    await workbench.getByRole("navigation", { name: "Available tools" }).getByRole("button", { name: "mcp__tool_fixture__cancel_late", exact: true }).click();
    await workbench.getByLabel("marker", { exact: true }).fill(marker);
    await workbench.getByRole("button", { name: "All tool options", exact: true }).click();
    const action = page.getByRole("dialog", { name: "Run tool", exact: true });
    await action.getByRole("button", { name: "Run action", exact: true }).click();
    await action.getByRole("button", { name: "Confirm execute", exact: true }).click();
    await expect.poll(async () => readFile(marker, "utf8").catch(() => "")).toBe("started\n");
    await action.getByRole("button", { name: "Stop active work", exact: true }).click();
    await expect(action.getByRole("heading", { name: "Action completed" })).toBeVisible({ timeout: 5000 });
    await action.getByText("Complete action result", { exact: true }).click();
    await expect(action).toContainText("was asked to stop");
    await expect(action).toContainText("not observable from here");
    await expect.poll(async () => readFile(marker, "utf8")).toBe("started\nfinished despite cancellation\n");
    await page.reload();
    await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
    expect(await readFile(marker, "utf8")).toBe("started\nfinished despite cancellation\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
