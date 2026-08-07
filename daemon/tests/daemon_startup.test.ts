/**
 * What the daemon settles before it opens anything: arguments, the listen
 * address, and the config path.
 *
 * This file used to be mostly about a *refusal* — the remote-access policy,
 * and the ~200 lines of socket-address parsing behind it that decided whether
 * a bind was loopback. All of that is gone with `unsafe_allow_remote_access`
 * and `allowed_hosts`: the token is the boundary now, so where the daemon
 * binds no longer decides who can reach it, and there is no policy left to get
 * wrong. `swp_auth.test.ts` is where the equivalent stakes moved.
 *
 * Two things here are still covered beyond the Rust's own tests:
 *
 * - **Argument parsing.** clap rejected an unknown flag; a hand-rolled parser
 *   that skipped it would let a misspelled `--addr` bind somewhere else.
 * - **A blank `SHORE_ADDR`.** `Option::filter` in the Rust, and the case a
 *   container hits by exporting an empty variable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArgs,
  resolveExplicitConfigPath,
  resolveListenAddr,
  resolveStartup,
  sourceLabel,
  StartupError,
} from "../src/daemon/startup.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";

/** Removed after each test: a harness runs this suite once per mutant, and
 *  `/tmp` is a tmpfs with a fixed inode budget. */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function configWith(daemon: Partial<LoadedConfig["app"]["daemon"]> = {}): LoadedConfig {
  const app = defaultAppConfig();
  return {
    app: { ...app, daemon: { ...app.daemon, ...daemon } },
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: { config: "/c", data: "/d", cache: "/ca", runtime: "/r" },
    rawTable: undefined,
  };
}

/** A config directory holding `config.toml`, and an env pointed at it. */
async function configRoot(
  contents: string,
): Promise<{ path: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "shore-startup-"));
  roots.push(root);
  const dir = join(root, "config");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.toml");
  await writeFile(path, contents);
  return {
    path,
    env: {
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
      HOME: root,
    },
  };
}

describe("precedence", () => {
  test("the listen address is cli, then env, then config", () => {
    const loaded = configWith();

    expect(resolveListenAddr("127.0.0.1:9000", "127.0.0.1:8000", loaded)).toEqual([
      "127.0.0.1:9000",
      "cli",
    ]);
    expect(resolveListenAddr(undefined, "127.0.0.1:8000", loaded)).toEqual([
      "127.0.0.1:8000",
      "env",
    ]);
    expect(resolveListenAddr(undefined, undefined, loaded)).toEqual(["127.0.0.1:7320", "config"]);
  });

  test("a blank SHORE_ADDR is not a value", () => {
    expect(resolveListenAddr(undefined, "   ", configWith())).toEqual(["127.0.0.1:7320", "config"]);
  });

  test("each source prints the name a user would recognise", () => {
    expect(sourceLabel("cli")).toBe("--addr");
    expect(sourceLabel("env")).toBe("SHORE_ADDR");
    expect(sourceLabel("config")).toBe("[daemon].addr");
  });
});

describe("arguments", () => {
  test("the three flags parse, in either spelling", () => {
    expect(parseArgs(["--config", "/tmp/shore/config.toml", "--addr", "127.0.0.1:9000"])).toEqual({
      config: "/tmp/shore/config.toml",
      addr: "127.0.0.1:9000",
    });
    expect(parseArgs(["--instance-id=shore-mcp-test"])).toEqual({ instanceId: "shore-mcp-test" });
  });

  test("no arguments is every flag unset", () => {
    expect(parseArgs([])).toEqual({});
  });

  test("an unknown flag is an error, not a shrug", () => {
    expect(() => parseArgs(["--addrr", "0.0.0.0:1"])).toThrow("unexpected argument");
  });

  test("a flag with no value is an error", () => {
    expect(() => parseArgs(["--addr"])).toThrow("requires a value");
  });
});

describe("--config", () => {
  test("a missing path is refused", () => {
    let caught: unknown;
    try {
      resolveExplicitConfigPath("/definitely/missing.toml");
    } catch (e) {
      caught = e;
    }
    expect((caught as StartupError).kind).toBe("invalid_config_path");
    expect((caught as StartupError).message).toContain("does not exist");
  });

  test("a directory is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "shore-startup-"));
  roots.push(root);
    let caught: unknown;
    try {
      resolveExplicitConfigPath(root);
    } catch (e) {
      caught = e;
    }
    expect((caught as StartupError).kind).toBe("invalid_config_path");
    expect((caught as StartupError).message).toContain("expected a config.toml file");
  });

  test("an unset flag stays unset", () => {
    expect(resolveExplicitConfigPath(undefined)).toBeUndefined();
  });
});

describe("resolveStartup", () => {
  test("cli beats env beats config, all the way through", async () => {
    const { path, env } = await configRoot(`
[daemon]
addr = "127.0.0.1:7000"
`);

    const startup = resolveStartup(
      { config: path, addr: "0.0.0.0:9000" },
      { ...env, SHORE_ADDR: "127.0.0.1:8000" },
    );

    expect(startup.configPath).toBe(path);
    // A non-loopback bind resolves like any other now. It used to need
    // `unsafe_allow_remote_access` and produce warnings; the token replaced
    // both, so this is simply the address that was asked for.
    expect(startup.bindAddr).toBe("0.0.0.0:9000");
    expect(startup.bindAddrSource).toBe("cli");
  });

  test("a non-loopback SHORE_ADDR is resolved, not refused", async () => {
    const { path, env } = await configRoot("");

    const startup = resolveStartup({ config: path }, { ...env, SHORE_ADDR: "0.0.0.0:9000" });
    expect(startup.bindAddr).toBe("0.0.0.0:9000");
    expect(startup.bindAddrSource).toBe("env");
  });

  test("a config that will not parse is fatal, and names the file", async () => {
    const { path, env } = await configRoot("this is not = = toml");

    let caught: unknown;
    try {
      resolveStartup({ config: path }, env);
    } catch (e) {
      caught = e;
    }
    expect((caught as StartupError).kind).toBe("load_config");
    expect((caught as StartupError).message).toContain(path);
  });

  test("with no --config, the path is the loader's own default", async () => {
    const { env } = await configRoot("");
    const startup = resolveStartup({}, env);
    // `--config` re-homes the whole config directory, so this has to be
    // resolved after the loader decides where `<config>` is — a reload that
    // guessed could read a different file than startup did.
    expect(startup.configPath).toBe(join(startup.loaded.dirs.config, "config.toml"));
    expect(startup.bindAddrSource).toBe("config");
  });
});
