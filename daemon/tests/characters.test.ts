
import { writeDurable } from "../src/storage/files.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharacterConfigError, CharacterRegistry } from "../src/characters.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-characters-"));
  roots.push(root);
  return root;
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
    '[heartbeat]\ninvalid_setting = true\n',
  );

  const registry = await CharacterRegistry.create(
    configDir,
    dataDir,
    loadFrom(join(configDir, "config.toml")),
  );

  expect(() => registry.effectiveConfig("Alice")).toThrow(CharacterConfigError);
  expect(() => registry.effectiveConfig("Alice")).toThrow(
    `${join(configDir, "characters", "Alice", "config.toml")}: unknown field \`heartbeat.invalid_setting\``,
  );
});
