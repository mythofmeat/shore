import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assertLocalWorkflowCoverage, assertQuickActions, localWorkflowReaders } from "../scripts/browser_local_coverage.ts";
import { TERMINAL_LOCAL_COMMANDS, TERMINAL_SHORTCUTS } from "../src/browser/preferences.generated.ts";
import { commandCatalogue } from "../src/commands/registry.ts";
import { requestCatalogue } from "../src/operations/requests.ts";
import { scrollAmount, validateBinding } from "../src/browser/keyboard.ts";

const files = ["app.tsx", "composer.tsx", "keyboard_controls.tsx", "action_output.tsx"];
test("terminal local commands and fields require live browser handlers and readers", async () => {
  const texts = await Promise.all(files.map((file) => readFile(new URL(`../src/browser/${file}`, import.meta.url), "utf8")));
  const readers = await localWorkflowReaders(texts);
  expect(() => assertLocalWorkflowCoverage(readers)).not.toThrow();
  for (const target of ["editor", "output", "focus_home", "focus_end", "transcript", "edit_cancel", "quick", "up"]) {
    const omitted = await localWorkflowReaders(texts.map((text) => text.replace(`${target}: () =>`, `omitted_${target}: () =>`).replace(`${target}: (args) =>`, `omitted_${target}: (args) =>`)));
    expect(() => assertLocalWorkflowCoverage(omitted)).toThrow("Missing GUI local handler");
  }
  const noAmount = await localWorkflowReaders(texts.map((text) => text.replaceAll('binding.args["amount"]', 'binding.args["omitted"]')));
  expect(() => assertLocalWorkflowCoverage(noAmount)).toThrow("Missing GUI local reader: scroll");
  expect(() => assertLocalWorkflowCoverage(readers, { ...TERMINAL_LOCAL_COMMANDS, future: {} })).toThrow("Missing GUI local workflow: future");
  expect(() => assertLocalWorkflowCoverage(readers, { ...TERMINAL_LOCAL_COMMANDS, scroll: { ...TERMINAL_LOCAL_COMMANDS.scroll, future: [] } })).toThrow("Missing GUI local fields: scroll");
  expect(() => assertLocalWorkflowCoverage(readers, { ...TERMINAL_LOCAL_COMMANDS, palette: { scope: ["full", "shortcuts", "config", "future"] } })).toThrow("Missing GUI local choices: palette.scope");
});

test("conversation shortcuts resolve to the actual canonical catalogue", () => {
  const names = new Set([...commandCatalogue(), ...requestCatalogue()].map((operation) => operation.name));
  expect(() => assertQuickActions(names)).not.toThrow();
  for (const [name] of TERMINAL_SHORTCUTS) expect(() => assertQuickActions(new Set([...names].filter((item) => item !== name)))).toThrow(`Missing GUI conversation shortcut: ${name}`);
});

test("line scrolling preserves terminal defaults and rejects unrepresentable amounts", () => {
  expect(scrollAmount({})).toBe(1);
  for (const amount of [0, 1, 10, 65535]) {
    expect(scrollAmount({ amount })).toBe(amount);
    expect(() => validateBinding({ key: "alt+j", scope: "global", target: "local:down", mode: "run", args: { amount } }, [], [])).not.toThrow();
  }
  for (const amount of [-1, 65536, 0.5, Number.NaN, Infinity, "10"]) {
    expect(() => scrollAmount({ amount })).toThrow("Scroll amount");
    expect(() => validateBinding({ key: "alt+k", scope: "global", target: "local:up", mode: "run", args: { amount } }, [], [])).toThrow("Scroll amount");
  }
});
