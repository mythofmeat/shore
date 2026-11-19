import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createCharacter, signIn, watchPage } from "./helpers.ts";

const TRIGGERS = `[evening]
at = "18:00"
reason = "Ask how the day went."

[mail]
every = "30m"
check = "true"
wake = false
`;

interface Box { x: number; y: number; width: number; height: number }
interface Leaf { textContent: string | null; parentElement: { clientWidth: number } | null }
interface Pen { font: string; measureText: (text: string) => { width: number } }
interface Squeezed { value: string; word: string; room: number; needs: number }
interface Section {
  querySelectorAll: (selector: string) => Iterable<Leaf>;
  ownerDocument: { createElement: (tag: "canvas") => { getContext: (kind: "2d") => Pen | null }; defaultView: { getComputedStyle: (element: Leaf) => { font: string } } | null };
}

function section(page: Page, label: string): Locator {
  return page.locator(".status-section").filter({ has: page.locator(".setting-label", { hasText: new RegExp(`^${label}$`) }) });
}

function row(part: Locator, label: string): Locator {
  return part.locator(".kv-row").filter({ has: part.page().locator(":scope > dt", { hasText: new RegExp(`^${label}$`) }) }).first();
}

async function box(part: Locator): Promise<Box> {
  const found = await part.boundingBox();
  if (found === null) throw new Error("a part of the status section is not on the page");
  return found;
}

async function cutWords(part: Locator): Promise<Squeezed[]> {
  return await part.evaluate((root: Section) => {
    const pen = root.ownerDocument.createElement("canvas").getContext("2d");
    const view = root.ownerDocument.defaultView;
    if (pen === null || view === null) throw new Error("nothing to measure words with");
    return [...root.querySelectorAll("dd > span")].flatMap((leaf) => {
      const value = leaf.textContent ?? "";
      pen.font = view.getComputedStyle(leaf).font;
      const widest = value.split(/\s+/).reduce((most, word) => {
        const needs = pen.measureText(word).width;
        return needs > most.needs ? { word, needs } : most;
      }, { word: "", needs: 0 });
      const room = leaf.parentElement?.clientWidth ?? 0;
      return widest.needs > room + 1 ? [{ value, word: widest.word, room, needs: Math.ceil(widest.needs) }] : [];
    });
  });
}

async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  const sidebar = page.getByRole("complementary", { name: "Characters and threads" });
  await (size.width > 700 ? expect(sidebar).toBeVisible() : expect(sidebar).toBeHidden());
  await expect(page.locator(".settings-nav-mobile")).toHaveCount(size.width > 700 ? 0 : 1);
}

test("at phone width the diagnostics page puts nested status values under their label and narrows the labels, so no value is too narrow for its longest word; a desktop keeps them beside it", async ({ page }) => {
  const finish = await watchPage(page);
  await signIn(page);
  await createCharacter(page, "ada");
  await page.evaluate("location.hash = '#settings/diagnostics'");
  const select = page.getByLabel("Status section");
  await select.selectOption("folders");
  const configDir = await row(section(page, "Folders"), "Config dir").locator(":scope > dd").textContent();
  if (configDir === null) throw new Error("the folders section shows no config dir");
  await writeFile(join(configDir, "characters/ada/workspace/TRIGGERS.toml"), TRIGGERS);
  await page.locator(".settings-section").filter({ has: page.getByRole("heading", { name: "Status", exact: true }) }).getByRole("button", { name: "Refresh", exact: true }).click();
  await select.selectOption("triggers");
  const triggers = section(page, "Triggers");
  await expect(triggers).toContainText('every day at 18:00, wakes ada, "Ask how the day went."');

  await resize(page, { width: 390, height: 844 });
  expect(await cutWords(triggers)).toEqual([]);
  expect((await box(row(triggers, "Does").locator(":scope > dt"))).width).toBeLessThan(120);
  await select.selectOption("mcp");
  await expect(section(page, "Mcp")).toContainText("tool_fixture");
  expect(await cutWords(section(page, "Mcp"))).toEqual([]);
  expect(await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")).toBe(0);
  await select.selectOption("conversation");
  const tokens = row(section(page, "Conversation"), "Tokens");
  const [label, value, counts] = [await box(tokens.locator(":scope > dt")), await box(tokens.locator(":scope > dd")), await box(tokens.locator(":scope > dd > .kv.tree"))];
  expect(value.y).toBeGreaterThanOrEqual(label.y + label.height);
  expect(counts.x).toBeGreaterThan(label.x);
  expect(counts.x).toBeLessThan(label.x + label.width);

  await resize(page, { width: 1440, height: 1000 });
  const [wideLabel, wideValue] = [await box(tokens.locator(":scope > dt")), await box(tokens.locator(":scope > dd"))];
  expect(wideValue.x).toBeGreaterThan(wideLabel.x + wideLabel.width);
  expect(Math.abs(wideValue.y - wideLabel.y)).toBeLessThan(2);
  await finish();
});
