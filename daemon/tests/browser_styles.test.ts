import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { browserStyles, FONT_FACES } from "../scripts/build_browser.ts";

const BROWSER = join(import.meta.dir, "../src/browser");
const STYLES = join(BROWSER, "styles");
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black)\b(?![-\w])/;

async function files(root: string, pattern: string): Promise<{ path: string; text: string }[]> {
  return await Promise.all([...new Glob(pattern).scanSync(root)].sort().map(async (path) => ({ path, text: await readFile(join(root, path), "utf8") })));
}

function declarations(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? ""));
}

function rawColors(css: string): string[] {
  return css.split("\n").flatMap((line, index) => {
    const value = line.includes(":") ? line.slice(line.indexOf(":") + 1) : "";
    return RAW_COLOR.test(value) ? [`${String(index + 1)}: ${line.trim()}`] : [];
  });
}

test("component styles and markup use theme tokens, never raw colors", async () => {
  const styles = (await files(STYLES, "**/*.css")).filter((file) => file.path !== "tokens.css" && !file.path.startsWith("themes/"));
  expect(styles.length).toBeGreaterThan(3);
  const offenders = styles.flatMap((file) => rawColors(file.text).map((line) => `${file.path}:${line}`));
  expect(offenders).toEqual([]);
  const markup = await files(BROWSER, "**/*.tsx");
  expect(markup.flatMap((file) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(file.text) ? [relative(BROWSER, join(BROWSER, file.path))] : [])).toEqual([]);
  expect(rawColors(".a { color: #fff; }\n.b { background: rgba(0, 0, 0, 0.4); }\n.c { border-color: white; }")).toHaveLength(3);
  expect(rawColors("html, body, #root { height: 100%; }\n.x { color: var(--text); }\n.y { border-left: 2px solid var(--line-3); }")).toEqual([]);
});

test("every token a stylesheet reads is defined, and themes only override known tokens", async () => {
  const tokens = await readFile(join(STYLES, "tokens.css"), "utf8");
  const themes = await files(join(STYLES, "themes"), "*.css");
  const base = themes.find((file) => file.path === "default.css");
  if (base === undefined) throw new Error("Missing default theme");
  const defined = new Set([...declarations(tokens), ...declarations(base.text)]);
  const all = await files(STYLES, "**/*.css");
  const used = new Set(all.flatMap((file) => [...file.text.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1] ?? "")));
  expect([...used].filter((token) => !defined.has(token))).toEqual([]);
  for (const theme of themes) {
    const extra = [...declarations(theme.text)].filter((token) => !defined.has(token));
    expect({ theme: theme.path, extra }).toEqual({ theme: theme.path, extra: [] });
  }
  expect(themes.map((file) => file.path)).toContain("fog.css");
});

test("the built stylesheet includes every style file once, in token, base, component, theme order", async () => {
  const css = await browserStyles();
  const order = [...css.matchAll(/\/\* ([\w/.-]+) \*\//g)].map((match) => match[1]);
  expect(order[0]).toBe("tokens.css");
  expect(order[1]).toBe("base.css");
  const themeStart = order.findIndex((name) => name?.startsWith("themes/"));
  expect(order.slice(2, themeStart).every((name) => name?.startsWith("components/"))).toBe(true);
  expect(order.slice(themeStart).every((name) => name?.startsWith("themes/"))).toBe(true);
  expect(new Set(order).size).toBe(order.length);
  for (const face of FONT_FACES) expect((await readFile(join(BROWSER, "fonts", face.file))).byteLength).toBeGreaterThan(1000);
});
