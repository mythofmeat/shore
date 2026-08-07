/**
 * `SHORE_WORKSPACE_DIR`: a character's workspace, moved out of its config
 * directory.
 *
 * Not fixture-driven, unlike `dirs_parity.test.ts` — the frozen fixture pins
 * the layout as it was, and this is the layout that did not exist when it was
 * generated. What that test still guarantees is the half that matters here:
 * with no root set, every path helper answers exactly what it answered before,
 * because the new parameter is trailing and optional. So these cases are all
 * about the *other* branch, plus the seams where "a character exists" stops
 * meaning "a directory under `characters/` exists".
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  characterMemoryDir,
  characterWorkspaceDir,
  characterWorkspaceFile,
  discoverCharacters,
  loadCharacterDefinition,
  resolveShoreDirs,
  resolveUserDefinition,
  workspaceRoot,
} from "../src/config/dirs.ts";
import { workspacePathTriggersReload } from "../src/daemon/hot_reload.ts";
import {
  changedPromptFiles,
  ensureCharacterWorkspace,
  loadMemoryIndex,
  memoryIndexPath,
} from "../src/memory/deferred_edits.ts";
import { characterInfo, listCharacters, switchCharacter } from "../src/commands/navigation.ts";

const roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "workspace-dir-"));
  roots.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("resolveShoreDirs", () => {
  test("SHORE_WORKSPACE_DIR is used as-is, with no /shore suffix", () => {
    const dirs = resolveShoreDirs({ HOME: "/home/x", SHORE_WORKSPACE_DIR: "/srv/ws" });
    expect(dirs.workspace).toBe("/srv/ws");
    // The other four are untouched by it.
    expect(dirs.config).toBe("/home/x/.config/shore");
  });

  test("unset means the default layout, not a directory", () => {
    expect(resolveShoreDirs({ HOME: "/home/x" }).workspace).toBeUndefined();
  });

  test("an empty value is unset, unlike the other four overrides", () => {
    // `SHORE_CONFIG_DIR=""` resolves to the empty string, because there is no
    // other answer to give. Here there is: the default layout.
    expect(resolveShoreDirs({ HOME: "/home/x", SHORE_WORKSPACE_DIR: "" }).workspace)
      .toBeUndefined();
    expect(resolveShoreDirs({ HOME: "/home/x", SHORE_CONFIG_DIR: "" }).config).toBe("");
  });

  test("workspaceRoot answers the same question on its own", () => {
    expect(workspaceRoot({ SHORE_WORKSPACE_DIR: "/srv/ws" })).toBe("/srv/ws");
    expect(workspaceRoot({ SHORE_WORKSPACE_DIR: "" })).toBeUndefined();
    expect(workspaceRoot({})).toBeUndefined();
  });
});

describe("path helpers", () => {
  test("a root replaces the whole `characters/<n>/workspace` segment", () => {
    expect(characterWorkspaceDir("/cfg", "ada", "/srv/ws")).toBe("/srv/ws/ada");
    expect(characterWorkspaceFile("/cfg", "ada", "SOUL.md", "/srv/ws")).toBe(
      "/srv/ws/ada/SOUL.md",
    );
    expect(characterMemoryDir("/cfg", "ada", "/srv/ws")).toBe("/srv/ws/ada/memory");
    expect(memoryIndexPath("/cfg", "ada", "/srv/ws")).toBe("/srv/ws/ada/MEMORY.md");
  });

  test("without a root every helper is exactly what it was", () => {
    expect(characterWorkspaceDir("/cfg", "ada")).toBe("/cfg/characters/ada/workspace");
    expect(characterWorkspaceDir("/cfg", "ada", undefined)).toBe(
      "/cfg/characters/ada/workspace",
    );
    expect(characterMemoryDir("/cfg", "ada")).toBe("/cfg/characters/ada/workspace/memory");
  });

  test("the config directory is still the config directory", () => {
    // Only the workspace moves. Per-character `config.toml` and `prompts/`
    // stay where they were, which is the whole point of separating the two.
    const dirs = resolveShoreDirs({ SHORE_CONFIG_DIR: "/cfg", SHORE_WORKSPACE_DIR: "/srv/ws" });
    expect(dirs.config).toBe("/cfg");
  });
});

describe("discoverCharacters", () => {
  test("a character is one with SOUL.md under the root", () => {
    const config = scratch();
    const ws = scratch();
    write(ws, "ada/SOUL.md", "You are ada.\n");
    write(ws, "bob/SOUL.md", "You are bob.\n");
    mkdirSync(join(ws, "notacharacter"), { recursive: true });

    expect(discoverCharacters(config, ws)).toEqual(["ada", "bob"]);
  });

  test("the config tree's own workspace/SOUL.md stops counting", () => {
    // Otherwise a stale copy left behind by the default layout would announce
    // a character whose definition nothing goes on to read — the daemon would
    // look under the root, find nothing, and run it with an empty prompt.
    const config = scratch();
    const ws = scratch();
    write(config, "characters/stale/workspace/SOUL.md", "left behind\n");

    expect(discoverCharacters(config, ws)).toEqual([]);
    expect(discoverCharacters(config)).toEqual(["stale"]);
  });

  test("the legacy character.md still counts, root or no root", () => {
    // `loadCharacterDefinition` still falls back to it either way, so a
    // character that has never been migrated is still discovered.
    const config = scratch();
    const ws = scratch();
    write(config, "characters/old/character.md", "You are old.\n");

    expect(discoverCharacters(config, ws)).toEqual(["old"]);
  });

  test("both trees are merged, and the answer is deduplicated and sorted", () => {
    const config = scratch();
    const ws = scratch();
    write(config, "characters/zed/character.md", "You are zed.\n");
    write(ws, "zed/SOUL.md", "You are zed.\n");
    write(ws, "ada/SOUL.md", "You are ada.\n");

    expect(discoverCharacters(config, ws)).toEqual(["ada", "zed"]);
  });

  test("a missing root is not an error", () => {
    const config = scratch();
    expect(discoverCharacters(config, join(config, "nope"))).toEqual([]);
  });
});

describe("definition loading", () => {
  test("SOUL.md and USER.md are read from the root", () => {
    const config = scratch();
    const ws = scratch();
    write(ws, "ada/SOUL.md", "soul from the root\n");
    write(ws, "ada/USER.md", "user from the root\n");
    // Same names in the old place, to prove which one wins.
    write(config, "characters/ada/workspace/SOUL.md", "soul from the config tree\n");
    write(config, "characters/ada/workspace/USER.md", "user from the config tree\n");

    expect(loadCharacterDefinition(config, "ada", ws)).toBe("soul from the root\n");
    expect(resolveUserDefinition(config, "ada", ws)).toBe("user from the root\n");
    expect(loadCharacterDefinition(config, "ada")).toBe("soul from the config tree\n");
  });

  test("the legacy fallback still reads from the config tree", () => {
    const config = scratch();
    const ws = scratch();
    write(config, "characters/old/character.md", "legacy soul\n");
    write(config, "characters/old/user.md", "legacy user\n");

    expect(loadCharacterDefinition(config, "old", ws)).toBe("legacy soul\n");
    expect(resolveUserDefinition(config, "old", ws)).toBe("legacy user\n");
  });
});

describe("workspace preparation", () => {
  test("ensureCharacterWorkspace builds the layout under the root", async () => {
    const config = scratch();
    const ws = scratch();
    const data = scratch();

    await ensureCharacterWorkspace(join(data, "ada"), config, "ada", ws);

    expect(readFileSync(join(ws, "ada", "TOOLS.md"), "utf8")).toContain("Read files before");
    // The memory directory follows the workspace, not the config tree.
    expect(discoverCharacters(config, ws)).toEqual([]);
    expect(() => readFileSync(join(config, "characters/ada/workspace/TOOLS.md"))).toThrow();
  });

  test("the legacy migration still reads out of the config tree", async () => {
    // The files being migrated *from* never moved — they are what the old
    // layout left behind — so a migration has to cross the two trees.
    const config = scratch();
    const ws = scratch();
    const data = scratch();
    write(config, "characters/ada/character.md", "legacy soul\n");
    write(config, "characters/ada/user.md", "legacy user\n");
    write(config, "characters/ada/prompts/system.md", "legacy agents\n");

    await ensureCharacterWorkspace(join(data, "ada"), config, "ada", ws);

    expect(readFileSync(join(ws, "ada", "SOUL.md"), "utf8")).toBe("legacy soul\n");
    expect(readFileSync(join(ws, "ada", "USER.md"), "utf8")).toBe("legacy user\n");
    expect(readFileSync(join(ws, "ada", "AGENTS.md"), "utf8")).toBe("legacy agents\n");
  });

  test("the memory index and the pending-edit diff follow the root", async () => {
    const config = scratch();
    const ws = scratch();
    const data = scratch();
    write(ws, "ada/MEMORY.md", "the index under the root\n");
    write(config, "characters/ada/workspace/MEMORY.md", "the index under the config tree\n");

    expect(await loadMemoryIndex(join(data, "ada"), config, "ada", ws)).toBe(
      "the index under the root\n",
    );
    expect(await changedPromptFiles(join(data, "ada"), config, "ada", ws)).toContain(
      "MEMORY.md",
    );
  });
});

describe("the commands that answer for a character", () => {
  test("listing finds a character that has no config directory at all", () => {
    const config = scratch();
    const ws = scratch();
    write(ws, "ada/SOUL.md", "You are ada.\n");

    expect(listCharacters(config, undefined, ws).characters).toEqual([{ name: "ada" }]);
  });

  test("character_info reports the workspace under the root", async () => {
    const config = scratch();
    const ws = scratch();
    const data = scratch();
    write(ws, "ada/SOUL.md", "You are ada.\n");
    write(ws, "ada/USER.md", "About you.\n");

    const info = (await characterInfo(
      { configDir: config, dataDir: data, active: "other", workspaceRoot: ws },
      { name: "ada" },
    )) as Record<string, unknown>;

    expect(info.workspace_dir).toBe(join(ws, "ada"));
    expect(info.has_definition).toBe(true);
    expect(info.bootstrap_files).toEqual(["SOUL.md", "USER.md"]);
    // The config directory is still reported, and still where it always was —
    // it is where `config.toml` goes, whether or not anything is there yet.
    expect(info.config_dir).toBe(join(config, "characters", "ada"));
  });

  test("switching accepts a character that exists only in the root", () => {
    const config = scratch();
    const ws = scratch();
    write(ws, "ada/SOUL.md", "You are ada.\n");

    expect(switchCharacter(config, "other", { name: "ada" }, ws)).toEqual({
      character: "ada",
      changed: true,
    });
    expect(() => switchCharacter(config, "other", { name: "nobody" }, ws)).toThrow(
      "Character not found",
    );
  });
});

describe("the workspace watcher", () => {
  const unknown = () => false;
  const known = () => true;

  test("a new character's SOUL.md is the one thing that reloads", () => {
    expect(workspacePathTriggersReload("/srv/ws", "/srv/ws/ada/SOUL.md", unknown)).toBe(true);
  });

  test("a known character editing its own SOUL.md does not", () => {
    // The rule the module exists to protect: a save is not a prompt
    // activation boundary, so it must not invalidate the cached prefix.
    expect(workspacePathTriggersReload("/srv/ws", "/srv/ws/ada/SOUL.md", known)).toBe(false);
  });

  test("memory writes and everything deeper are ignored", () => {
    expect(workspacePathTriggersReload("/srv/ws", "/srv/ws/ada/MEMORY.md", unknown)).toBe(false);
    expect(workspacePathTriggersReload("/srv/ws", "/srv/ws/ada/memory/2026-08-07.md", unknown))
      .toBe(false);
    expect(workspacePathTriggersReload("/srv/ws", "/srv/ws/ada", unknown)).toBe(false);
    expect(workspacePathTriggersReload("/srv/ws", "/srv/ws/ada/config.toml", unknown)).toBe(
      false,
    );
  });

  test("a path outside the root, and a caller with no predicate, never trigger", () => {
    expect(workspacePathTriggersReload("/srv/ws", "/etc/passwd", unknown)).toBe(false);
    expect(workspacePathTriggersReload("/srv/ws", "/srv/ws/ada/SOUL.md", undefined)).toBe(false);
  });
});
