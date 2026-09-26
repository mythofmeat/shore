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
