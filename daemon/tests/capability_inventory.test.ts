import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertInventoryCurrent,
  currentDaemonInventory,
  dispatchInventory,
  INVENTORY_PATH,
  parseInventorySources,
  protocolInventory,
} from "../scripts/capability_inventory.ts";

describe("capability inventory", () => {
  test("production daemon operations and every generated wire definition are accounted for", async () => {
    const expected = JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) as object;
    const current = await currentDaemonInventory();
    expect(() => assertInventoryCurrent(expected, current)).not.toThrow();
  });

  test("dispatch discovery reads both execution paths, including characterless archive operations", async () => {
    const [parsed] = await parseInventorySources([`
      function runCommand() {
        switch (cmd.name) {
          case "list_characters": return listCharacters();
          case "fork_thread": return forkThread();
        }
      }
      function runCharacterlessCommand() {
        switch (cmd.name) {
          case "list_characters": return listCharacters();
          case "import_character": return importCharacter();
        }
      }
      function unrelated() { switch (cmd.name) { case "not_an_operation": break; } }
    `]);
    if (parsed === undefined) throw new Error("Missing parsed fixture");
    const inventory = dispatchInventory(parsed);
    expect(inventory).toEqual({
      fork_thread: ["runCommand"],
      import_character: ["runCharacterlessCommand"],
      list_characters: ["runCommand", "runCharacterlessCommand"],
    });
  });

  test("removing a real production operation fails the inventory gate", async () => {
    const original = readFileSync(join(import.meta.dir, "../src/commands/dispatch.ts"), "utf8");
    const removed = original.replace('case "fork_thread":', "");
    expect(removed).not.toBe(original);
    const [before, after] = await parseInventorySources([original, removed]);
    if (before === undefined || after === undefined) throw new Error("Missing parsed dispatcher");
    expect(() => assertInventoryCurrent(dispatchInventory(before), dispatchInventory(after))).toThrow("capabilities changed");
  });

  test.each([
    ["option", "Regen.ts", "guidance?: string | null, "],
    ["result", "CharacterInfo.ts", "avatar?: CharacterAvatar | null, "],
    ["event", "ServerMessage.ts", '| { "type": "phase" } & Phase '],
  ])("removing a real wire %s fails the inventory gate", async (_kind, filename, fragment) => {
    const original = readFileSync(join(import.meta.dir, "../src/protocol", filename), "utf8");
    const removed = original.replace(fragment, "");
    expect(removed).not.toBe(original);
    const [before, after] = await parseInventorySources([original, removed]);
    if (before === undefined || after === undefined) throw new Error("Missing parsed protocol");
    expect(() => assertInventoryCurrent(protocolInventory([before]), protocolInventory([after]))).toThrow("capabilities changed");
  });

  test("wire inventory includes payload fields and all event discriminants", async () => {
    const inventory = protocolInventory(await parseInventorySources([`
      export type Phase = { rid?: string | null; phase: string };
      export type ServerMessage = { type: "phase" } & Phase | { type: "ping" };
    `]));
    expect(inventory["Phase"]).toContain("rid?: string | null");
    expect(inventory["ServerMessage"]).toContain('type: "phase"');
    expect(inventory["ServerMessage"]).toContain('type: "ping"');
  });
});
