import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { CommandError } from "../src/commands/errors.ts";
import { createCharacter } from "../src/commands/navigation.ts";
import { SOUL_FILE, USER_FILE } from "../src/config/dirs.ts";
import { testTmp } from "./support/tmp.ts";

const tempRoot = () => mkdtemp(testTmp("shore-create-char-"));

describe("where the scaffold lands", () => {

  test("a name that would climb out of the characters dir is refused", async () => {
    const config = await tempRoot();
    for (const name of ["../elsewhere", "a/b", "..", ""]) {
      expect(() => createCharacter(config, { name })).toThrow(CommandError);
    }
    expect(await readdir(config)).toEqual([]);
  });
});

describe("refusing to scaffold over someone", () => {
  test("an existing workspace character is not overwritten", async () => {
    const config = await tempRoot();
    createCharacter(config, { name: "ada" });

    expect(() => createCharacter(config, { name: "ada" })).toThrow(/already exists/);
  });

  test("a half-built character keeps the files it already has", async () => {
    const config = await tempRoot();
    const workspace = join(config, "characters", "ada", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, USER_FILE), "Call me Victor.\n");

    const out = createCharacter(config, { name: "ada" });

    expect(out.created_files).not.toContain(USER_FILE);
    expect(await readFile(join(workspace, USER_FILE), "utf8")).toBe("Call me Victor.\n");
    expect(await readFile(join(workspace, SOUL_FILE), "utf8")).toBe("You are ada.\n");
  });
});
