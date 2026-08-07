/**
 * The daemon's startup policy.
 *
 * The Rust's own tests for this are in `main.rs`'s `mod tests`, and every one
 * of them is replayed below. They are worth replaying rather than
 * re-deriving because the thing they pin is a *refusal*: a bug here does not
 * crash, it opens a port.
 *
 * Three things are covered beyond the Rust's own:
 *
 * - **`127.0.0.2` is loopback.** Rust's `Ipv4Addr::is_loopback` is the whole
 *   `127/8` block, and a TypeScript port that compared against the string
 *   `"127.0.0.1"` would refuse a bind the Rust allowed. The reverse mistake —
 *   treating `[::ffff:127.0.0.1]` as loopback — would open a real one.
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
  ALLOW_REMOTE_ENV,
  bindAddrIsLoopback,
  extractBindHost,
  parseArgs,
  parseEnvBool,
  resolveAllowRemoteAccess,
  resolveExplicitConfigPath,
  resolveListenAddr,
  resolveStartup,
  sourceLabel,
  StartupError,
  validateRemoteAccessPolicy,
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

describe("the remote-access policy", () => {
  test("a loopback bind needs no opt-in", () => {
    expect(validateRemoteAccessPolicy("127.0.0.1:7320", false, [])).toEqual([]);
  });

  test("a remote bind is refused without one", () => {
    const err = validateRemoteAccessPolicy("0.0.0.0:7320", false, []);
    expect(typeof err).toBe("string");
    expect(err).toContain("unsafe_allow_remote_access");
    expect(err).toContain("allowed_hosts");
  });

  test("an opted-in remote bind warns twice when the allowlist is empty", () => {
    const warnings = validateRemoteAccessPolicy("0.0.0.0:7320", true, []);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("does not provide authentication or TLS");
    expect(warnings[1]).toContain("any host that can reach the port may connect");
  });

  test("an allowlist removes only the second warning", () => {
    const warnings = validateRemoteAccessPolicy("0.0.0.0:7320", true, ["10.0.0.5"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("trusted private or overlay networks");
  });

  test("localhost by name is loopback", () => {
    expect(validateRemoteAccessPolicy("localhost:7320", false, [])).toEqual([]);
  });

  test("an unparseable address is refused rather than assumed safe", () => {
    const err = validateRemoteAccessPolicy("not-an-address", false, []);
    expect(err).toContain("Invalid daemon listen address");
  });
});

describe("what counts as loopback", () => {
  test("the whole 127/8 block, as Rust's is_loopback", () => {
    expect(bindAddrIsLoopback("127.0.0.1:7320")).toBe(true);
    expect(bindAddrIsLoopback("127.0.0.2:7320")).toBe(true);
    expect(bindAddrIsLoopback("127.255.255.254:7320")).toBe(true);
    expect(bindAddrIsLoopback("128.0.0.1:7320")).toBe(false);
  });

  test("::1 in both spellings, bracketed and bare", () => {
    expect(bindAddrIsLoopback("[::1]:7320")).toBe(true);
    expect(bindAddrIsLoopback("[0:0:0:0:0:0:0:1]:7320")).toBe(true);
    expect(bindAddrIsLoopback("::1:7320")).toBe(true);
  });

  test("`::` has to stand for at least one group", () => {
    // Seven groups on the left and one on the right leaves nothing for `::`
    // to elide, so Rust rejects the literal and the host text is matched
    // instead — which does not match. A parser that allowed a zero-width `::`
    // would read this malformed address as `::1` and skip the opt-in check.
    expect(bindAddrIsLoopback("[0:0:0:0:0:0:0::1]:7320")).toBe(false);
  });

  test("an IPv4-mapped loopback is not loopback", () => {
    // `Ipv6Addr::is_loopback` is `::1` alone. Reading this as loopback would
    // let `[::ffff:127.0.0.1]:7320` bind with no opt-in, and that address is
    // reachable from off-host on some stacks.
    expect(bindAddrIsLoopback("[::ffff:127.0.0.1]:7320")).toBe(false);
    expect(bindAddrIsLoopback("[::]:7320")).toBe(false);
  });

  test("a bad port makes it a name, not an IP", () => {
    // `1.2.3.4:99999` fails Rust's SocketAddr parse and falls through to the
    // host match, which does not match — so it is remote, not invalid. The
    // same fall-through is why `127.0.0.1:99999` stays loopback: the host text
    // matches literally even though the port is not a u16.
    expect(bindAddrIsLoopback("1.2.3.4:99999")).toBe(false);
    expect(bindAddrIsLoopback("127.0.0.1:99999")).toBe(true);
    expect(bindAddrIsLoopback("127.0.0.2:99999")).toBe(false);
  });

  test("no port at all is unparseable", () => {
    expect(bindAddrIsLoopback("not-an-address")).toBeUndefined();
    expect(bindAddrIsLoopback("127.0.0.1")).toBeUndefined();
    expect(bindAddrIsLoopback("[::1]")).toBeUndefined();
  });

  test("the host half is taken from the last colon", () => {
    expect(extractBindHost("localhost:7320")).toBe("localhost");
    expect(extractBindHost("[::1]:7320")).toBe("::1");
    expect(extractBindHost("::1:7320")).toBe("::1");
    expect(extractBindHost("localhost:")).toBeUndefined();
    expect(extractBindHost(":7320")).toBeUndefined();
  });
});

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

  test("the env opt-in wins in both directions", () => {
    const optedIn = configWith({ unsafe_allow_remote_access: true });
    expect(resolveAllowRemoteAccess(false, optedIn)).toEqual([false, ALLOW_REMOTE_ENV]);
    expect(resolveAllowRemoteAccess(true, configWith())).toEqual([true, ALLOW_REMOTE_ENV]);
    expect(resolveAllowRemoteAccess(undefined, optedIn)).toEqual([
      true,
      "[daemon].unsafe_allow_remote_access",
    ]);
  });

  test("each source prints the name a user would recognise", () => {
    expect(sourceLabel("cli")).toBe("--addr");
    expect(sourceLabel("env")).toBe("SHORE_ADDR");
    expect(sourceLabel("config")).toBe("[daemon].addr");
  });
});

describe("the environment opt-in", () => {
  test("common spellings, both ways", () => {
    for (const raw of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(parseEnvBool(ALLOW_REMOTE_ENV, raw)).toBe(true);
    }
    for (const raw of ["0", "false", "No", "off"]) {
      expect(parseEnvBool(ALLOW_REMOTE_ENV, raw)).toBe(false);
    }
    for (const raw of ["", "   "]) {
      expect(parseEnvBool(ALLOW_REMOTE_ENV, raw)).toBeUndefined();
    }
  });

  test("garbage is rejected rather than ignored", () => {
    let caught: unknown;
    try {
      parseEnvBool(ALLOW_REMOTE_ENV, "flase");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StartupError);
    expect((caught as StartupError).kind).toBe("invalid_env_bool");
    expect((caught as StartupError).message).toContain(ALLOW_REMOTE_ENV);
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
  test("one precedence model, and the warnings that come with it", async () => {
    const { path, env } = await configRoot(`
[daemon]
addr = "127.0.0.1:7000"
unsafe_allow_remote_access = true
`);

    const startup = resolveStartup(
      { config: path, addr: "0.0.0.0:9000" },
      { ...env, SHORE_ADDR: "127.0.0.1:8000" },
    );

    expect(startup.configPath).toBe(path);
    expect(startup.bindAddr).toBe("0.0.0.0:9000");
    expect(startup.bindAddrSource).toBe("cli");
    expect(startup.allowRemoteAccess).toBe(true);
    expect(startup.remoteAccessWarnings.length).toBeGreaterThan(0);
    expect(startup.remoteAccessWarnings[0]?.addr).toBe("0.0.0.0:9000");
    expect(startup.remoteAccessWarnings[0]?.bindAddrSource).toBe("cli");
  });

  test("a non-loopback SHORE_ADDR still meets the policy, and says so", async () => {
    const { path, env } = await configRoot("");

    let caught: unknown;
    try {
      resolveStartup({ config: path }, { ...env, SHORE_ADDR: "0.0.0.0:9000" });
    } catch (e) {
      caught = e;
    }
    expect((caught as StartupError).kind).toBe("remote_access_policy");
    // The source is in the message because it is the only thing that tells an
    // operator which of three places to go and change.
    expect((caught as StartupError).message).toContain("SHORE_ADDR");
  });

  test("the env opt-in permits a remote bind with no config edit", async () => {
    const { path, env } = await configRoot("");

    const startup = resolveStartup(
      { config: path },
      { ...env, SHORE_ADDR: "0.0.0.0:9000", [ALLOW_REMOTE_ENV]: "1" },
    );

    expect(startup.bindAddr).toBe("0.0.0.0:9000");
    expect(startup.allowRemoteAccess).toBe(true);
    expect(startup.allowRemoteAccessSource).toBe(ALLOW_REMOTE_ENV);
    expect(startup.remoteAccessWarnings.length).toBeGreaterThan(0);
  });

  test("the env opt-out revokes a config opt-in", async () => {
    const { path, env } = await configRoot(`
[daemon]
addr = "0.0.0.0:7000"
unsafe_allow_remote_access = true
`);

    let caught: unknown;
    try {
      resolveStartup({ config: path }, { ...env, [ALLOW_REMOTE_ENV]: "0" });
    } catch (e) {
      caught = e;
    }
    expect((caught as StartupError).kind).toBe("remote_access_policy");
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
