import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createCharacter, send, signIn, watchPage } from "./helpers.ts";

test("chat renders markdown, edits in place, confirms deletion, swipes between responses and keeps drafts", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "nova");
  await send(page, "A **thoughtful** question\n\n- first\n- second");
  const user = page.locator("article.message.user").first();
  await expect(user.locator("strong")).toHaveText("thoughtful");
  await expect(user.locator("li")).toHaveText(["first", "second"]);
  const reply = page.locator("article.message.assistant").last();
  await expect(reply.getByRole("button", { name: "Reasoning" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
  await reply.getByRole("button", { name: "Reasoning" }).click();
  await expect(reply).toContainText("Considering the question");

  await user.hover();
  await user.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = user.getByLabel("Edit message");
  await expect(editor).toHaveValue("A **thoughtful** question\n\n- first\n- second");
  await editor.fill("Edited <img src=x onerror=alert(1)> question");
  await editor.press("Control+Enter");
  await expect(user).toContainText("Edited <img src=x onerror=alert(1)> question");
  await expect(user.locator("img")).toHaveCount(0);

  await reply.hover();
  await reply.getByRole("button", { name: "Generate another response" }).click();
  const current = page.locator("article.message.assistant").last();
  await expect(current.getByRole("button", { name: /Response 2 of 2/ })).toBeVisible();
  await current.getByRole("button", { name: "Previous response" }).click();
  await expect(current.getByRole("button", { name: /Response 1 of 2/ })).toBeVisible();
  await current.getByRole("button", { name: /Response 1 of 2/ }).click();
  const responses = page.getByRole("dialog", { name: "Responses" });
  await expect(responses.getByRole("option")).toHaveCount(2);
  await responses.getByRole("option").nth(1).click();
  await expect(responses).toBeHidden();
  await expect(current.getByRole("button", { name: /Response 2 of 2/ })).toBeVisible();

  await send(page, "Second question");
  const second = page.locator("article.message.user").nth(1);
  await second.hover();
  await second.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(second.getByText("Delete this message?")).toBeVisible();
  await second.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(second.getByText("Delete this message?")).toBeHidden();
  await second.hover();
  await second.getByRole("button", { name: "Delete", exact: true }).click();
  await second.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("article.message.user")).toHaveCount(1);

  await page.getByLabel("Message", { exact: true }).fill("A draft that survives reload");
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("A draft that survives reload");
  await expect(page).toHaveURL(/\/workspace\/nova\/main$/);
  await check();
});

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

test("a tool loop streams as one reply and its steps collapse into one summary", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "orbit");
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("Please hold the tool loop fixture");
  await box.press("Enter");
  const replies = page.locator("article.message.assistant");
  const streaming = page.locator("article.message.assistant.streaming");
  await expect(streaming).toContainText("Found both notes.");
  await expect(replies).toHaveCount(1);
  const activity = streaming.locator(".activity");
  await expect(activity).toHaveCount(1);
  await expect(activity.locator(".activity-head")).toContainText("Reasoned and used 2 tools");
  await expect(activity.locator(".activity-head")).toContainText("bash");
  await expect(streaming.locator(".tool")).toHaveCount(0);
  await activity.locator(".activity-head").click();
  await expect(activity.locator(".tool")).toHaveCount(2);
  await expect(activity.locator(".reasoning")).toHaveCount(3);
  await expect(activity.locator(".tool-summary")).toHaveText(["echo loop-1", "echo loop-2"]);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(streaming).toHaveCount(0);
  await expect(replies).toHaveCount(1);
  await expect(replies.locator(".activity-head")).toContainText("Reasoned and used 2 tools");
  await expect(replies).not.toContainText("Found both notes.");

  await box.fill("Please run the tool loop fixture");
  await box.press("Enter");
  const settled = page.locator("article.message.assistant:not(.streaming)");
  await expect(settled).toHaveCount(2);
  await expect(settled.last()).toContainText("Found both notes.");
  await expect(settled.last().locator(".activity")).toHaveCount(1);
  await expect(settled.last().locator(".activity-head")).toContainText("Reasoned and used 2 tools");
  await expect(settled.last().locator(".tool")).toHaveCount(0);
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

test("the effort chip beside the message box changes reasoning effort in two clicks", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "ember");
  const chip = page.getByRole("button", { name: /^Reasoning effort: / });
  await expect(chip).toContainText("Effort");
  await chip.click();
  const menu = page.getByRole("menu", { name: "Reasoning effort" });
  await expect(menu.getByRole("menuitem")).toContainText(["adaptive", "low", "medium", "high", "xhigh", "max", "off"]);
  await menu.getByRole("menuitem", { name: "high", exact: true }).click();
  await expect(chip).toHaveAccessibleName(/^Reasoning effort: high\./);
  await expect(chip).toContainText("high");

  await page.reload();
  await expect(chip).toContainText("high");
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("searchbox").fill("reasoning effort");
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem", { name: /^high/ })).toContainText("Current");
  await menu.getByRole("menuitem", { name: "Reset to default" }).click();
  await expect(chip).not.toContainText("high");
  await check();
});

test("the sidebar collapses on desktop and becomes a drawer on phones", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "ada");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "New character" }).click();
  await page.getByRole("dialog", { name: "New character" }).getByLabel("Name").fill("bea");
  await page.getByRole("dialog", { name: "New character" }).getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".topbar-name")).toHaveText("bea");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".settings-page h1")).toHaveText("Models");
  await check();
});

test("conversation menu renames, forks, archives, and the model picker sets a conversation model", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "iris");
  await send(page, "Hello");
  const menu = async (name: string) => {
    await page.getByRole("button", { name: "Conversation options" }).click();
    await page.getByRole("menuitem", { name }).click();
  };
  await menu("Rename…");
  const rename = page.getByRole("dialog", { name: "Rename conversation" });
  await rename.getByLabel("Label").fill("Harbor walk");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".topbar-thread")).toHaveText("Harbor walk");
  await expect(page.getByRole("button", { name: "Harbor walk" })).toBeVisible();

  await menu("Fork conversation…");
  const fork = page.getByRole("dialog", { name: /Fork/ });
  await fork.getByLabel("New conversation name").fill("side");
  await fork.getByRole("button", { name: "Fork", exact: true }).click();
  await expect(page.locator(".topbar-thread")).toHaveText("side");
  await expect(page.locator("article.message.user")).toContainText("Hello");

  await page.getByRole("button", { name: /Chat model/ }).click();
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await picker.getByRole("option", { name: /anthropic:fast-fixture/ }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole("button", { name: /Chat model/ })).toContainText("fast-fixture");

  await menu("Archive conversation…");
  await page.getByRole("dialog", { name: /Archive/ }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("group", { name: "iris conversations" }).getByRole("button", { name: "side" })).toHaveCount(0);
  await check();
});

test("the Sodium fog theme applies before first paint after a reload", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: /Sodium fog/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "fog");
  const serif = await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--font-body')");
  expect(String(serif)).toContain("Newsreader");
  const early: string[] = [];
  page.on("domcontentloaded", () => { void page.evaluate("document.documentElement.dataset.theme ?? ''").then((value) => early.push(String(value))); });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "fog");
  expect(early).toEqual(["fog"]);
  await page.getByRole("radio", { name: /Shore/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  await check();
});

test("the text size scales message text and the interface, and applies before first paint after a reload", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "nova");
  await send(page, "Hello there");
  const sizes = async () => await page.evaluate("[getComputedStyle(document.querySelector('.message-body .prose')).fontSize, getComputedStyle(document.body).fontSize]");
  expect(await sizes()).toEqual(["15px", "14px"]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Larger" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "larger");
  const early: string[] = [];
  page.on("domcontentloaded", () => { void page.evaluate("document.documentElement.dataset.fontSize ?? ''").then((value) => early.push(String(value))); });
  await page.reload();
  await expect(page.getByRole("radio", { name: "Larger" })).toHaveAttribute("aria-checked", "true");
  expect(early).toEqual(["larger"]);
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.locator(".message-body").first()).toBeVisible();
  expect(await sizes()).toEqual(["18.75px", "17.5px"]);
  await check();
});

test("while the tab is unfocused a reply shows a desktop notification and an unread count in the title", async ({ page }) => {
  const check = await watchPage(page);
  await page.addInitScript("window.shoreNotifications = []; window.Notification = class { static permission = 'default'; static requestPermission() { window.Notification.permission = 'granted'; return Promise.resolve('granted'); } constructor(title, options) { this.onclick = null; window.shoreNotifications.push({ title, body: options.body, tag: options.tag }); } close() {} };");
  await signIn(page);
  await createCharacter(page, "nova");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Notify when unfocused" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Back to chat" }).click();
  await page.evaluate("document.hasFocus = () => false");
  await send(page, "Ping while away");
  await expect(page).toHaveTitle("(1) nova · Shore");
  expect(await page.evaluate("window.shoreNotifications")).toEqual([{ title: "nova", body: expect.stringContaining("Ping while away") as unknown, tag: "shore:nova/main" }]);
  await page.evaluate("document.hasFocus = () => true; window.dispatchEvent(new Event('focus'))");
  await expect(page).toHaveTitle("nova · Shore");
  await check();
});

test("a cleared context becomes a segment you open, read without editing, and leave", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "wren");
  await send(page, "Before the clear");
  await page.getByRole("button", { name: "Conversation options" }).click();
  await page.getByRole("menuitem", { name: "Clear context…" }).click();
  const clear = page.getByRole("dialog", { name: "Clear context" });
  await clear.getByLabel("Note for the segment").fill("first evening");
  await clear.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(clear).toBeHidden();

  const edge = page.locator(".segment-edge");
  await expect(edge).toContainText("Before this: Segment 0");
  await expect(edge.getByRole("separator")).toHaveText("Context starts here");
  await expect(page.locator("article.message")).toHaveCount(0);
  await send(page, "After the clear");
  await expect(page.locator("article.message.user")).toHaveCount(1);

  await edge.getByRole("button", { name: "View" }).click();
  const banner = page.locator(".segment-banner");
  await expect(banner).toContainText("Viewing Segment 0");
  await expect(page.locator("article.message.user")).toContainText("Before the clear");
  await expect(page.locator(".transcript")).toContainText("Start of the conversation");
  await expect(page.locator(".transcript")).toContainText("After this: the current conversation");
  const archived = page.locator("article.message.user").first();
  await archived.hover();
  await expect(archived.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(archived.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(archived.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

  await banner.getByRole("button", { name: "Back to current" }).click();
  await expect(banner).toBeHidden();
  await expect(page.locator("article.message.user")).toContainText("After the clear");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Memory & segments", exact: true }).click();
  await page.locator(".segment").getByRole("button", { name: "Open in conversation" }).click();
  await expect(page.locator(".segment-banner")).toContainText("Viewing Segment 0");
  await page.getByLabel("Message", { exact: true }).fill("Sent from a segment view");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page.locator(".segment-banner")).toBeHidden();
  await expect(page.locator("article.message.assistant").last()).toContainText("Sent from a segment view");
  await check();
});
