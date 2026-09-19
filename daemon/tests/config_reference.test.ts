import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigTable } from "../src/config/loader.ts";
import { resolveShoreDirs } from "../src/config/dirs.ts";
import { CONFIG_EXAMPLES, renderConfigReference } from "../src/config/reference.ts";

test("the generated configuration reference matches the public schema", () => {
  expect(readFileSync(join(import.meta.dir, "../../docs/CONFIG_REFERENCE.md"), "utf8")).toBe(renderConfigReference());
});

for (const example of CONFIG_EXAMPLES) test(`generated example: ${example.title}`, () => {
  const loaded = parseConfigTable(Bun.TOML.parse(example.text) as Record<string, unknown>, resolveShoreDirs({}), () => {});
  expect(loaded.deprecations).toEqual([]);
});
