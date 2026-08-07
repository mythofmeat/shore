/**
 * What the daemon decides before it opens anything: the CLI, the listen
 * address, and the client token.
 *
 * Ported from the startup half of `crates/daemon/src/main.rs`.
 *
 * # There is no exposure policy here any more
 *
 * There used to be a substantial one — a non-loopback bind was refused unless
 * `unsafe_allow_remote_access` acknowledged it, `[daemon].allowed_hosts`
 * narrowed peer IPs, and roughly 200 lines here parsed socket addresses to tell
 * loopback from not. All of it existed because the protocol was
 * unauthenticated, and all of it is gone.
 *
 * Every client presents a token now (`config/token.ts`), so where the daemon is
 * bound no longer decides who can talk to it. Two things follow, and both were
 * the point:
 *
 * - **`[daemon]` is one key.** `addr`, and nothing else. There is no
 *   configuration you can get wrong, because being safe is no longer something
 *   you configure.
 * - **A bind address is just a bind address.** `0.0.0.0` needs no
 *   acknowledgement, because it no longer means "unauthenticated and
 *   reachable" — it means "reachable", and the token handles the rest.
 */

import { statSync } from "node:fs";

import { rustJoin, configDir } from "../config/dirs.ts";
import { loadConfig, type LoadedConfig } from "../config/loader.ts";
import { resolveDaemonToken, type ResolvedToken } from "../config/token.ts";

/** The daemon's flags. */
export interface Cli {
  /** Config file to load instead of `$XDG_CONFIG_HOME/shore/config.toml`. */
  readonly config?: string | undefined;
  /** TCP listen address for this process. Overrides `SHORE_ADDR` and config. */
  readonly addr?: string | undefined;
  /**
   * Pin the registered instance ID in `instances.json`.
   *
   * Unset means a fresh UUID per startup. Set gives the daemon a stable,
   * discoverable ID — `shore-mcp` uses it to rediscover a test daemon it
   * spawned earlier.
   */
  readonly instanceId?: string | undefined;
}

/** Where a resolved value came from, for the startup log. */
export type StartupValueSource = "cli" | "env" | "config";

/** The name a user would recognise, which is what the log and errors print. */
export function sourceLabel(source: StartupValueSource): string {
  switch (source) {
    case "cli":
      return "--addr";
    case "env":
      return "SHORE_ADDR";
    case "config":
      return "[daemon].addr";
  }
}

export interface StartupConfig {
  readonly loaded: LoadedConfig;
  readonly configPath: string;
  /**
   * The shared secret every client must present, resolved once here.
   *
   * Resolved at startup rather than per connection so that a daemon which
   * cannot establish one fails to *start* — loudly, with somewhere to go —
   * instead of accepting connections and refusing every one of them.
   */
  readonly token: ResolvedToken;
  readonly bindAddr: string;
  readonly bindAddrSource: StartupValueSource;
}

/**
 * Anything that stops the daemon starting.
 *
 * One class with a `kind` rather than a class per variant: every one of these
 * is printed and then exits, and nothing branches on which it was. The `kind`
 * is there so a test can assert on the variant without matching on prose.
 */
export class StartupError extends Error {
  constructor(
    readonly kind:
      | "invalid_config_path"
      | "load_config"
      | "register_instance"
      | "server_run"
      | "token",
    message: string,
  ) {
    super(message);
    this.name = "StartupError";
  }
}

/**
 * Parse the daemon's arguments.
 *
 * Rejects an unknown flag rather than ignoring it, which is what clap did: a
 * misspelled `--addr` that silently did nothing would bind somewhere the
 * operator did not intend, and the whole policy below is about not doing that.
 */
export function parseArgs(argv: readonly string[]): Cli {
  const cli: { config?: string; addr?: string; instanceId?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const [flag, inline] = eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case "--config":
        cli.config = value();
        break;
      case "--addr":
        cli.addr = value();
        break;
      case "--instance-id":
        cli.instanceId = value();
        break;
      default:
        throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  return cli;
}

/**
 * Load the config and settle every startup value against it.
 *
 * The env is a parameter rather than read here so the precedence below can be
 * tested without a process-wide mutation, and so `--config` re-homing the
 * config directory reaches the loader as the same env the daemon runs under.
 *
 * `createDefault` is injected for the same reason: writing a starter
 * `config.toml` on a first run is the one thing here that is not a pure
 * function of `(argv, env, config)`, and threading it from `startDaemon` keeps
 * it that way. Omitted, nothing is written — which is what every test that only
 * wants the policy resolved should do.
 */
export function resolveStartup(
  cli: Cli,
  env: NodeJS.ProcessEnv = process.env,
  options: { createDefault?: ((configDir: string) => void) | undefined } = {},
): StartupConfig {
  const explicitConfigPath = resolveExplicitConfigPath(cli.config);
  const configPathForErrors = explicitConfigPath ?? defaultConfigPath(env);

  let loaded: LoadedConfig;
  try {
    loaded = loadConfig(explicitConfigPath, {
      env,
      ...(options.createDefault === undefined ? {} : { createDefault: options.createDefault }),
    });
  } catch (e) {
    throw new StartupError(
      "load_config",
      `Failed to load Shore config from ${configPathForErrors}: ${String(e)}`,
    );
  }

  const [bindAddr, bindAddrSource] = resolveListenAddr(cli.addr, startupEnvAddr(env), loaded);

  let token: ResolvedToken;
  try {
    token = resolveDaemonToken(env, loaded.dirs.config);
  } catch (e) {
    // A refusal to start, never a fallback to "authentication off". There is
    // one way in and no way to switch it off, so a daemon that cannot hold a
    // token is a daemon that must not listen.
    throw new StartupError("token", String(e instanceof Error ? e.message : e));
  }

  return {
    loaded,
    configPath: explicitConfigPath ?? defaultConfigPath(env),
    token,
    bindAddr,
    bindAddrSource,
  };
}

/**
 * `--config`, checked before the loader gets it.
 *
 * Both refusals are for the same reason: the loader treats the path's parent as
 * the config directory, so a typo or a directory would silently re-home
 * everything — characters, memory, the lot — somewhere empty, and the daemon
 * would come up looking freshly installed.
 */
export function resolveExplicitConfigPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new StartupError(
      "invalid_config_path",
      `Invalid --config path ${path}: file does not exist`,
    );
  }
  if (stat.isDirectory()) {
    throw new StartupError(
      "invalid_config_path",
      `Invalid --config path ${path}: expected a config.toml file, not a directory`,
    );
  }
  return path;
}

/** `--addr`, then a non-blank `SHORE_ADDR`, then `[daemon].addr`. */
export function resolveListenAddr(
  cliAddr: string | undefined,
  envAddr: string | undefined,
  loaded: LoadedConfig,
): [string, StartupValueSource] {
  if (cliAddr !== undefined) return [cliAddr, "cli"];
  if (envAddr !== undefined && envAddr.trim() !== "") return [envAddr, "env"];
  return [loaded.app.daemon.addr, "config"];
}

/** `SHORE_ADDR`, blank treated as unset. */
export function startupEnvAddr(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env["SHORE_ADDR"];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}


export function defaultConfigPath(env?: NodeJS.ProcessEnv): string {
  return rustJoin(configDir(env), "config.toml");
}
