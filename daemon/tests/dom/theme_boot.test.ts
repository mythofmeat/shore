import { afterEach, expect, test } from "bun:test";

import { blockStorage, useDom } from "./dom.ts";

useDom();

const restores: (() => void)[] = [];
async function boot(tag: string): Promise<void> {
  await import(`../../src/browser/theme_boot.ts?${tag}`);
}

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-font-size");
});

test("the page starts in the stored theme and text size", async () => {
  const { THEME_STORAGE_KEY } = await import("../../src/browser/theme.ts");
  const { FONT_SIZE_STORAGE_KEY } = await import("../../src/browser/font_size.ts");
  localStorage.setItem(THEME_STORAGE_KEY, "fog");
  localStorage.setItem(FONT_SIZE_STORAGE_KEY, "large");
  await boot("stored");
  expect([document.documentElement.dataset["theme"], document.documentElement.dataset["fontSize"]]).toEqual(["fog", "large"]);
});

test("the page starts in the defaults when storage is blocked", async () => {
  const { DEFAULT_THEME } = await import("../../src/browser/theme.ts");
  const { DEFAULT_FONT_SIZE } = await import("../../src/browser/font_size.ts");
  restores.push(blockStorage());
  await boot("blocked");
  expect([document.documentElement.dataset["theme"], document.documentElement.dataset["fontSize"]]).toEqual([DEFAULT_THEME, DEFAULT_FONT_SIZE]);
});
