import type { Locator } from "@playwright/test";

import { expect, test } from "./fixtures.ts";
import { signIn, watchPage } from "./helpers.ts";

interface Styled { scrollWidth: number; clientWidth: number; ownerDocument: { defaultView: { getComputedStyle: (part: Styled) => { fontSize: string; color: string } } | null } }

async function laidOut(part: Locator) {
  const box = await part.boundingBox();
  if (box === null) throw new Error("not laid out");
  const look = await part.evaluate((node: Styled) => {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    return { hidden: node.scrollWidth - node.clientWidth, size: Number.parseFloat(style?.fontSize ?? ""), color: style?.color ?? "" };
  });
  return { ...box, ...look };
}

async function placed(part: Locator) {
  const box = await part.boundingBox();
  if (box === null) throw new Error("not laid out");
  return { top: box.y, bottom: box.y + box.height, middle: box.y + box.height / 2, height: box.height, width: box.width };
}

const level = (...parts: { middle: number }[]) => parts.every((part) => Math.abs(part.middle - (parts[0]?.middle ?? 0)) < 1);

test("a key typed into the Providers page is checked first, never shown again, and can be tested, pinned, unpinned and removed", async ({ page }) => {
  const check = await watchPage(page);
  await signIn(page);
  await page.evaluate("location.hash = '#settings/providers'");
  const card = page.locator(".provider", { has: page.locator(".setting-label", { hasText: /^fixture$/ }) });
  await card.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a key to fixture" });
  await dialog.getByLabel("Name").fill("spare");
  await dialog.getByLabel("API key").fill("a-key-the-fixture-turns-away");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("rejected: HTTP 401");

  await dialog.getByLabel("API key").fill("private-discovery-fixture-key");
  await dialog.getByRole("button", { name: "Add key", exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = card.locator("li.credential", { hasText: "spare" });
  await expect(row).toContainText("Works");
  await expect(row).toContainText("Saved on the daemon …-key");
  await expect(card.locator("li.credential").first()).toContainText("default");
  await expect(page.locator("body")).not.toContainText("private-discovery-fixture-key");
  await expect(card.locator("li.credential", { hasText: "default" })).toContainText("Not checked yet");
  await expect(card.locator("li.credential", { hasText: "default" })).toContainText("In use");

  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText("spare: 2 models")).toBeVisible();

  const head = card.locator(".provider-head");
  const [title, ready, more] = [await placed(head.locator(".provider-title")), await placed(head.getByText("Ready", { exact: true })), await placed(head.getByRole("button", { name: "Actions for fixture" }))];
  const [details, works, trial, actions] = [await placed(row.locator(".credential-main")), await placed(row.getByText("Works", { exact: true })), await placed(row.getByRole("button", { name: "Test", exact: true })), await placed(row.getByRole("button", { name: "Actions for spare" }))];
  expect([level(title, ready, more), ready.height < more.height, level(details, works, trial, actions), works.height < trial.height]).toEqual([true, true, true, true]);

  await row.getByRole("button", { name: "Actions for spare" }).click();
  await page.getByRole("menuitem", { name: "Use only this key" }).click();
  await expect(row).toContainText("Pinned");
  await row.getByRole("button", { name: "Actions for spare" }).click();
  const automatic = page.getByRole("menuitem", { name: "Pick keys automatically", exact: true });
  await expect(automatic).toHaveAccessibleDescription("First that works, in order");
  const [label, description] = [await laidOut(automatic.locator(".menu-label")), await laidOut(automatic.getByText("First that works, in order"))];
  expect([label.hidden, description.x === label.x, description.y >= label.y + label.height, description.size < label.size, description.color === label.color]).toEqual([0, true, true, true, false]);
  await automatic.click();
  await expect(row).not.toContainText("Pinned");

  await row.getByRole("button", { name: "Actions for spare" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByRole("dialog", { name: "Remove spare?" }).getByRole("button", { name: "Remove key", exact: true }).click();
  await expect(card.locator("li.credential", { hasText: "spare" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".settings-nav-mobile")).toBeVisible();
  const narrow = card.locator("li.credential", { hasText: "default" });
  const [line, info, buttons] = [await placed(narrow), await placed(narrow.locator(".credential-main")), await placed(narrow.locator(".actions-row"))];
  expect([info.width, buttons.top >= info.bottom]).toEqual([line.width, true]);
  await check();
});
