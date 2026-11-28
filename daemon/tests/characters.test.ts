import { writeDurable } from "../src/storage/files.ts";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharacterConfigError, CharacterRegistry, EngineCharacterNotFound } from "../src/characters.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { rejectionOf } from "./support/outcome.ts";
import { discoverCharacters } from "../src/config/dirs.ts";
import { CharacterWorkspace, characterWorkspace, workspaceTexts } from "../src/tools/character_workspace.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { readCharacterState, writeCharacterState } from "../src/storage/store.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "shore-characters-"));
}

function writeCharacter(configDir: string, name: string, soul: boolean): void {
  const dir = join(configDir, "characters", name);
  mkdirSync(join(dir, "workspace"), { recursive: true });
  writeFileSync(join(dir, "workspace", "SOUL.md"), `${name} ${soul ? "soul" : "legacy"}`);
}

function loadFrom(path: string): LoadedConfig {
  return loadConfig(path, { onWarn: () => {} });
}

test("concurrent first loads of one character resolve to the same engine", async () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "\n");
  writeCharacter(configDir, "Alice", true);
  mkdirSync(join(dataDir, "Alice", "threads", "main"), { recursive: true });

  const registry = await CharacterRegistry.create(
    configDir,
    dataDir,
    loadFrom(join(configDir, "config.toml")),
  );

  const engines = await Promise.all([
    registry.getOrCreate("Alice"),
    registry.getOrCreate("Alice"),
    registry.getOrCreate("Alice"),
  ]);

  expect(engines[1]).toBe(engines[0]);
  expect(engines[2]).toBe(engines[0]);
});

test("opening a character that isn't there, or a thread it doesn't have, is refused, and an opening that fails is tried again next time", async () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "\n");
  writeCharacter(configDir, "Alice", true);
  mkdirSync(join(dataDir, "Alice", "threads", "main"), { recursive: true });
  const registry = await CharacterRegistry.create(configDir, dataDir, loadFrom(join(configDir, "config.toml")));
  expect(await rejectionOf(registry.getOrCreate("Bob"))).toBeInstanceOf(EngineCharacterNotFound);
  expect(String(await rejectionOf(registry.getOrCreate("Alice", "nowhere")))).toBe('ThreadError: no thread "nowhere" for Alice');
  const broken = new Error("the disk hiccuped");
  const load = spyOn(ConversationEngine, "load").mockRejectedValueOnce(broken);
  try {
    expect(await rejectionOf(registry.getOrCreate("Alice"))).toBe(broken);
    expect(await registry.getOrCreate("Alice")).toBeInstanceOf(ConversationEngine);
  } finally {
    load.mockRestore();
  }
});

test("a workspace elsewhere keeps the character's tools and texts, and the same folder is the same workspace", () => {
  const root = makeRoot();
  writeFileSync(join(root, "mine.md"), "MINE\n");
  const workspace = new CharacterWorkspace(join(root, "workspace"), { user: undefined, passEnv: ["LANG"], noNewPrivs: true, checkLimitMs: 1000 }, [], { app: { texts: { output_cut: "mine.md" } }, dirs: { config: root } });
  expect(workspace.at(workspace.dir)).toBe(workspace);
  const elsewhere = workspace.at(join(root, "elsewhere"));
  expect([elsewhere.dir, elsewhere.tools, elsewhere.texts.render("output_cut")]).toEqual([join(root, "elsewhere"), workspace.tools, "MINE"]);
  expect(workspaceTexts(workspace).render("output_cut")).toBe("MINE");
  expect(workspaceTexts(join(root, "workspace")).render("output_cut")).toBe("[process output truncated]");
});

test("opening a character seals tool calls interrupted by a daemon restart", async () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "\n");
  writeCharacter(configDir, "Alice", true);
  mkdirSync(join(dataDir, "Alice", "threads", "main"), { recursive: true });
  writeDurable(join(dataDir, "Alice", "threads", "main", "active.jsonl"), [
      {
        msg_id: "u1",
        role: "user",
        content_blocks: [{ type: "text", text: "go" }],
        timestamp: "2026-08-28T00:00:00Z",
      },
      {
        msg_id: "a1",
        role: "assistant",
        content_blocks: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }],
        timestamp: "2026-08-28T00:01:00Z",
      },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n");

  const registry = await CharacterRegistry.create(
    configDir,
    dataDir,
    loadFrom(join(configDir, "config.toml")),
  );
  const engine = await registry.getOrCreate("Alice");
  expect(engine.messages()).toHaveLength(3);
  expect(engine.messages()[2]?.content_blocks).toEqual([{
    type: "tool_result",
    tool_use_id: "t1",
    content: "Tool execution was interrupted by a Shore daemon restart before it returned a result.",
    is_error: true,
  }]);
});

test("an invalid character overlay fails closed with the rejected field", async () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(join(configDir, "characters", "Alice", "workspace"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "[chat]\ndisplay_name = \"GLOBAL\"\n");
  writeFileSync(join(configDir, "characters", "Alice", "workspace", "SOUL.md"), "Alice");
  writeFileSync(
    join(configDir, "characters", "Alice", "config.toml"),
    '[triggers]\ninvalid_setting = true\n',
  );

  const registry = await CharacterRegistry.create(
    configDir,
    dataDir,
    loadFrom(join(configDir, "config.toml")),
  );

  expect(() => registry.effectiveConfig("Alice")).toThrow(CharacterConfigError);
  expect(() => registry.effectiveConfig("Alice")).toThrow(
    `${join(configDir, "characters", "Alice", "config.toml")}: unknown field \`triggers.invalid_setting\``,
  );
});

test("every folder in the config directory's characters folder is a character, whatever it holds, and nothing else is", () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  for (const dir of ["characters/ada", "characters/bo/workspace", "characters/.git", "workspace/cy"]) mkdirSync(join(configDir, dir), { recursive: true });
  writeFileSync(join(configDir, "characters", "notes.md"), "not a character");
  writeFileSync(join(configDir, "workspace", "cy", "SOUL.md"), "Cy");

  symlinkSync(join(root, "gone"), join(configDir, "characters", "dangling"));
  symlinkSync(join(configDir, "characters", "ada"), join(configDir, "characters", "ada-link"));
  expect(discoverCharacters(configDir)).toEqual(["ada", "ada-link", "bo"]);
  expect(discoverCharacters(join(root, "nowhere"))).toEqual([]);
});

test("with no characters, picking one says where a character's folder goes", async () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "\n");
  const registry = await CharacterRegistry.create(configDir, join(root, "data"), loadFrom(join(configDir, "config.toml")));

  expect(() => registry.resolveCharacter(undefined)).toThrow(
    `no characters available — create a folder for one at ${join(configDir, "characters", "<name>")}, or run: shore character new <name>`,
  );
});

test("a character's prompt files come from its own config, read once per loaded config unless asked for fresh", () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "characters", "ada"), { recursive: true });
  writeFileSync(join(configDir, "config.toml"), '[[prompt]]\nworkspace = "SOUL.md"\n');
  const overlay = join(configDir, "characters", "ada", "config.toml");
  writeFileSync(overlay, '[[prompt]]\nworkspace = "MAP.md"\n[[prompt]]\nworkspace = "MAP.md"\n[[prompt]]\nshore = "thread"\n');
  const config = loadFrom(join(configDir, "config.toml"));

  expect(characterWorkspace(config, "ada").promptFiles).toEqual(["MAP.md"]);
  expect(characterWorkspace(config, "bo").promptFiles).toEqual(["SOUL.md"]);
  writeFileSync(overlay, '[[prompt]]\nworkspace = "notes/INDEX.md"\n');
  expect(characterWorkspace(config, "ada").promptFiles).toEqual(["MAP.md"]);
  expect(characterWorkspace(config, "ada", { fresh: true }).promptFiles).toEqual(["notes/INDEX.md"]);
  expect(characterWorkspace(config, "ada", { fresh: false }).promptFiles).toEqual(["MAP.md"]);
  expect(characterWorkspace(loadFrom(join(configDir, "config.toml")), "ada").promptFiles).toEqual(["notes/INDEX.md"]);
});

test("picking a character takes the one asked for and holds it, or the only one, or the one held, and refuses an unknown or unchosen one", async () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "characters", "ada"), { recursive: true });
  mkdirSync(join(configDir, "characters", "bo"), { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "\n");
  const config = loadFrom(join(configDir, "config.toml"));
  const pair = await CharacterRegistry.create(configDir, join(root, "data"), config);

  expect(() => pair.resolveCharacter("cy")).toThrow('character "cy" not found (available: ["ada", "bo"])');
  expect(() => pair.resolveCharacter(undefined)).toThrow('multiple characters available (["ada", "bo"]) — specify one with --character or SHORE_CHARACTER');
  expect(pair.resolveCharacter("bo")).toBe("bo");
  expect(pair.selectedCharacter()).toBe("bo");
  expect(pair.resolveCharacter(undefined)).toBe("bo");

  const lone = join(root, "lone");
  mkdirSync(join(lone, "characters", "ada"), { recursive: true });
  const single = await CharacterRegistry.create(lone, join(root, "lone-data"), config);
  expect(single.selectedCharacter()).toBeUndefined();
  expect(single.resolveCharacter(undefined)).toBe("ada");
  expect(single.selectedCharacter()).toBe("ada");
});

test("starting makes each character's missing workspace and drops a prompt snapshot left by a home conversation with nothing in it", async () => {
  const root = makeRoot();
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(join(configDir, "characters", "ada"), { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "\n");
  const config = loadFrom(join(configDir, "config.toml"));
  mkdirSync(join(dataDir, "ada"), { recursive: true });
  initializeDatabase(dataDir);
  writeCharacterState(join(dataDir, "ada"), "active_prompt/.snapshot", "1");
  writeCharacterState(join(dataDir, "ada"), "active_prompt/SOUL.md", "left over");

  await CharacterRegistry.create(configDir, dataDir, config);

  expect(statSync(join(configDir, "characters", "ada", "workspace")).isDirectory()).toBe(true);
  expect(readCharacterState(join(dataDir, "ada"), "active_prompt/.snapshot")).toBeUndefined();
  expect(readCharacterState(join(dataDir, "ada"), "active_prompt/SOUL.md")).toBeUndefined();
});
