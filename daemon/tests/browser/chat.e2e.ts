import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createCharacter, signIn, watchPage } from "./helpers.ts";

test("sending clears the message box at once and regenerating replaces the reply in place", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "lumen");
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("Please hold this request");
  await box.press("Enter");
  await expect(page.locator("article.message.user")).toContainText("Please hold this request");
  await expect(box).toHaveValue("");
  await expect(box).toBeEditable();
  await expect(page.locator("article.message.assistant.streaming")).toBeVisible();
  await box.fill("A follow-up typed while waiting");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(box).toHaveValue("A follow-up typed while waiting");
  await expect(page.locator("article.message.user")).toHaveCount(1);

  await box.fill("Answer once, then hold regenerations");
  await box.press("Enter");
  const settled = page.locator("article.message.assistant:not(.streaming)");
  await expect(settled.last()).toContainText("Answer once, then hold regenerations");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await settled.last().hover();
  await settled.last().getByRole("button", { name: "Generate another response" }).click();
  await expect(page.locator("article.message.assistant.streaming")).toBeVisible();
  await expect(page.locator("article.message.assistant", { hasText: "Answer once, then hold regenerations" })).toHaveCount(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("article.message.assistant.streaming")).toHaveCount(0);
  await expect(settled).toHaveCount(1);
  await expect(settled.last()).toContainText("Answer once, then hold regenerations");
  await check();
});

test("regenerating, swiping and deleting take the reply's workspace changes with them", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "quill");
  const box = page.getByLabel("Message", { exact: true });
  const settled = page.locator("article.message.assistant:not(.streaming)");
  await box.fill("Run the workspace note fixture");
  await box.press("Enter");
  await expect(settled.last()).toContainText(/Before note-\d+ the notes were \[\]/);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  await settled.last().hover();
  await settled.last().getByRole("button", { name: "Generate another response" }).click();
  const current = page.locator("article.message.assistant").last();
  await expect(current.getByRole("button", { name: /Response 2 of 2/ })).toBeVisible();
  await expect(current).toContainText(/Before note-\d+ the notes were \[\]/);
  await current.getByRole("button", { name: "Previous response" }).click();
  await expect(page.getByText("Restored 2 workspace files")).toBeVisible();

  await box.fill("Run the workspace note fixture again");
  await box.press("Enter");
  await expect(page.locator("article.message.user")).toHaveCount(2);
  await expect(settled.last()).toContainText(/the notes were \[reply-\d+\.md\]/);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  const newest = settled.last();
  await newest.hover();
  await newest.getByRole("button", { name: "Delete", exact: true }).click();
  await newest.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Restored 1 workspace file")).toBeVisible();
  await check();
});

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const frameType = (frame: string | Buffer): unknown => { try { return (JSON.parse(frame.toString()) as { type?: unknown }).type; } catch { return undefined; } };
const unconfirmedSends = (page: Page) => page.evaluate("new Promise((resolve, reject) => { const open = indexedDB.open('shore-drafts'); open.onerror = () => reject(open.error); open.onsuccess = () => { const count = open.result.transaction('sending').objectStore('sending').count(); count.onsuccess = () => { open.result.close(); resolve(count.result); }; }; })");

test("reloading between sending and the daemon saving the message never loses it or brings back a saved one", async ({ page }) => {
  const check = await watchPage(page);
  let holdSends = false;
  let hideAcceptance = false;
  let held = () => {};
  await page.routeWebSocket(/\/api\/swp$/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((frame) => { if (holdSends && frameType(frame) === "message") { held(); return; } server.send(frame); });
    server.onMessage((frame) => { if (!hideAcceptance || frameType(frame) !== "request_accepted") socket.send(frame); });
  });
  await signIn(page);
  await createCharacter(page, "wren");
  const box = page.getByLabel("Message", { exact: true });

  hideAcceptance = true;
  await box.fill("Please hold this request after saving it");
  await box.press("Enter");
  await expect(page.locator("article.message.user")).toContainText("Please hold this request after saving it");
  await expect(box).toHaveValue("");
  expect(await unconfirmedSends(page)).toBe(1);
  await page.reload();
  await expect.poll(() => unconfirmedSends(page)).toBe(0);
  await expect(box).toHaveValue("");
  await expect(page.locator("article.message.user")).toHaveCount(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  holdSends = true;
  await page.locator('input[type="file"]').setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PIXEL });
  await expect(page.locator(".attachment")).toHaveCount(1);
  await box.fill("A message the daemon never received");
  const sent = new Promise<void>((resolve) => { held = resolve; });
  await box.press("Enter");
  await sent;
  await expect(box).toHaveValue("");
  await expect(page.locator(".attachment")).toHaveCount(0);
  holdSends = false;
  await page.reload();
  await expect(box).toHaveValue("A message the daemon never received");
  await expect(page.getByRole("button", { name: "Remove pixel.png" })).toBeVisible();
  await expect(page.getByText("Your earlier message to wren wasn’t saved, so it’s back in its message box.")).toBeVisible();
  await expect(page.locator("article.message.user")).toHaveCount(1);
  expect(await unconfirmedSends(page)).toBe(0);

  await box.press("Enter");
  await expect(page.locator("article.message.user").last()).toContainText("A message the daemon never received");
  await expect(page.locator("article.message.user")).toHaveCount(2);
  await expect(page.locator(".attachment")).toHaveCount(0);
  await check();
});

test("a message the daemon saved is never brought back when the conversation switches mid-send, the echo comes late and the reply fails", async ({ page }) => {
  const check = await watchPage(page);
  let holding = false;
  let sent: string | undefined;
  const held: (string | Buffer)[] = [];
  const echoes: (string | Buffer)[] = [];
  const rid = (frame: string | Buffer): unknown => (JSON.parse(frame.toString()) as { rid?: unknown }).rid;
  await page.routeWebSocket(/\/api\/swp$/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((frame) => {
      if (holding && frameType(frame) === "message") { held.push(frame); sent = String(rid(frame)); return; }
      for (const waiting of held.splice(0)) server.send(waiting);
      server.send(frame);
    });
    server.onMessage((frame) => {
      if (sent !== undefined && frameType(frame) === "new_message") { echoes.push(frame); return; }
      socket.send(frame);
      if (frameType(frame) === "request_finished" && rid(frame) === sent) { sent = undefined; for (const echo of echoes.splice(0)) socket.send(echo); }
    });
  });
  await signIn(page);
  await createCharacter(page, "tern");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New conversation with tern" });
  await dialog.getByLabel("Name").fill("side");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".topbar-thread")).toHaveText("side");

  const box = page.getByLabel("Message", { exact: true });
  holding = true;
  await box.fill("Please fail this reply once it is saved");
  await box.press("Enter");
  await expect.poll(() => held.length).toBe(1);
  holding = false;
  const threads = page.getByRole("group", { name: "tern conversations" });
  await threads.getByRole("button", { name: "main", exact: true }).click();
  await expect(page.locator(".topbar-thread")).toHaveText("main");
  await expect(page.getByRole("alert").filter({ hasText: "Fixture reply failure" })).toBeVisible();
  await expect.poll(() => unconfirmedSends(page)).toBe(0);

  await threads.getByRole("button", { name: "side", exact: true }).click();
  await expect(page.locator(".topbar-thread")).toHaveText("side");
  await expect(page.locator("article.message.user")).toHaveCount(1);
  await expect(page.locator("article.message.user")).toContainText("Please fail this reply once it is saved");
  await expect(box).toHaveValue("");
  await expect(page.getByText(/Your draft was restored|back in its message box/)).toHaveCount(0);
  await check();
});

const savedDraft = (page: Page) => page.evaluate("new Promise((resolve, reject) => { const open = indexedDB.open('shore-drafts'); open.onerror = () => reject(open.error); open.onsuccess = () => { const all = open.result.transaction('drafts').objectStore('drafts').getAll(); all.onsuccess = () => { open.result.close(); resolve(all.result.map((row) => row.text).join('|')); }; }; })");

test("vim mode edits with vim keys, keeps the draft over a reload, attaches pasted images and follows the Enter preference in insert mode", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "vesper");
  await page.evaluate("location.hash = '#settings/keyboard'");
  await page.getByRole("switch", { name: "Vim mode", exact: true }).click();
  await expect(page.getByText("Switch to normal mode (Stop ends a response)")).toBeVisible();
  await page.evaluate("location.hash = ''");
  const box = page.getByRole("textbox", { name: "Message", exact: true }).and(page.locator("[contenteditable]"));
  await expect(box).toBeFocused();
  await page.keyboard.type("Ready? first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await expect(box).toContainText("second line");
  await page.keyboard.press("Escape");
  await page.keyboard.type("dd");
  await expect(box).toHaveText("Ready? first line");
  await page.keyboard.type("i");
  await page.keyboard.type("Note: ");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(box).toHaveText("Note: Ready? first line");
  await expect(page.locator("article.message.user")).toHaveCount(0);

  await expect.poll(() => savedDraft(page)).toBe("Note: Ready? first line");
  await page.reload();
  await expect(box).toHaveText("Note: Ready? first line");
  await page.evaluate(`{ const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob("${PIXEL.toString("base64")}"), (char) => char.charCodeAt(0))], "pasted.png", { type: "image/png" })); document.getElementById("message-composer").shadowRoot.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true, composed: true })); }`);
  await expect(page.getByRole("button", { name: "Remove pasted.png" })).toBeVisible();
  await expect(box).toHaveText("Note: Ready? first line");
  await expect(box).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("article.message.user")).toContainText("Note: Ready? first line");
  await expect(page.locator(".attachment")).toHaveCount(0);
  await expect(box.locator(".cm-placeholder")).toHaveText("Message vesper");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  await page.evaluate("location.hash = '#settings/keyboard'");
  await page.getByRole("switch", { name: "Enter sends", exact: true }).click();
  await page.evaluate("location.hash = ''");
  await expect(box).toBeFocused();
  await page.keyboard.type("two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("lines");
  await expect(box.locator(".cm-line")).toHaveText(["two", "lines"]);
  await expect(page.locator("article.message.user")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator("article.message.user")).toHaveCount(2);
  await expect(page.locator("article.message.user").last()).toContainText(/two\s*lines/);
  await check();
});
