import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, loadConfig } from "../src/config/loader.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "shore-default-config-"));
}

describe("loadConfig", () => {

  test("an existing config.toml is never overwritten", () => {
    const root = tempDir();
    const configPath = join(root, "config.toml");
    writeFileSync(configPath, "[chat]\ndisplay_name = \"eve\"\n");

    loadConfig(configPath, {
      env: { SHORE_CONFIG_DIR: root },
      createDefault: () => {
        throw new Error("createDefault must not fire when config.toml exists");
      },
      onWarn: () => {},
    });
    expect(readFileSync(configPath, "utf8")).toBe("[chat]\ndisplay_name = \"eve\"\n");
  });

  test("a first run writes a starter config that loads, with the tools a new character starts with and the guide to them", () => {
    const root = tempDir();
    const configPath = join(root, "config.toml");
    const loaded = loadConfig(configPath, {
      env: { SHORE_CONFIG_DIR: root },
      createDefault: (configDir) => {
        createDefaultConfig(configDir, () => {});
      },
      onWarn: () => {},
    });
    expect(readFileSync(configPath, "utf8")).toStartWith("# Shore configuration. Set ANTHROPIC_API_KEY in the environment or .env.\n");
    expect(loaded.app.chat.model).toBe("anthropic:claude-opus-4-8");
    expect(loaded.app.tools.enabled).toEqual([
      "bash", "read", "edit", "apply_patch", "search_chat_logs", "read_chat_logs", "list_threads", "start_thread", "edit_thread", "guide",
    ]);
  });
});
