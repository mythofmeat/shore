import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { CommandError } from "../src/commands/errors.ts";
import { createCharacter } from "../src/commands/navigation.ts";
import { builtinSystemPrompt } from "../src/engine/prompt.ts";
import { loadActivePromptFile } from "../src/memory/deferred_edits.ts";
import { AGENTS_FILE, SOUL_FILE, TOOLS_FILE, USER_FILE } from "../src/config/dirs.ts";
import { testTmp } from "./support/tmp.ts";

const tempRoot = () => mkdtemp(testTmp("shore-create-char-"));

describe("where the scaffold lands", () => {
  test("the default layout puts it under the config dir's characters/", async () => {
    const config = await tempRoot();

    const out = createCharacter(config, { name: "ada" });

    expect(out.workspace_dir).toBe(join(config, "characters", "ada", "workspace"));
    expect(out.config_dir).toBe(join(config, "characters", "ada"));
    expect(out.character).toBe("ada");
  });

  test("a workspace root takes it out of the config tree entirely", async () => {
    const config = await tempRoot();
    const workspace = await tempRoot();

    const out = createCharacter(config, { name: "ada" }, workspace);

    expect(out.workspace_dir).toBe(join(workspace, "ada"));
    expect(await readdir(config)).toEqual([]);
  });

  test("a name that would climb out of the characters dir is refused", async () => {
    const config = await tempRoot();
    for (const name of ["../elsewhere", "a/b", "..", ""]) {
      expect(() => createCharacter(config, { name })).toThrow(CommandError);
    }
    expect(await readdir(config)).toEqual([]);
  });

  test("a missing name is a request error, not a character called undefined", async () => {
    const config = await tempRoot();
    expect(() => createCharacter(config, {})).toThrow(CommandError);
  });
});

describe("what the scaffold contains", () => {
  test("all four prompt files are written, not just SOUL.md", async () => {
    const config = await tempRoot();

    const out = createCharacter(config, { name: "ada" });

    expect(out.created_files).toEqual([SOUL_FILE, USER_FILE, AGENTS_FILE, TOOLS_FILE]);
    for (const file of out.created_files) {
      expect(await readdir(out.workspace_dir)).toContain(file);
    }
  });

  test("SOUL.md names the character", async () => {
    const config = await tempRoot();
    const out = createCharacter(config, { name: "ada" });
    expect(await readFile(join(out.workspace_dir, SOUL_FILE), "utf8")).toBe("You are ada.\n");
  });

  test("AGENTS.md is a copy of the built-in system prompt, taken at scaffold time", async () => {
    const config = await tempRoot();
    const out = createCharacter(config, { name: "ada" });

    const written = await readFile(join(out.workspace_dir, AGENTS_FILE), "utf8");
    expect(written).toBe(builtinSystemPrompt());
    expect(written.length).toBeGreaterThan(0);
  });

  test("USER.md and TOOLS.md are empty, so an unedited scaffold adds nothing", async () => {
    const config = await tempRoot();
    const dataDir = await tempRoot();
    const out = createCharacter(config, { name: "ada" });

    for (const file of [USER_FILE, TOOLS_FILE]) {
      expect(await readFile(join(out.workspace_dir, file), "utf8")).toBe("");
      await writeFile(join(dataDir, file), "");
      expect(await loadActivePromptFile(dataDir, file)).toBeUndefined();
    }
  });
});

describe("refusing to scaffold over someone", () => {
  test("an existing workspace character is not overwritten", async () => {
    const config = await tempRoot();
    createCharacter(config, { name: "ada" });

    expect(() => createCharacter(config, { name: "ada" })).toThrow(/already exists/);
  });

  test("the legacy character.md layout counts as existing too", async () => {
    const config = await tempRoot();
    const charDir = join(config, "characters", "ada");
    await mkdir(charDir, { recursive: true });
    await writeFile(join(charDir, "character.md"), "You are ada.\n");

    expect(() => createCharacter(config, { name: "ada" })).toThrow(/already exists/);
  });

  test("a half-built character keeps the files it already has", async () => {
    const config = await tempRoot();
    const workspace = join(config, "characters", "ada", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, USER_FILE), "Call me Trevor.\n");

    const out = createCharacter(config, { name: "ada" });

    expect(out.created_files).not.toContain(USER_FILE);
    expect(await readFile(join(workspace, USER_FILE), "utf8")).toBe("Call me Trevor.\n");
    expect(await readFile(join(workspace, SOUL_FILE), "utf8")).toBe("You are ada.\n");
  });
});
