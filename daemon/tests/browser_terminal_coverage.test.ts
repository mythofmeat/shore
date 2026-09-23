import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import terminal from "../../docs/capabilities/terminal.generated.json" with { type: "json" };
import { assertTerminalCoverage, terminalBrowserHooks } from "../scripts/browser_terminal_coverage.ts";
import { commandCatalogue } from "../src/commands/registry.ts";
import { requestCatalogue } from "../src/operations/requests.ts";

const directory = new URL("../src/browser/", import.meta.url);
const files = (await readdir(directory)).filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts") && !file.includes("generated"));
const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(new URL(file, directory), "utf8")] as const)));
const hooks = await terminalBrowserHooks(sources);
const catalogue = [...commandCatalogue(), ...requestCatalogue()];

test("every terminal command, option and finite choice reaches canonical controls or an implemented browser adapter", () => {
  expect(() => assertTerminalCoverage(catalogue, hooks)).not.toThrow();
});

test("new terminal commands, options and choices cannot hide behind a generated inventory", () => {
  const first = terminal.commands[0];
  const option = first?.arguments[0];
  if (first === undefined || option === undefined) throw new Error("Missing terminal fixture");
  expect(() => assertTerminalCoverage(catalogue, hooks, { ...terminal, commands: [...terminal.commands, { ...first, path: "shore unsupported" }] })).toThrow("Unmapped terminal command");
  expect(() => assertTerminalCoverage(catalogue, hooks, { ...terminal, commands: [{ ...first, arguments: [...first.arguments, { ...option, id: "unsupported" }] }] })).toThrow("Unmapped terminal field");
  const command = terminal.commands.find((item) => item.path === "shore log");
  if (command === undefined) throw new Error("Missing log command");
  expect(() => assertTerminalCoverage(catalogue, hooks, { ...terminal, commands: [{ ...command, arguments: command.arguments.map((item) => item.id === "role" ? { ...item, choices: [...item.choices, "new-role"] } : item) }] })).toThrow("Unmapped terminal choices");
});

test("omitted operations and controls fail the terminal parity gate", () => {
  expect(() => assertTerminalCoverage(catalogue.filter((item) => item.name !== "fork_thread"), hooks)).toThrow("Missing terminal operation");
  const withoutTurns = catalogue.map((item) => item.name !== "fork_thread" ? item : {
    ...item, fields: Object.fromEntries(Object.entries(item.fields).filter(([key]) => key !== "turns")),
  });
  expect(() => assertTerminalCoverage(withoutTurns, hooks)).toThrow("Unaccounted GUI fields");
});

test("removing result visibility or a local adapter fails even when the command remains registered", async () => {
  const app = sources["app.tsx"];
  const settings = sources["settings.tsx"];
  if (app === undefined || settings === undefined) throw new Error("Missing browser source");
  const withoutResult = await terminalBrowserHooks({ ...sources, "app.tsx": app.replace('<Inspect value={result} label="Complete action result" />', "") });
  expect(() => assertTerminalCoverage(catalogue, withoutResult)).toThrow("Missing generated action path: Inspect:value=result");
  const withoutDefaults = await terminalBrowserHooks({ ...sources, "settings.tsx": settings.replaceAll("view.defaults", "{}") });
  expect(() => assertTerminalCoverage(catalogue, withoutDefaults)).toThrow("Missing browser adapter: config_defaults");
});
