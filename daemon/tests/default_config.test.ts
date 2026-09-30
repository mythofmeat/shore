import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import { createDefaultConfig, DEFAULT_CONFIG_TOML, loadConfig, parseConfigTable } from "../src/config/loader.ts";
import { serializeConfigValue } from "../src/config/serialize.ts";
import { renderDefaultsToml, renderStarterConfig, UNSET } from "../src/config/starter.ts";
import { resolveShoreDirs } from "../src/config/dirs.ts";
import { resolveStartup } from "../src/daemon/startup.ts";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-default-config-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = required(roots.pop());
    try {
      chmodSync(root, 0o700);
    } catch {
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createDefaultConfig", () => {
  test("creates the directory as well as the file — `create_default_config_creates_file`", () => {
    const root = tempDir();
    const dir = join(root, "newdir");

    const written = createDefaultConfig(dir, () => {});
    expect(written).toBe(join(dir, "config.toml"));

    const content = readFileSync(join(dir, "config.toml"), "utf8");
    expect(content).toContain("Shore configuration");
    expect(content).toContain("\n");
    expect(content).toContain("\n");
    expect(content).not.toContain("[chat.");
  });

  test("the second run loads what the first run wrote", () => {
    const root = tempDir();
    createDefaultConfig(root, () => {});

    const loaded = loadConfig(join(root, "config.toml"), {
      env: { SHORE_CONFIG_DIR: root },
      onWarn: () => {},
    });
    expect(loaded.app.defaults.model).toBe("anthropic:claude-opus-4-8");

  });

  test("a directory it cannot write warns and returns undefined", () => {
    const root = tempDir();
    chmodSync(root, 0o500);

    const warnings: string[] = [];
    expect(createDefaultConfig(root, (message) => warnings.push(message))).toBeUndefined();
    expect(warnings).toEqual(["Could not write default config.toml"]);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });
});

describe("renderStarterConfig", () => {
  test("uncommenting the generated block yields exactly the defaults", () => {
    const parsed = parseConfigTable(Bun.TOML.parse(renderDefaultsToml()) as Record<string, unknown>, resolveShoreDirs({}), () => {});

    expect(serializeConfigValue(parsed.app)).toEqual(serializeConfigValue(defaultAppConfig()));
  });

  test("the starter includes only a small working setup", () => {
    const rendered = renderStarterConfig();
    expect(rendered.split("\n").length).toBeLessThan(25);
    expect(Object.keys(Bun.TOML.parse(rendered))).toEqual(["providers", "chat", "tools"]);
    expect(rendered).toContain("`shore config --all` lists every optional setting");
    expect(rendered).toContain("`shore config keys` the type each one takes");
  });

  test("the full reference renderer distinguishes unset options", () => {
    expect(renderDefaultsToml(true)).toContain(`model = ${UNSET}`);
    expect(renderDefaultsToml()).not.toContain(UNSET);
    expect(renderStarterConfig()).not.toContain("[defaults");
  });

});

describe("loadConfig", () => {
  test("writes the starter file when told to — `create_default_config_via_load_when_missing`", () => {
    const root = tempDir();
    const configPath = join(root, "shore", "config.toml");
    expect(existsSync(configPath)).toBe(false);

    const loaded = loadConfig(configPath, {
      env: { SHORE_CONFIG_DIR: join(root, "shore") },
      createDefault: (dir) => void createDefaultConfig(dir, () => {}),
      onWarn: () => {},
    });

    expect(loaded.app.defaults.model).toBe("anthropic:claude-opus-4-8");
    expect(existsSync(configPath)).toBe(true);
  });

  test("writes nothing without the hook", () => {
    const root = tempDir();
    const configPath = join(root, "config.toml");

    loadConfig(configPath, { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} });
    expect(existsSync(configPath)).toBe(false);
  });

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

describe("resolveStartup", () => {
  test("passes the hook through to the loader", () => {
    const root = tempDir();
    const configDir = join(root, "config");

    const startup = resolveStartup(
      {},
      { SHORE_CONFIG_DIR: configDir, SHORE_DATA_DIR: join(root, "data") },
      { createDefault: (dir) => void createDefaultConfig(dir, () => {}) },
    );

    expect(startup.configPath).toBe(join(configDir, "config.toml"));
    expect(readFileSync(startup.configPath, "utf8")).toBe(DEFAULT_CONFIG_TOML);
  });

  test("writes no config.toml when the hook is omitted", () => {
    const root = tempDir();
    const configDir = join(root, "config");

    resolveStartup({}, { SHORE_CONFIG_DIR: configDir, SHORE_DATA_DIR: join(root, "data") });

    expect(existsSync(join(configDir, "config.toml"))).toBe(false);
  });
});
