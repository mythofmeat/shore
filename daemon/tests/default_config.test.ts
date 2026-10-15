import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.ts";

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
});
