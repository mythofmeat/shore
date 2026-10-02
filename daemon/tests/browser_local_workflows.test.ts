import { expect, test } from "bun:test";
import { assertLocalWorkflowCoverage, assertQuickActions } from "../scripts/browser_local_coverage.ts";
import { TERMINAL_LOCAL_COMMANDS, TERMINAL_SHORTCUTS } from "../src/browser/preferences.generated.ts";
import { commandCatalogue } from "../src/commands/registry.ts";
import { requestCatalogue } from "../src/operations/requests.ts";

test("terminal local commands keep their fields and choices, and new ones fail until tracked", () => {
  expect(() => assertLocalWorkflowCoverage()).not.toThrow();
  expect(() => assertLocalWorkflowCoverage({ ...TERMINAL_LOCAL_COMMANDS, future: {} })).toThrow("Missing GUI local workflow: future");
  expect(() => assertLocalWorkflowCoverage({ ...TERMINAL_LOCAL_COMMANDS, scroll: { ...TERMINAL_LOCAL_COMMANDS.scroll, future: [] } })).toThrow("Missing GUI local fields: scroll");
  expect(() => assertLocalWorkflowCoverage({ ...TERMINAL_LOCAL_COMMANDS, palette: { scope: ["full", "shortcuts", "config", "future"] } })).toThrow("Missing GUI local choices: palette.scope");
});

test("conversation shortcuts resolve to the actual canonical catalogue", () => {
  const names = new Set([...commandCatalogue(), ...requestCatalogue()].map((operation) => operation.name));
  expect(() => assertQuickActions(names)).not.toThrow();
  for (const [name] of TERMINAL_SHORTCUTS) expect(() => assertQuickActions(new Set([...names].filter((item) => item !== name)))).toThrow(`Missing GUI conversation shortcut: ${name}`);
});
