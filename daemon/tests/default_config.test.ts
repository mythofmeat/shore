/**
 * The starter `config.toml` a first run writes, and the wiring that fires it.
 *
 * Ports `create_default_config_creates_file` and
 * `create_default_config_via_load_when_missing` from
 * `the deleted port`. Neither could become a replay fixture —
 * both assert on the filesystem rather than on a return value — so both were
 * dropped in the port, and the effect went with them: `DEFAULT_CONFIG_TOML`
 * sat in `config/loader.ts` with no caller, and a fresh install got no config
 * directory and no file to edit.
 *
 * Same shape as the `.env` bug in `dotenv.test.ts` (ff42027c), for the same
 * reason. The last case here is the one that would have caught it: the effect
 * has to be reachable from `startDaemon`, not merely defined.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAppConfig, parseAppConfig } from "../src/config/app.ts";
import { createDefaultConfig, DEFAULT_CONFIG_TOML, loadConfig } from "../src/config/loader.ts";
import { serializeConfigValue } from "../src/config/serialize.ts";
import { renderDefaultsToml, renderStarterConfig, UNSET } from "../src/config/starter.ts";
import { resolveStartup } from "../src/daemon/startup.ts";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-default-config-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    // A case below drops write permission to force a failure; put it back or
    // the cleanup cannot remove the tree.
    try {
      chmodSync(root, 0o700);
    } catch {
      /* already removable */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createDefaultConfig", () => {
  test("creates the directory as well as the file — `create_default_config_creates_file`", () => {
    const root = tempDir();
    // Deliberately does not exist yet: both halves matter on a first run,
    // because nothing can be put in a directory that is not there.
    const dir = join(root, "newdir");

    const written = createDefaultConfig(dir, () => {});
    expect(written).toBe(join(dir, "config.toml"));

    const content = readFileSync(join(dir, "config.toml"), "utf8");
    expect(content).toContain("Shore configuration");
    expect(content).toContain("[defaults]");
    expect(content).toContain("[providers.anthropic]");
    // The starter template must not teach deprecated syntax.
    expect(content).not.toContain("[chat.");
  });

  test("the second run loads what the first run wrote", () => {
    // Every line of the template is commented, so this asserts the file is
    // loadable rather than that it says anything. A starter file that did not
    // parse would leave the first run fine and make every one after it fatal.
    const root = tempDir();
    createDefaultConfig(root, () => {});

    const loaded = loadConfig(join(root, "config.toml"), {
      env: { SHORE_CONFIG_DIR: root },
      onWarn: () => {},
    });
    expect(loaded.rawTable).toEqual({});
  });

  test("a directory it cannot write warns and returns undefined", () => {
    // A read-only config directory is a legitimate deployment. The daemon has
    // to come up anyway, which is why this warns rather than throws.
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
    const parsed = parseAppConfig(Bun.TOML.parse(renderDefaultsToml()));
    if ("err" in parsed) throw new Error(parsed.err);

    expect(serializeConfigValue(parsed.ok)).toEqual(serializeConfigValue(defaultAppConfig()));
  });

  test("every section of the schema reaches the file", () => {
    const rendered = renderStarterConfig();
    for (const section of Object.keys(serializeConfigValue(defaultAppConfig()) as object)) {
      expect(rendered).toContain(`# [${section}]`);
    }
  });

  test("options with no default are marked, not invented", () => {
    const rendered = renderStarterConfig();
    expect(rendered).toContain(`# model = ${UNSET}`);
    expect(renderDefaultsToml()).not.toContain(UNSET);
  });

  test("it does not advertise the deprecated heartbeat alias", () => {
    const defaults = renderStarterConfig().split("# [defaults]\n")[1]?.split("#\n")[0];
    expect(defaults).toBeDefined();
    expect(defaults).not.toContain("heartbeat");
    expect(renderStarterConfig()).toContain("# [defaults.background]");
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

    // An empty table, as the Rust's: the file is entirely comments.
    expect(loaded.app.defaults.model).toBeUndefined();
    expect(existsSync(configPath)).toBe(true);
  });

  test("writes nothing without the hook", () => {
    // The loader's own policy: a function whose name says "load" does not touch
    // the disk unless a caller asked it to.
    const root = tempDir();
    const configPath = join(root, "config.toml");

    loadConfig(configPath, { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} });
    expect(existsSync(configPath)).toBe(false);
  });

  test("an existing config.toml is never overwritten", () => {
    const root = tempDir();
    const configPath = join(root, "config.toml");
    writeFileSync(configPath, '[defaults]\ndisplay_name = "ren"\n');

    loadConfig(configPath, {
      env: { SHORE_CONFIG_DIR: root },
      createDefault: () => {
        throw new Error("createDefault must not fire when config.toml exists");
      },
      onWarn: () => {},
    });
    expect(readFileSync(configPath, "utf8")).toContain("ren");
  });
});

describe("resolveStartup", () => {
  test("passes the hook through to the loader", () => {
    // The gap this file exists for. `createDefaultConfig` being defined is not
    // the property that matters; being reachable from the daemon's startup path
    // is, and this is the seam `startDaemon` hands the effect to.
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

    // The directory itself now exists either way: startup resolves a client
    // token, and a token has to be written somewhere. What this test is about
    // is the *config file*, which only the hook creates.
    expect(existsSync(join(configDir, "config.toml"))).toBe(false);
  });
});
