import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CommandError } from "../src/commands/errors.ts";
import { characterInfo, switchCharacter } from "../src/commands/navigation.ts";
import { queueDeferredEdit } from "../src/memory/deferred_edits.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

async function place(): Promise<{ config: string; data: string; workspaces: string }> {
  const root = await mkdtemp(testTmp("shore-navigation-"));
  const config = join(root, "config");
  const data = join(root, "data");
  await mkdir(join(config, "characters", "ada"), { recursive: true });
  await mkdir(join(config, "characters", "bo"), { recursive: true });
  await writeFile(join(config, "characters", "bo", "config.toml"), "");
  await mkdir(data, { recursive: true });
  initializeDatabase(data);
  return { config, data, workspaces: join(root, "workspaces") };
}

describe("character info", () => {
  test("describes the named character, or the active one when none is named, with the listed prompt files its workspace has", async () => {
    const { config, data, workspaces } = await place();
    await mkdir(join(workspaces, "bo", "notes"), { recursive: true });
    await writeFile(join(workspaces, "bo", "notes", "MAP.md"), "- places");
    await mkdir(join(data, "bo"), { recursive: true });
    await queueDeferredEdit(join(data, "bo"), "notes/MAP.md");
    const ctx = {
      configDir: config, dataDir: data, active: "ada",
      workspaceFor: (name: string) => new CharacterWorkspace(join(workspaces, name), undefined, ["SOUL.md", "notes/MAP.md"]),
    };

    expect(await characterInfo(ctx, { name: "bo" })).toEqual({
      name: "bo", active: false, config_dir: join(config, "characters", "bo"), workspace_dir: join(workspaces, "bo"),
      prompt_files: ["notes/MAP.md"], has_config_override: true, pending_deferred_edits: ["notes/MAP.md"],
      data_dir: join(data, "bo"), has_data: true,
    });
    for (const args of [{}, { name: "" }]) {
      expect(await characterInfo(ctx, args)).toEqual({
        name: "ada", active: true, config_dir: join(config, "characters", "ada"), workspace_dir: join(workspaces, "ada"),
        prompt_files: [], has_config_override: false, pending_deferred_edits: [], data_dir: join(data, "ada"), has_data: false,
      });
    }
  });

  test("refuses a name that isn't usable or a character, but describes the active one even without its folder", async () => {
    const { config, data, workspaces } = await place();
    const ctx = { configDir: config, dataDir: data, active: "cy", workspaceFor: (name: string) => new CharacterWorkspace(join(workspaces, name)) };
    expect(await outcomeOf(characterInfo(ctx, { name: "../ada" }))).toThrow("Not a usable character name: ../ada");
    expect(await outcomeOf(characterInfo(ctx, { name: "dee" }))).toThrow("Character not found: dee");
    expect((await characterInfo(ctx, {})).name).toBe("cy");
  });
});

describe("switching character", () => {
  test("to the active one changes nothing, to another one found changes it, and anything else is refused", async () => {
    const { config } = await place();
    expect(switchCharacter(config, "ada", { name: "ada" })).toEqual({ character: "ada", changed: false });
    expect(switchCharacter(config, "ada", { name: "bo" })).toEqual({ character: "bo", changed: true });
    expect(switchCharacter(config, undefined, { name: "bo" })).toEqual({ character: "bo", changed: true });
    expect(() => switchCharacter(config, "ada", {})).toThrow("Missing required argument: name");
    expect(() => switchCharacter(config, "..", { name: ".." })).toThrow("Not a usable character name: ..");
    expect(() => switchCharacter(config, "ada", { name: "dee" })).toThrow(CommandError);
    expect(() => switchCharacter(config, "ada", { name: "dee" })).toThrow("Character not found: dee");
  });
});
