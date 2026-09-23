import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.use({ galleryMedia: true });

async function openCharacter(page: Page) {
  await page.goto("/workspace");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Character name", { exact: true }).fill("nova");
  await dialog.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
}

test("an oversized live response keeps a bounded recent preview and remains cancellable", async ({ page }) => {
  let cancelled = false;
  page.on("websocket", (socket) => socket.on("framereceived", (event) => {
    const frame: unknown = JSON.parse(event.payload.toString());
    if (typeof frame === "object" && frame !== null && "type" in frame && frame.type === "request_finished" && "outcome" in frame && frame.outcome === "cancelled") cancelled = true;
  }));
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("long live preview fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const live = page.getByRole("article", { name: "Streaming response" });
  await expect(live).toContainText("LIVE_PREVIEW_TAIL");
  await expect(live.getByText("Live preview shortened to limit memory.", { exact: false })).toBeVisible();
  expect((await live.locator(".message-text").first().textContent())?.length).toBeLessThanOrEqual(512 * 1024);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => cancelled).toBe(true);
});

test("tool images omitted from model input are still viewable and disappear with their conversation result", async ({ page }, testInfo) => {
  const frames: unknown[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", (event) => {
    const frame: unknown = JSON.parse(event.payload.toString());
    if (typeof frame === "object" && frame !== null && "type" in frame && ["tool_result", "send_image", "history", "new_message", "stream_end"].includes(String(frame.type))) frames.push(frame);
  }));
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("show omitted image fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const assistant = page.getByRole("article", { name: "assistant message" });
  await expect(assistant).toContainText("Three original images returned");
  await testInfo.attach("media-frames", { body: JSON.stringify(frames, null, 2), contentType: "application/json" });
  expect(frames.filter((frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "send_image"), JSON.stringify(frames)).toHaveLength(3);
  await page.getByRole("button", { name: "Images", exact: true }).click();
  const gallery = page.getByRole("dialog", { name: "Image", exact: true });
  await expect(gallery.getByRole("status")).toContainText("1 of 3");
  await gallery.getByRole("button", { name: "Next image", exact: true }).click();
  await gallery.getByRole("button", { name: "Next image", exact: true }).click();
  await expect(gallery.getByRole("img")).toBeVisible();
  await gallery.getByRole("button", { name: "Close dialog", exact: true }).click();
  await assistant.getByRole("button", { name: "Delete", exact: true }).click();
  const action = page.getByRole("dialog");
  await action.getByRole("button", { name: "Run action", exact: true }).click();
  await action.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(action.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await action.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Images", exact: true }).click();
  await expect(gallery.getByRole("status")).toContainText("No images loaded");
});

test("conversation content containing executable HTML remains literal text in the actual browser", async ({ page }) => {
  await openCharacter(page);
  const payload = '<img src=x onerror="globalThis.shoreInjected=true"><script>globalThis.shoreInjected=true</script>';
  await page.getByLabel("Message", { exact: true }).fill(payload);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const assistant = page.getByRole("article", { name: "assistant message" });
  await expect(assistant).toContainText(payload);
  await expect(assistant.locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(globalThis, "shoreInjected"))).toBe(false);
});
