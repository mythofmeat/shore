import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createCharacter, createThread, signIn, watchPage } from "./helpers.ts";

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
