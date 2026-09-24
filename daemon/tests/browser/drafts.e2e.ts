import { draftAction } from "./navigation.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const picture = { name: "draft.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMUqdjCwMDAxMDAwMDAAAAOigFED/mW/QAAAABJRU5ErkJggg==", "base64") };

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

async function saved(page: Page): Promise<void> {
  await expect(page.getByRole("status").filter({ hasText: "Draft saved on this device" })).toBeVisible();
}

test("a delayed image read merges into the current draft after a conversation round trip", async ({ page }) => {
  await openCharacter(page);
  await page.locator(".section-heading").filter({ has: page.getByRole("heading", { name: "Characters", exact: true }) }).getByRole("button", { name: "New character", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Character name", { exact: true }).fill("other");
  await dialog.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByLabel("Message", { exact: true }).fill("Original draft before reading");
  await page.getByLabel("Attach images", { exact: true }).setInputFiles({ ...picture, name: "removed.png" });
  await saved(page);
  await page.evaluate(`{
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function(file) {
      FileReader.prototype.readAsDataURL = read;
      const loaded = this.onload;
      this.onload = event => { window.shoreReleaseImage = () => loaded.call(this, event); };
      read.call(this, file);
    };
  }`);
  await page.getByLabel("Attach images", { exact: true }).setInputFiles(picture);
  await expect.poll(() => page.evaluate("typeof window.shoreReleaseImage")).toBe("function");
  const characters = page.getByRole("navigation", { name: "Characters" });
  await characters.getByRole("button", { name: "O other" }).click();
  await expect(page.getByRole("heading", { name: "other / main" })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Other conversation draft");
  await saved(page);
  await characters.getByRole("button", { name: "N nova" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Original draft before reading");
  await page.getByLabel("Message", { exact: true }).fill("Newer draft must survive reading");
  await page.getByRole("button", { name: "Remove removed.png", exact: true }).click();
  await page.getByLabel("Attach images", { exact: true }).setInputFiles({ ...picture, name: "newer.png" });
  await saved(page);
  await page.evaluate("window.shoreReleaseImage()");
  await expect(page.getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Newer draft must survive reading");
  await expect(page.getByRole("button", { name: "Remove newer.png", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove removed.png", exact: true })).toHaveCount(0);
  await saved(page);
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Newer draft must survive reading");
  await expect(page.getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove newer.png", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove removed.png", exact: true })).toHaveCount(0);
  await characters.getByRole("button", { name: "O other" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Other conversation draft");
  await expect(page.locator(".attachments")).toHaveCount(0);
});

for (const edited of [false, true]) test(`send completion reconciles a remounted ${edited ? "edited" : "unchanged"} draft`, async ({ page }) => {
  let messageRid: string | undefined;
  let release: (() => void) | undefined;
  await page.routeWebSocket("**/api/swp", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data)) as { type: string; rid?: string };
      if (frame.type === "message") messageRid = frame.rid;
      server.send(data);
    });
    server.onMessage((data) => {
      const frame = JSON.parse(String(data)) as { type: string; rid?: string };
      if (frame.type === "request_finished" && frame.rid === messageRid) release = () => socket.send(data);
      else socket.send(data);
    });
  });
  await openCharacter(page);
  await page.locator(".section-heading").filter({ has: page.getByRole("heading", { name: "Characters", exact: true }) }).getByRole("button", { name: "New character", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Character name", { exact: true }).fill("other");
  await dialog.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByLabel("Message", { exact: true }).fill("Original submitted draft");
  await page.getByLabel("Attach images", { exact: true }).setInputFiles(picture);
  await saved(page);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => typeof release).toBe("function");
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "O other" }).click();
  await expect(page.getByRole("heading", { name: "other / main" })).toBeVisible();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Original submitted draft");
  if (edited) {
    await page.getByLabel("Message", { exact: true }).fill("New draft must survive completion");
    await page.getByRole("button", { name: "Remove draft.png", exact: true }).click();
    await page.getByLabel("Attach images", { exact: true }).setInputFiles({ ...picture, name: "next.png" });
    await saved(page);
  }
  if (release === undefined) throw new Error("Missing held send completion");
  release();
  await expect(page.getByText("Previous send needs review", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(edited ? "New draft must survive completion" : "");
  await expect(page.getByRole("button", { name: "Remove draft.png", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove next.png", exact: true })).toHaveCount(edited ? 1 : 0);
  await saved(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(edited ? "New draft must survive completion" : "");
  await expect(page.getByRole("button", { name: "Remove next.png", exact: true })).toHaveCount(edited ? 1 : 0);
  await expect(page.getByText("Previous send needs review", { exact: true })).toHaveCount(0);
});

for (const destination of ["character", "thread", "round trip", "reconnect"]) test(`a delayed draft save cannot dispatch after a ${destination} change`, async ({ page }) => {
  await page.addInitScript(`window.shoreSockets = []; window.WebSocket = class extends WebSocket {
    constructor(...args) { super(...args); window.shoreSockets.push(this); }
  };`);
  let sends = 0;
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    if ((JSON.parse(String(payload)) as { type: string }).type === "message") sends += 1;
  }));
  await openCharacter(page);
  if (destination === "thread") {
    await page.locator(".section-heading").filter({ has: page.getByRole("heading", { name: "Conversations", exact: true }) }).getByRole("button", { name: "New conversation", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("New thread ID", { exact: true }).fill("side");
    await dialog.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
  } else if (destination !== "reconnect") {
    await page.locator(".section-heading").filter({ has: page.getByRole("heading", { name: "Characters", exact: true }) }).getByRole("button", { name: "New character", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Character name", { exact: true }).fill("other");
    await dialog.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
  }
  await page.getByLabel("Message", { exact: true }).fill("Only send this draft to nova main");
  await page.getByLabel("Attach images", { exact: true }).setInputFiles(picture);
  await saved(page);
  await page.evaluate(`{
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", { ...descriptor, set(handler) {
      if (this.mode !== "readwrite" || !this.objectStoreNames.contains("drafts")) return descriptor.set.call(this, handler);
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", descriptor);
      descriptor.set.call(this, event => { window.shoreReleaseDraft = () => handler.call(this, event); });
    } });
  }`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate('typeof window.shoreReleaseDraft')).toBe("function");
  if (destination === "reconnect") {
    await page.evaluate("window.shoreSockets.at(-1).close()");
    await expect.poll(() => page.evaluate("window.shoreSockets.length")).toBe(2);
    await expect(page.locator(".connection.online")).toBeVisible();
  } else if (destination === "thread") {
    await page.getByRole("navigation", { name: "Threads" }).getByRole("button", { name: /side/ }).click();
    await expect(page.getByRole("heading", { name: "nova / side" })).toBeVisible();
  } else {
    await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "O other" }).click();
    await expect(page.getByRole("heading", { name: "other / main" })).toBeVisible();
    if (destination === "round trip") {
      await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
      await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
    }
  }
  await page.evaluate("window.shoreReleaseDraft()");
  await expect(page.getByRole("alert")).toContainText("Conversation changed before sending. Your draft was retained.");
  expect(sends).toBe(0);
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(0);
  if (destination === "thread") await page.getByRole("navigation", { name: "Threads" }).getByRole("button", { name: /main/ }).click();
  if (destination === "character") await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Only send this draft to nova main");
  await expect(page.getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible();
  await expect(page.getByText("Previous send needs review")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Only send this draft to nova main");
  await expect(page.getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible();
  await expect(page.getByText("Previous send needs review")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("reconnecting during generation retires the departed session's live response", async ({ page }) => {
  await page.addInitScript(`window.shoreSockets = []; window.WebSocket = class extends WebSocket {
    constructor(...args) { super(...args); window.shoreSockets.push(this); }
  };`);
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("hold this request");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const live = page.getByRole("article", { name: "Streaming response" });
  await expect(live).toBeVisible();
  await page.evaluate("window.shoreSockets.at(-1).close()");
  await expect.poll(() => page.evaluate("window.shoreSockets.length")).toBe(2);
  await expect(page.locator(".connection.online")).toBeVisible();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
  await expect(live).toHaveCount(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "I checked the conversation", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("A fresh request after reconnecting");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("A fresh request after reconnecting");
  await expect(live).toHaveCount(0);
});

test("draft text and actual image attachments survive reload and send once", async ({ page }) => {
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("Saved picture question");
  await page.getByLabel("Attach images", { exact: true }).setInputFiles(picture);
  await expect(page.getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved on this device" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Saved picture question");
  await expect(page.getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Saved picture question");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await expect(page.getByRole("article", { name: "user message" }).getByRole("img")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(1);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove draft.png", exact: true })).toHaveCount(0);
});

test("concurrent tabs keep their own drafts for the same conversation", async ({ page, context }) => {
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("First tab draft");
  await expect(page.getByRole("status").filter({ hasText: "Draft saved on this device" })).toBeVisible();
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByRole("heading", { name: "nova / main" })).toBeVisible();
  await other.getByLabel("Message", { exact: true }).fill("Second tab draft");
  await expect(other.getByRole("status").filter({ hasText: "Draft saved on this device" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("First tab draft");
  await other.reload();
  await expect(other.getByLabel("Message", { exact: true })).toHaveValue("Second tab draft");
});

test("duplicated tabs copy inherited drafts without taking ownership from the original", async ({ page }) => {
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("Original tab draft");
  await page.getByLabel("Attach images", { exact: true }).setInputFiles(picture);
  await saved(page);
  const popup = page.waitForEvent("popup");
  await page.evaluate('window.open(location.href, "_blank")');
  const copy = await popup;
  await expect(copy.getByLabel("Message", { exact: true })).toHaveValue("Original tab draft");
  await expect(copy.getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible();
  await copy.getByLabel("Message", { exact: true }).fill("Copied tab changed");
  await saved(copy);
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Original tab draft");
  await copy.reload();
  await expect(copy.getByLabel("Message", { exact: true })).toHaveValue("Copied tab changed");
  await copy.close();
});

test("a closed tab's text and pasted image can be recovered and explicitly discarded", async ({ page, context }) => {
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("Recover from closed tab");
  await page.evaluate(`{
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(${JSON.stringify([...picture.buffer])})], "pasted.png", { type: "image/png" }));
    document.getElementById("message-composer").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }`);
  await expect(page.getByRole("button", { name: "Remove pasted.png", exact: true })).toBeVisible();
  await saved(page);
  const url = page.url();
  await page.close();
  const recovered = await context.newPage();
  await recovered.goto(url);
  await expect(recovered.getByRole("heading", { name: "nova / main" })).toBeVisible();
  await draftAction(recovered, "Saved drafts");
  const dialog = recovered.getByRole("dialog", { name: "Saved drafts", exact: true });
  const record = dialog.getByRole("region", { name: "Saved draft", exact: true }).filter({ hasText: "Recover from closed tab" });
  await expect(record).toContainText("1 image(s)");
  await record.getByRole("button", { name: "Copy into composer", exact: true }).click();
  await expect(recovered.getByLabel("Message", { exact: true })).toHaveValue("Recover from closed tab");
  await expect(recovered.getByRole("button", { name: "Remove pasted.png", exact: true })).toBeVisible();
  await recovered.getByRole("button", { name: "Send", exact: true }).click();
  await expect(recovered.getByRole("article", { name: "user message" }).getByRole("img")).toBeVisible();
  await expect(recovered.getByLabel("Message", { exact: true })).toHaveValue("");
  await saved(recovered);
  await draftAction(recovered, "Saved drafts");
  await record.getByRole("button", { name: "Discard saved draft", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm discard", exact: true }).click();
  await expect(dialog).toContainText("No saved drafts.");
});

test("reload during an actual send keeps a review notice without resending", async ({ page }) => {
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("hold this request");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("article", { name: "Streaming response" })).toBeVisible();
  await saved(page);
  await page.reload();
  await expect(page.getByText("Previous send needs review", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(1);
  await page.getByRole("button", { name: "I checked the conversation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("storage failure stays visible and saving can be retried without losing the open draft", async ({ page }) => {
  await openCharacter(page);
  await page.evaluate(`{
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    globalThis.restoreDraftStorageFixture = () => Object.defineProperty(globalThis, "indexedDB", descriptor);
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new DOMException("Storage disabled for the fixture", "SecurityError"); } });
  }`);
  await page.getByLabel("Message", { exact: true }).fill("Retain this despite storage failure");
  await expect(page.getByRole("status").filter({ hasText: "Draft not saved" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("status").filter({ hasText: "Draft not saved" })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Retain this despite storage failure");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".section-heading").filter({ hasText: "Characters" }).getByRole("button", { name: "New character", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create character", exact: true });
  await dialog.getByLabel("Character name", { exact: true }).fill("other");
  await dialog.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "O other" }).click();
  await expect(page.getByRole("heading", { name: "other / main" })).toBeVisible();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Retain this despite storage failure");
  await expect(page.getByRole("status").filter({ hasText: "Draft not saved" })).toBeVisible();
  await page.evaluate("restoreDraftStorageFixture()");
  await page.getByRole("button", { name: "Retry saving", exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Retain this despite storage failure");
});

test("discarding a stale saved draft cannot delete another tab's newer edit", async ({ page, context }) => {
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("Before concurrent edit");
  await saved(page);
  const other = await context.newPage();
  await other.goto(page.url());
  await draftAction(other, "Saved drafts");
  const dialog = other.getByRole("dialog", { name: "Saved drafts", exact: true });
  await expect(dialog).toContainText("Before concurrent edit");
  await page.getByLabel("Message", { exact: true }).fill("Newer edit must survive");
  await saved(page);
  await dialog.getByRole("button", { name: "Discard saved draft", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm discard", exact: true }).click();
  await expect(other.getByRole("alert")).toContainText("changed in another tab");
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Newer edit must survive");
});

test("the draft limit refuses a new save without silently evicting another draft", async ({ page, context }) => {
  await openCharacter(page);
  await page.getByLabel("Message", { exact: true }).fill("Original draft stays");
  await saved(page);
  await page.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open("shore-drafts", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("drafts", "readwrite");
      for (let i = 0; i < 63; i++) transaction.objectStore("drafts").put({ id: "fixture-" + i, conversation: JSON.stringify(["nova", "main"]), revision: 1, text: "Fixture " + i, attachment: null, imageCount: 0, bytes: 100, updated: Date.now(), pending: false });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => reject(transaction.error);
    };
  })`);
  const other = await context.newPage();
  await other.goto(page.url());
  await other.getByLabel("Message", { exact: true }).fill("New draft stays open");
  await expect(other.getByRole("alert")).toContainText("Draft storage is full");
  await expect(other.getByLabel("Message", { exact: true })).toHaveValue("New draft stays open");
  await draftAction(other, "Saved drafts");
  const dialog = other.getByRole("dialog", { name: "Saved drafts", exact: true });
  const first = dialog.getByRole("region", { name: "Saved draft", exact: true }).filter({ has: other.getByText("Fixture 0", { exact: true }) });
  await first.getByRole("button", { name: "Discard saved draft", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm discard", exact: true }).click();
  await expect(first).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await other.getByRole("button", { name: "Retry saving", exact: true }).click();
  await saved(other);
  await other.reload();
  await expect(other.getByLabel("Message", { exact: true })).toHaveValue("New draft stays open");
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Original draft stays");
});
