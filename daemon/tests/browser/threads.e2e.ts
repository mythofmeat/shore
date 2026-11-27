import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createCharacter, createThread, send, signIn, watchPage } from "./helpers.ts";

interface Spacing { lineHeight: string; paddingTop: string; paddingBottom: string; borderTopWidth: string; borderBottomWidth: string }
interface TextBox { rows: number; offsetHeight: number; ownerDocument: { defaultView: { getComputedStyle: (box: TextBox) => Spacing } | null } }

async function expectTextBoxesAsTallAsTheirRows(page: Page, where: string): Promise<void> {
  const boxes = await textBoxLines(page);
  expect(boxes.map((box) => box.rows), `${where} has a purpose and a pins box`).toEqual([2, 3]);
  expect(boxes.map((box) => box.lines), where).toEqual([2, 3]);
}

async function textBoxLines(page: Page): Promise<{ rows: number; lines: number }[]> {
  return await page.locator("dialog[open] textarea").evaluateAll((boxes: TextBox[]) => boxes.map((box) => {
    const style = box.ownerDocument.defaultView?.getComputedStyle(box);
    if (style === undefined) throw new Error("the text box has no window");
    const chrome = [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].reduce((sum, part) => sum + Number.parseFloat(part), 0);
    return { rows: box.rows, lines: Math.round((box.offsetHeight - chrome) / Number.parseFloat(style.lineHeight) * 10) / 10 };
  }));
}

test("Back returns to the thread before and Forward comes back, and the tab names the thread and character", async ({ page }) => {
  const finish = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "wren");
  await expect(page).toHaveTitle("main · wren");
  await createThread(page, "wren", "notes");
  await expect(page).toHaveTitle("notes · wren");
  await expect(page).toHaveURL(/\/workspace\/wren\/notes$/);
  await page.goBack();
  await expect(page.locator(".topbar-thread")).toHaveText("main");
  await expect(page).toHaveURL(/\/workspace\/wren\/main$/);
  await expect(page).toHaveTitle("main · wren");
  await page.goForward();
  await expect(page.locator(".topbar-thread")).toHaveText("notes");
  await expect(page).toHaveURL(/\/workspace\/wren\/notes$/);
  await page.goBack();
  await expect(page.locator(".topbar-thread")).toHaveText("main");
  await page.goBack();
  await expect(page, "the address before the first thread was shown is not kept").not.toHaveURL(/\/workspace\/wren/);
  await finish();
});

interface Edges { left: number; right: number; top: number; bottom: number }

async function edgesOf(part: Locator): Promise<Edges> {
  const box = await part.boundingBox();
  if (box === null) throw new Error("a part of the row is not on the page");
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

interface Scrolled { scrollWidth: number; clientWidth: number }
const spill = (box: Scrolled) => box.scrollWidth - box.clientWidth;

async function expectRowLaidOut(row: Locator, where: string): Promise<void> {
  const item = row.locator(".sidebar-item");
  expect(await item.evaluate(spill), `${where}: nothing spills out of the row`).toBe(0);
  const around = await edgesOf(item);
  const selectors = [".sidebar-name", ".sidebar-locked", ".sidebar-draft", ".sidebar-unread", ".sidebar-time"];
  const parts = await Promise.all(selectors.map((selector) => edgesOf(item.locator(selector))));
  for (const selector of selectors.slice(1)) expect(await item.locator(selector).evaluate(spill), `${where}: ${selector} is not squeezed`).toBe(0);
  for (const [index, part] of parts.entries()) {
    expect(part.left, `${where}: part ${String(index)} starts inside the row`).toBeGreaterThanOrEqual(around.left);
    expect(part.right, `${where}: part ${String(index)} ends inside the row`).toBeLessThanOrEqual(around.right);
    expect(Math.abs((part.top + part.bottom) / 2 - (around.top + around.bottom) / 2), `${where}: part ${String(index)} sits on the row's midline`).toBeLessThanOrEqual(1.5);
    const next = parts[index + 1];
    if (next !== undefined) expect(part.right, `${where}: part ${String(index)} ends before the next starts`).toBeLessThanOrEqual(next.left);
  }
  await row.hover();
  await expect(row.locator(".sidebar-time")).toBeHidden();
  const [badge, more] = await Promise.all([edgesOf(item.locator(".sidebar-unread")), edgesOf(row.locator(".thread-more"))]);
  expect(badge.right, `${where}: the options button leaves the unread count showing`).toBeLessThanOrEqual(more.left);
  expect(more.right, `${where}: the options button stays inside the row`).toBeLessThanOrEqual(around.right);
}

test("a row's name, lock, unsent message, unread count and time sit on one line inside it, and on hover the options button takes the time's place beside the count, at the largest text and on the narrowest phone", async ({ page }) => {
  const finish = await watchPage(page);
  const long = "a-thread-whose-name-runs-on-well-past-the-sidebar";
  await signIn(page);
  await createCharacter(page, "kestrel");
  await createThread(page, "kestrel", long);
  await page.getByRole("button", { name: `Options for ${long}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Thread settings…" }).click();
  const settings = page.getByRole("dialog", { name: /Thread settings/ });
  await settings.getByLabel("Lock the label, purpose and pins").check();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings).toBeHidden();
  await page.getByLabel("Message", { exact: true }).fill("words not sent yet");
  await createThread(page, "kestrel", "quiet");
  const other = await page.context().newPage();
  await other.addInitScript("document.hasFocus = () => false");
  await other.goto(`/workspace/kestrel/${long}`);
  await send(other, "written from another tab");
  await other.close();
  const row = page.locator(".sidebar-threads .thread-row", { has: page.getByText(long, { exact: true }) });
  await expect(row.locator(".sidebar-unread [aria-hidden]")).toHaveText("1");
  await expect(row.locator(".sidebar-time")).toHaveText("now");
  await expectRowLaidOut(row, "default text");
  const names = page.locator(".sidebar-threads > .thread-row .sidebar-name");
  const [home, quiet] = await Promise.all([edgesOf(names.filter({ hasText: "main" })), edgesOf(names.filter({ hasText: "quiet" }))]);
  expect(quiet.left, "a row with no icon keeps its name in line with home's").toBe(home.left);

  await page.getByRole("button", { name: "kestrel", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "New folder…" }).click();
  const newFolder = page.getByRole("dialog", { name: "New folder" });
  await newFolder.getByLabel("Name").fill("Shelf");
  await newFolder.getByRole("button", { name: "Create", exact: true }).click();
  await expect(newFolder).toBeHidden();
  const folder = page.getByRole("group", { name: "Folder Shelf" });
  await row.dragTo(folder.getByRole("button", { name: "Shelf", exact: true }));
  await expect(folder.getByText(long, { exact: true })).toBeVisible();
  await folder.getByRole("button", { name: "Shelf", exact: true }).click();
  const shelf = folder.locator(".folder-row");
  await expect(shelf.locator(".sidebar-unread [aria-hidden]")).toHaveText("1");
  await shelf.hover();
  const [count, options] = await Promise.all([edgesOf(shelf.locator(".sidebar-unread")), edgesOf(shelf.locator(".thread-more"))]);
  expect(count.right, "a shut folder's options button leaves its count showing").toBeLessThanOrEqual(options.left);
  await folder.getByRole("button", { name: /^Shelf/ }).click();
  await expect(row).toBeVisible();

  await page.evaluate("localStorage.setItem('shore.font-size', 'larger')");
  await page.reload();
  await expect(row.locator(".sidebar-unread [aria-hidden]")).toHaveText("1");
  await expectRowLaidOut(row, "largest text");

  await page.setViewportSize({ width: 280, height: 653 });
  await page.getByRole("button", { name: /^Open sidebar/ }).click();
  await expect.poll(async () => (await edgesOf(page.locator("aside.sidebar"))).left, "the drawer has slid in").toBe(0);
  await expectRowLaidOut(row, "narrowest phone");
  await finish();
});

test.describe("on a touch screen", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 1000, height: 700 } });

  test("each row shows its options button after its time without a hover", async ({ page }) => {
    const finish = await watchPage(page);
    await signIn(page);
    await createCharacter(page, "plover");
    const row = page.locator(".sidebar-threads .thread-row", { has: page.getByText("main", { exact: true }) });
    const more = row.locator(".thread-more");
    await expect(more).toBeVisible();
    const [time, options, around] = await Promise.all([edgesOf(row.locator(".sidebar-time")), edgesOf(more), edgesOf(row)]);
    expect(time.right).toBeLessThanOrEqual(options.left);
    expect(options.right).toBeLessThanOrEqual(around.right);
    expect(await more.evaluate((button: { ownerDocument: { defaultView: { getComputedStyle: (part: unknown) => { opacity: string } } | null } }) => button.ownerDocument.defaultView?.getComputedStyle(button).opacity)).toBe("1");
    await finish();
  });
});

interface Lined { getBoundingClientRect: () => { height: number }; ownerDocument: { defaultView: { getComputedStyle: (part: Lined) => { lineHeight: string } } | null; createRange: () => { selectNodeContents: (part: Lined) => void; getBoundingClientRect: () => { left: number } } } }

test("the line on how near the thread is to compaction sits just above the message box, on one line inside its width, with its text in line with the box's, at the largest text and on the narrowest phone", async ({ page }) => {
  const finish = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "petrel");
  await send(page, "hello there");
  const line = page.locator(".context-use");
  await expect(line).toContainText("Next compaction:");
  const measure = async (where: string) => {
    const [around, words, box, text] = await Promise.all([edgesOf(line), line.evaluate((part: Lined) => {
      const style = part.ownerDocument.defaultView?.getComputedStyle(part);
      const range = part.ownerDocument.createRange();
      range.selectNodeContents(part);
      return { height: part.getBoundingClientRect().height, lineHeight: Number.parseFloat(style?.lineHeight ?? "0"), textLeft: range.getBoundingClientRect().left };
    }), edgesOf(page.locator(".composer")), edgesOf(page.getByLabel("Message", { exact: true }))]);
    expect(around.left, `${where}: inside the box's width on the left`).toBeGreaterThanOrEqual(box.left - 0.5);
    expect(around.right, `${where}: inside the box's width on the right`).toBeLessThanOrEqual(box.right + 0.5);
    expect(box.top - around.bottom, `${where}: just above the box`).toBeGreaterThanOrEqual(0);
    expect(box.top - around.bottom, `${where}: just above the box`).toBeLessThanOrEqual(4);
    expect(words.height, `${where}: one line`).toBeLessThanOrEqual(words.lineHeight * 1.5);
    expect(Math.abs(words.textLeft - text.left), `${where}: its text starts where the box's does`).toBeLessThanOrEqual(2);
  };
  await measure("default text");
  await page.evaluate("localStorage.setItem('shore.font-size', 'larger')");
  await page.reload();
  await expect(line).toContainText("Next compaction:");
  await measure("largest text");
  await page.setViewportSize({ width: 280, height: 653 });
  await expect(page.locator(".shell")).toHaveAttribute("data-layout", "mobile");
  await measure("narrowest phone");
  await finish();
});

test("a dialog's text boxes are as many lines tall as their rows, at the default and the largest text size", async ({ page }) => {
  const finish = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "tern");
  await createThread(page, "tern", "notes");
  for (const size of ["default", "larger"]) {
    if (size === "larger") {
      await page.evaluate("localStorage.setItem('shore.font-size', 'larger')");
      await page.reload();
      await expect(page.locator(".topbar-thread")).toHaveText("notes");
    }
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    const fresh = page.getByRole("dialog", { name: "New thread with tern" });
    await expect(fresh).toBeVisible();
    await expectTextBoxesAsTallAsTheirRows(page, `New thread at the ${size} size`);
    await page.keyboard.press("Escape");
    await expect(fresh).toBeHidden();
    await page.getByRole("button", { name: "Options for notes", exact: true }).click();
    await page.getByRole("menuitem", { name: "Thread settings…" }).click();
    await expect(page.getByRole("dialog", { name: /Thread settings/ })).toBeVisible();
    await expectTextBoxesAsTallAsTheirRows(page, `Thread settings at the ${size} size`);
    await page.keyboard.press("Escape");
  }
  await finish();
});
