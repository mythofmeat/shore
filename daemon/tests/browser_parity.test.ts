import { expect, test } from "bun:test";
import terminal from "../../docs/capabilities/terminal.generated.json" with { type: "json" };
import { assertParity, NOT_APPLICABLE, parityUnits, readKnownGaps, TERMINAL_ROUTES, uncoveredUnits, type ParityUnit } from "../scripts/browser_parity.ts";
import { commandCatalogue } from "../src/commands/registry.ts";
import { requestCatalogue } from "../src/operations/requests.ts";
import { TERMINAL_LOCAL_COMMANDS } from "../src/browser/preferences.generated.ts";

const operations = commandCatalogue();
const requests = requestCatalogue();
const units = () => parityUnits({ operations, requests });

test("every terminal, view, local, request and renderer unit is surfaced in the browser or listed as a known gap", async () => {
  expect(() => assertParity(uncoveredUnits(units()), [])).toThrow("New browser parity gaps");
  const gaps = await readKnownGaps();
  expect(() => assertParity(uncoveredUnits(units()), gaps)).not.toThrow();
  expect([...gaps].sort()).toEqual(gaps);
});

test("known gaps only shrink: covered entries are stale and new uncovered units must be listed", () => {
  expect(() => assertParity(["cli:shore"], ["cli:shore", "cli:shore msg regen"])).toThrow("Stale known gaps are now covered; remove them");
  expect(() => assertParity(["cli:shore", "view:thinking"], ["cli:shore"])).toThrow("New browser parity gaps");
  expect(() => assertParity(["cli:shore"], ["cli:shore", "cli:shore"])).toThrow("Duplicate known gaps");
});

test("surfaces cover units at their triaged tier, never a less accessible one, and must name a real target", () => {
  const unit: ParityUnit = { id: "cli:shore msg regen", tier: "inline", targets: ["regen"] };
  expect(uncoveredUnits([unit], {})).toEqual(["cli:shore msg regen"]);
  expect(uncoveredUnits([unit], { regen: "inline" })).toEqual([]);
  expect(() => uncoveredUnits([unit], { regen: "settings" })).toThrow("Surface regen is settings, but cli:shore msg regen is triaged as inline");
  expect(uncoveredUnits([{ ...unit, tier: "advanced" }], { regen: "inline" })).toEqual([]);
  expect(() => uncoveredUnits([unit], { regen: "inline", regenerate: "inline" })).toThrow("Unknown browser surface: regenerate");
  const partial: ParityUnit = { id: "cli:shore msg alt.selector", tier: "inline", targets: ["alt.direction", "alt.position"] };
  expect(uncoveredUnits([partial], { "alt.direction": "inline" })).toEqual(["cli:shore msg alt.selector"]);
});

test("terminal-only targets are explained and never count as gaps", () => {
  for (const reason of Object.values(NOT_APPLICABLE)) expect(reason.length).toBeGreaterThan(20);
  expect(uncoveredUnits([{ id: "cli:shore completions.shell", tier: "advanced", targets: ["@shell_scripts"] }], {})).toEqual([]);
  expect(uncoveredUnits(units()).some((id) => id === "cli:shore.addr")).toBe(false);
});

test("new terminal commands, fields, choices and routes cannot bypass the parity gate", () => {
  const first = terminal.commands[0];
  const option = first?.arguments[0];
  if (first === undefined || option === undefined) throw new Error("Missing terminal fixture");
  expect(() => parityUnits({ operations, requests, inventory: { ...terminal, commands: [...terminal.commands, { ...first, path: "shore unsupported" }] } })).toThrow("Unmapped terminal command: shore unsupported");
  expect(() => parityUnits({ operations, requests, inventory: { ...terminal, commands: [{ ...first, arguments: [...first.arguments, { ...option, id: "unsupported" }] }, ...terminal.commands.slice(1)] } })).toThrow("Unmapped terminal field");
  const log = terminal.commands.find((item) => item.path === "shore log");
  if (log === undefined) throw new Error("Missing log command");
  const withRole = terminal.commands.map((item) => item !== log ? item : { ...item, arguments: item.arguments.map((field) => field.id === "role" ? { ...field, choices: [...field.choices, "new-role"] } : field) });
  expect(() => parityUnits({ operations, requests, inventory: { ...terminal, commands: withRole } })).toThrow("Unmapped terminal choices: shore log.role");
  expect(() => parityUnits({ operations, requests, routes: { ...TERMINAL_ROUTES, "shore removed": { tier: "inline", operations: [], fields: {}, tiers: {} } } })).toThrow("Stale terminal route: shore removed");
});

test("omitted operations, fields and request fields fail as API parity errors, independent of the UI", () => {
  expect(() => parityUnits({ operations: operations.filter((item) => item.name !== "fork_thread"), requests })).toThrow("Missing terminal operation: shore thread fork:fork_thread");
  const withoutTurns = operations.map((item) => item.name !== "fork_thread" ? item : { ...item, fields: Object.fromEntries(Object.entries(item.fields).filter(([key]) => key !== "turns")) });
  expect(() => parityUnits({ operations: withoutTurns, requests })).toThrow("Unaccounted GUI fields: fork_thread");
  expect(() => parityUnits({ operations, requests: requests.filter((item) => item.name !== "cancel") })).toThrow("Missing conversation request: cancel");
});

test("every terminal local command becomes a parity unit, so new ones are tracked", () => {
  const ids = new Set(units().map((unit) => unit.id));
  for (const command of Object.keys(TERMINAL_LOCAL_COMMANDS)) expect(ids.has(`local:${command}`)).toBe(true);
  const extended = parityUnits({ operations, requests, local: { ...TERMINAL_LOCAL_COMMANDS, future: {} } });
  expect(extended.some((unit) => unit.id === "local:future")).toBe(true);
});
