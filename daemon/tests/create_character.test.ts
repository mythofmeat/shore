import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { CommandError } from "../src/commands/errors.ts";
import { createCharacter } from "../src/commands/navigation.ts";
import { discoverCharacters } from "../src/config/dirs.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const tempRoot = () => mkdtemp(testTmp("shore-create-char-"));

const workspaceUnder = (root: string) => (name: string) => new CharacterWorkspace(join(root, name));

describe("where a new character lands", () => {
  test("a name that would climb out of the characters dir is refused", async () => {
    const config = await tempRoot();
    for (const name of ["../elsewhere", "a/b", "..", ""]) {
      expect(await outcomeOf(createCharacter(config, { name }, workspaceUnder(join(config, "w"))))).toThrow(CommandError);
    }
    expect(await readdir(config)).toEqual([]);
  });

  test("its config folder and an empty workspace are made, and it is found as a character", async () => {
    const config = await tempRoot();
    const workspaces = join(config, "workspaces");

    const out = await createCharacter(config, { name: "ada" }, workspaceUnder(workspaces));

    expect(out).toEqual({ character: "ada", config_dir: join(config, "characters", "ada"), workspace_dir: join(workspaces, "ada") });
    expect((await stat(out.config_dir)).isDirectory()).toBe(true);
    expect(await readdir(out.workspace_dir)).toEqual([]);
    expect(discoverCharacters(config)).toEqual(["ada"]);
  });
});

describe("refusing to make a character over someone", () => {
  test("an existing character folder is not taken over", async () => {
    const config = await tempRoot();
    await mkdir(join(config, "characters", "ada"), { recursive: true });

    expect(await outcomeOf(createCharacter(config, { name: "ada" }, workspaceUnder(join(config, "w"))))).toThrow(/already exists/);
    expect(await readdir(config)).toEqual(["characters"]);
  });
});
