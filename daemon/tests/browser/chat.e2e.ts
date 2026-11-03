import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createCharacter, createThread, send, signIn, watchPage } from "./helpers.ts";

test("sending clears the message box at once and regenerating replaces the reply in place", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "lumen");
  const box = page.getByLabel("Message", { exact: true });
  await expect(box).toBeFocused();
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

test("a message whose reply was stopped can be edited and then answered from the browser", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "lumen");
  const box = page.getByLabel("Message", { exact: true });
  const replies = page.locator("article.message.assistant:not(.streaming)");
  await box.fill("A question answered first");
  await box.press("Enter");
  await expect(replies).toContainText("A question answered first");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await box.fill("Please hold this request");
  await box.press("Enter");
  await expect(page.locator("article.message.assistant.streaming")).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await replies.hover();
  await expect(replies.getByRole("button", { name: "Regenerate", exact: true })).toHaveCount(0);
  await expect(replies.getByRole("button", { name: "Generate another response" })).toHaveCount(0);
  const mine = page.locator("article.message.user").last();
  await mine.hover();
  await mine.getByRole("button", { name: "Edit", exact: true }).click();
  await mine.getByLabel("Edit message").fill("Edited after stopping");
  await mine.getByRole("button", { name: "Save", exact: true }).click();
  await expect(mine.getByLabel("Edit message")).toHaveCount(0);
  await expect(mine).toContainText("Edited after stopping");
  await mine.hover();
  await mine.getByRole("button", { name: "Generate reply", exact: true }).click();
  await expect(replies.last()).toContainText("Edited after stopping");
  await expect(replies).toHaveCount(2);
  await expect(page.locator("article.message.user")).toHaveCount(2);
  await mine.hover();
  await expect(mine.getByRole("button", { name: "Generate reply", exact: true })).toHaveCount(0);
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

test("a message the daemon saved is never brought back when the thread switches mid-send, the echo comes late and the reply fails", async ({ page }) => {
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
  await createThread(page, "tern", "side");

  const box = page.getByLabel("Message", { exact: true });
  await expect(box).toBeFocused();
  holding = true;
  await box.fill("Please fail this reply once it is saved");
  await box.press("Enter");
  await expect.poll(() => held.length).toBe(1);
  holding = false;
  const threads = page.getByRole("group", { name: "tern threads" });
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

test("archiving the open thread takes every tab on it home, closes what was open there and shows the next message", async ({ page, context }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "wren");
  await send(page, "A message for home");
  await createThread(page, "wren", "side");
  await send(page, "A message for the side thread");

  const otherTab = await context.newPage();
  await otherTab.goto("/workspace/wren/side");
  await expect(otherTab.locator("article.message.user")).toContainText("A message for the side thread");
  await otherTab.getByRole("button", { name: "Thread options" }).click();
  await otherTab.getByRole("menuitem", { name: "Clear context…" }).click();
  await expect(otherTab.getByRole("dialog", { name: "Clear context" })).toBeVisible();

  await page.bringToFront();
  await page.getByRole("button", { name: "Thread options" }).click();
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  const dialog = page.getByRole("dialog", { name: "Archive “side”?" });
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Archived “side”")).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();

  for (const tab of [page, otherTab]) {
    await expect(tab.locator(".topbar-thread")).toHaveText("main");
    await expect(tab).toHaveURL(/\/workspace\/wren\/main$/);
    await expect(tab.getByRole("group", { name: "wren threads" }).getByRole("button", { name: "side", exact: true })).toHaveCount(0);
    await expect(tab.locator("dialog[open]")).toHaveCount(0);
    await expect(tab.locator("article.message.user")).toContainText("A message for home");
  }

  await otherTab.bringToFront();
  await send(otherTab, "Typed after archiving");
  await expect(page.locator("article.message.assistant").last()).toContainText("Typed after archiving");
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

  await createThread(page, "vesper", "side");
  await expect(box).toBeFocused();
  await check();
});

test("compacting from the palette starts on Enter and leaves other threads usable while it runs", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "wren");
  await send(page, "cancel memory once");
  await send(page, "Keep the recent turn");

  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands").fill("Compact context");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Compact context" });
  await expect(dialog.getByRole("button", { name: "Compact", exact: true })).toBeFocused();
  await dialog.getByLabel("Turns to keep").fill("1");
  await dialog.getByLabel("Turns to keep").press("Enter");
  await expect(dialog).toBeHidden();
  const compacting = page.getByRole("status").filter({ hasText: "Compacting context" });
  await expect(compacting).toBeVisible();

  await createThread(page, "wren", "side");
  await expect(compacting).toBeHidden();
  const threadList = page.getByRole("group", { name: "wren threads" });
  await expect(threadList.getByRole("button", { name: "main (compacting)", exact: true })).toBeVisible();
  await send(page, "Chatting while main compacts");

  await threadList.getByRole("button", { name: "main (compacting)", exact: true }).click();
  await expect(page.locator(".topbar-thread")).toHaveText("main");
  await expect(compacting).toBeVisible();
  await compacting.getByRole("button", { name: /Compacting context/ }).click();
  const view = page.getByRole("dialog", { name: "Compaction" });
  await expect(view.getByText("You started it")).toBeVisible();
  await expect(view.getByText("Compacting", { exact: true })).toBeVisible();
  await expect(view.getByLabel("What the compaction is doing")).toContainText("bash");
  await view.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(view.getByText(/Compaction paused/)).toBeVisible();
  await expect(view.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(compacting).toBeHidden();
  await view.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(view).toBeHidden();
  await page.getByRole("button", { name: "Compaction finished. Show the compaction" }).click();
  await expect(view.getByText(/Compaction paused/)).toBeVisible();
  await view.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(view).toBeHidden();
  await expect(page.getByRole("button", { name: "Compaction finished. Show the compaction" })).toHaveCount(0);
  await check();
});

test("a thread's menu changes its settings without opening it, and archiving the open thread lands on home", async ({ page }) => {
  const finish = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "plover");
  await createThread(page, "plover", "side");
  await send(page, "written in side");
  const threads = page.getByRole("group", { name: "plover threads" });

  await threads.getByRole("button", { name: "main", exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Options for main" });
  await expect(menu.getByRole("menuitem", { name: "Make home" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Archive…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await threads.getByRole("button", { name: "main", exact: true }).hover();
  await threads.getByRole("button", { name: "Options for main" }).click();
  await page.getByRole("menuitem", { name: "Thread settings…" }).click();
  const settings = page.getByRole("dialog", { name: "Thread settings" });
  await settings.getByLabel("Label", { exact: true }).fill("Everyday");
  await settings.getByLabel("When it gets long").selectOption("trim");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(threads.getByRole("button", { name: "Everyday", exact: true })).toBeVisible();
  await expect(page.locator(".topbar-thread")).toHaveText("side");

  await threads.getByRole("button", { name: "Everyday", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Thread settings…" }).click();
  await expect(settings.getByLabel("When it gets long")).toHaveValue("trim");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toBeHidden();

  await threads.getByRole("button", { name: "side", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  const archive = page.getByRole("dialog", { name: "Archive “side”?" });
  await archive.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(archive).toBeHidden();
  await expect(page.locator(".topbar-thread")).toHaveText("Everyday");
  await expect(page).toHaveURL(/\/workspace\/plover\/main$/);
  await expect(threads.getByRole("button", { name: "side", exact: true })).toHaveCount(0);
  await send(page, "after the archive");
  await expect(page.locator("article.message.user").last()).toContainText("after the archive");
  await finish();
});

test("threads can be dragged into order and into folders, the layout survives a reload, and a collapsed folder still shows its unread count", async ({ page }) => {
  const finish = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "marten");
  for (const name of ["first", "second", "third"]) await createThread(page, "marten", name);
  const threads = page.getByRole("group", { name: "marten threads" });
  const rows = () => threads.locator(".thread-row:not(.folder-row) .sidebar-name");
  await expect(rows()).toHaveText(["main", "third", "second", "first"]);

  await threads.getByRole("button", { name: "first", exact: true }).dragTo(threads.getByRole("button", { name: "third", exact: true }), { targetPosition: { x: 40, y: 2 } });
  await expect(rows()).toHaveText(["main", "first", "third", "second"]);

  await threads.getByRole("button", { name: "third", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move down" }).click();
  await expect(rows()).toHaveText(["main", "first", "second", "third"]);

  await page.getByRole("button", { name: "marten", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "New folder…" }).click();
  const newFolder = page.getByRole("dialog", { name: "New folder" });
  await newFolder.getByLabel("Name").fill("Stories");
  await newFolder.getByRole("button", { name: "Create", exact: true }).click();
  await expect(newFolder).toBeHidden();

  const folder = page.getByRole("group", { name: "Folder Stories" });
  await threads.getByRole("button", { name: "second", exact: true }).dragTo(folder.getByRole("button", { name: "Stories", exact: true }));
  await expect(folder.locator(".thread-row:not(.folder-row) .sidebar-name")).toHaveText(["second"]);

  await threads.getByRole("button", { name: "first", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to folder…" }).click();
  const move = page.getByRole("dialog", { name: "Move “first”" });
  await move.getByLabel("Folder").selectOption("Stories");
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect(move).toBeHidden();
  await expect(folder.locator(".thread-row:not(.folder-row) .sidebar-name")).toHaveText(["second", "first"]);
  await expect(rows()).toHaveText(["main", "third", "second", "first"]);

  await page.reload();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(folder.locator(".thread-row:not(.folder-row) .sidebar-name")).toHaveText(["second", "first"]);
  await expect(rows()).toHaveText(["main", "third", "second", "first"]);

  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".topbar-thread")).toHaveText("second");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator(".topbar-thread")).toHaveText("third");

  await folder.getByRole("button", { name: "Stories", exact: true }).click();
  await expect(rows()).toHaveText(["main", "third"]);
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".topbar-thread")).toHaveText("main");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".topbar-thread")).toHaveText("third");

  const other = await page.context().newPage();
  await other.addInitScript("document.hasFocus = () => false");
  await other.goto("/workspace/marten/second");
  await send(other, "written from another tab");
  await other.close();
  await expect(folder.getByRole("button", { name: "Stories (1 unread message)" })).toBeVisible();
  await finish();
});

test("effort and model sit together in the message box, a change shows at once and holds, and settings reopens on the last page", async ({ page }) => {
  const finish = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "ibis");

  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  await effort.click();
  const level = page.getByRole("menu", { name: "Reasoning effort" }).getByRole("menuitem").first();
  const chosen = (await level.locator(".menu-label").textContent()) ?? "";
  await level.click();
  await expect(effort).toContainText(chosen);

  await page.getByRole("button", { name: /^Chat model:/ }).click();
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await picker.getByRole("option", { name: "anthropic:fast-fixture" }).click();
  await expect(picker).toBeHidden();
  const model = page.getByRole("button", { name: /^Chat model:/ });
  await expect(model).toContainText("fast-fixture");
  await expect(page.getByText("ibis’s default now uses fast-fixture")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Chat model:/ })).toContainText("fast-fixture");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/#settings\/models$/);
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Usage & budgets" }).click();
  await page.getByRole("button", { name: "Back to chat" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/#settings\/usage$/);
  await finish();
});

test("the usage display refreshes after a reply and otherwise leaves the daemon alone", async ({ page }) => {
  const check = await watchPage(page);
  let usageRequests = 0;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { if (String(payload).includes('"name":"usage"')) usageRequests += 1; });
  });
  const settled = async (): Promise<number> => {
    let seen = -1;
    await expect.poll(() => {
      const unchanged = usageRequests === seen;
      seen = usageRequests;
      return unchanged;
    }, { intervals: [1000], message: "usage requests should stop on their own" }).toBe(true);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    return usageRequests;
  };
  await page.addInitScript("localStorage.setItem('shore.view.v1.usage', 'always')");
  await signIn(page);
  await createCharacter(page, "lumen");
  const beforeReply = await settled();
  expect(beforeReply).toBeGreaterThan(0);
  await send(page, "A reply that spends something");
  await expect.poll(() => usageRequests).toBeGreaterThan(beforeReply);
  await settled();
  await check();
});
