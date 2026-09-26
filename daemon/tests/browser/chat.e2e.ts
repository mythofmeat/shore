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
