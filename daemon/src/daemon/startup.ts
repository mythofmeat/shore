/**
 * What the daemon decides before it opens anything.
 *
 * Ported from the startup half of `crates/daemon/src/main.rs`: the CLI, the
 * three-way precedence for the listen address, and the remote-access policy.
 *
 * Everything here is a pure function of `(argv, env, config)`. That is not
 * tidiness — it is the only way the policy below is testable, and the policy is
 * the one thing in the daemon that decides how exposed it is.
 *
 * # The policy, in one paragraph
 *
 * Shore speaks an unauthenticated, unencrypted protocol. Binding it to
 * anything but loopback puts a conversation — and the tools attached to it —
 * in reach of whoever can route to the port. So a non-loopback bind is refused
 * unless someone said so explicitly, in the config or in the environment, and
 * even then it warns. `[daemon].allowed_hosts` narrows peer IPs and is not a
 * substitute: it is an allowlist, not authentication.
 */

import { statSync } from "node:fs";

import { rustJoin, configDir } from "../config/dirs.ts";
import { loadConfig, type LoadedConfig } from "../config/loader.ts";

/**
 * Environment override for `[daemon].unsafe_allow_remote_access`.
 *
 * Lets a container opt into a non-loopback bind without a writable
 * `config.toml`, the same way `SHORE_ADDR` overrides `[daemon].addr`.
 */
export const ALLOW_REMOTE_ENV = "SHORE_UNSAFE_ALLOW_REMOTE_ACCESS";

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

/** A non-loopback bind that was allowed, and what is worrying about it. */
export interface RemoteAccessWarning {
  readonly addr: string;
  readonly bindAddrSource: StartupValueSource;
  readonly message: string;
}

export interface StartupConfig {
  readonly loaded: LoadedConfig;
  readonly configPath: string;
  readonly bindAddr: string;
  readonly bindAddrSource: StartupValueSource;
  readonly allowRemoteAccess: boolean;
  /** Where the remote-access opt-in came from, for the startup log. */
  readonly allowRemoteAccessSource: string;
  readonly remoteAccessWarnings: readonly RemoteAccessWarning[];
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
      | "remote_access_policy"
      | "invalid_env_bool"
      | "register_instance"
      | "server_run",
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
 */
export function resolveStartup(cli: Cli, env: NodeJS.ProcessEnv = process.env): StartupConfig {
  const explicitConfigPath = resolveExplicitConfigPath(cli.config);
  const configPathForErrors = explicitConfigPath ?? defaultConfigPath(env);

  let loaded: LoadedConfig;
  try {
    loaded = loadConfig(explicitConfigPath, { env });
  } catch (e) {
    throw new StartupError(
      "load_config",
      `Failed to load Shore config from ${configPathForErrors}: ${String(e)}`,
    );
  }

  const [bindAddr, bindAddrSource] = resolveListenAddr(cli.addr, startupEnvAddr(env), loaded);
  const [allowRemoteAccess, allowRemoteAccessSource] = resolveAllowRemoteAccess(
    startupEnvAllowRemoteAccess(env),
    loaded,
  );

  const warnings = validateRemoteAccessPolicy(
    bindAddr,
    allowRemoteAccess,
    loaded.app.daemon.allowed_hosts,
  );
  if (typeof warnings === "string") {
    throw new StartupError(
      "remote_access_policy",
      `Refusing startup for daemon address ${bindAddr} ` +
        `(from ${sourceLabel(bindAddrSource)}): ${warnings}`,
    );
  }

  return {
    loaded,
    configPath: explicitConfigPath ?? defaultConfigPath(env),
    bindAddr,
    bindAddrSource,
    allowRemoteAccess,
    allowRemoteAccessSource,
    remoteAccessWarnings: warnings.map((message) => ({ addr: bindAddr, bindAddrSource, message })),
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

/**
 * `SHORE_UNSAFE_ALLOW_REMOTE_ACCESS` wins over
 * `[daemon].unsafe_allow_remote_access` **in both directions** — setting it to
 * a false value revokes a config opt-in. An operator locking a container down
 * should not have to edit a config file that may not be writable.
 */
export function resolveAllowRemoteAccess(
  envAllowRemoteAccess: boolean | undefined,
  loaded: LoadedConfig,
): [boolean, string] {
  if (envAllowRemoteAccess !== undefined) return [envAllowRemoteAccess, ALLOW_REMOTE_ENV];
  return [loaded.app.daemon.unsafe_allow_remote_access, "[daemon].unsafe_allow_remote_access"];
}

/** `SHORE_ADDR`, blank treated as unset. */
export function startupEnvAddr(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env["SHORE_ADDR"];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

/**
 * The remote-access opt-in from the environment.
 *
 * An unset or blank variable leaves the config value alone; an unparseable one
 * is a hard error rather than a silent ignore. Misreading it in either
 * direction gets the daemon's exposure wrong, and "I set the variable" is
 * exactly the belief that would go unchecked.
 */
export function startupEnvAllowRemoteAccess(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[ALLOW_REMOTE_ENV];
  if (raw === undefined) return undefined;
  return parseEnvBool(ALLOW_REMOTE_ENV, raw);
}

export function parseEnvBool(variable: string, raw: string): boolean | undefined {
  switch (raw.trim().toLowerCase()) {
    case "":
      return undefined;
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new StartupError(
        "invalid_env_bool",
        `Invalid boolean ${JSON.stringify(raw)} for ${variable}: ` +
          `expected 1/true/yes/on or 0/false/no/off`,
      );
  }
}

export function defaultConfigPath(env?: NodeJS.ProcessEnv): string {
  return rustJoin(configDir(env), "config.toml");
}

/**
 * Whether this bind is allowed, and what to say about it.
 *
 * A string is a refusal; an array is permission plus warnings. Two returns
 * rather than a throw because the caller has to add the address and its source
 * to either one, and a refusal here is not exceptional — it is the answer for
 * a daemon someone pointed at `0.0.0.0` without meaning to.
 */
export function validateRemoteAccessPolicy(
  addr: string,
  unsafeAllowRemoteAccess: boolean,
  allowedHosts: readonly string[],
): string[] | string {
  const loopback = bindAddrIsLoopback(addr);
  if (loopback === undefined) {
    return `Invalid daemon listen address ${JSON.stringify(addr)}. Expected HOST:PORT or [IPv6]:PORT.`;
  }
  if (loopback) return [];

  if (!unsafeAllowRemoteAccess) {
    return (
      `Refusing to bind shore-daemon to non-loopback address ${addr}. ` +
      `Set [daemon].unsafe_allow_remote_access = true (or ${ALLOW_REMOTE_ENV}=1) to acknowledge unauthenticated remote TCP exposure. ` +
      `[daemon].allowed_hosts is only an IP allowlist and does not provide authentication or TLS.`
    );
  }

  const warnings = [
    "Remote TCP access is enabled. Shore does not provide authentication or TLS. Restrict Shore to trusted private or overlay networks; [daemon].allowed_hosts only narrows peer IPs and is not a complete security boundary.",
  ];
  if (allowedHosts.length === 0) {
    warnings.push(
      "Remote TCP access is enabled with an empty [daemon].allowed_hosts list; any host that can reach the port may connect.",
    );
  }
  return warnings;
}

/**
 * Whether an address names this machine only. `undefined` means unparseable.
 *
 * Two passes, as the Rust's: an IP literal answers from the address itself —
 * which is why the whole of `127.0.0.0/8` is loopback and not just
 * `127.0.0.1` — and anything else falls back to matching the host text, so
 * `localhost:7320` is accepted without a resolver.
 */
export function bindAddrIsLoopback(addr: string): boolean | undefined {
  const ip = parseSocketAddrIp(addr);
  if (ip !== undefined) return ipIsLoopback(ip);

  const host = extractBindHost(addr);
  if (host === undefined) return undefined;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** The host half of `HOST:PORT` or `[IPv6]:PORT`, without validating either. */
export function extractBindHost(addr: string): string | undefined {
  if (addr.startsWith("[")) {
    const close = addr.indexOf("]");
    if (close === -1) return undefined;
    const host = addr.slice(1, close);
    const suffix = addr.slice(close + 1);
    if (suffix.startsWith(":") && host !== "") return host;
    return undefined;
  }

  const colon = addr.lastIndexOf(":");
  if (colon === -1) return undefined;
  const host = addr.slice(0, colon);
  const port = addr.slice(colon + 1);
  if (host === "" || port === "") return undefined;
  return host;
}

/**
 * The IP of a `SocketAddr`-shaped address, or `undefined`.
 *
 * Rust's `addr.parse::<SocketAddr>()` accepts exactly two forms — `IPv4:PORT`
 * and `[IPv6]:PORT` — with a real u16 port. Reproduced rather than approximated
 * because the fallback path above answers differently: a bare `::1:7320` fails
 * this and is matched as text, which is the behaviour that makes it work.
 */
type Ip = { readonly v4: readonly number[] } | { readonly v6: readonly number[] };

function parseSocketAddrIp(addr: string): Ip | undefined {
  if (addr.startsWith("[")) {
    const close = addr.indexOf("]");
    if (close === -1) return undefined;
    if (!addr.startsWith("]:", close)) return undefined;
    if (!isPort(addr.slice(close + 2))) return undefined;
    const groups = parseIpv6(addr.slice(1, close));
    return groups === undefined ? undefined : { v6: groups };
  }

  const colon = addr.lastIndexOf(":");
  if (colon === -1) return undefined;
  if (!isPort(addr.slice(colon + 1))) return undefined;
  const octets = parseIpv4(addr.slice(0, colon));
  return octets === undefined ? undefined : { v4: octets };
}

function ipIsLoopback(ip: Ip): boolean {
  // `Ipv4Addr::is_loopback` is the whole 127/8 block; `Ipv6Addr::is_loopback`
  // is `::1` alone — an IPv4-mapped `::ffff:127.0.0.1` is not loopback to Rust,
  // and is not treated as one here either.
  if ("v4" in ip) return ip.v4[0] === 127;
  return ip.v6.every((group, i) => group === (i === 7 ? 1 : 0));
}

function isPort(text: string): boolean {
  if (text === "" || !/^\d+$/.test(text)) return false;
  return Number(text) <= 65535;
}

/** Four decimal octets. Rust rejects leading zeros, so this does too. */
function parseIpv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    if (part.length > 1 && part.startsWith("0")) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

/** Eight groups, with at most one `::` run and an optional IPv4 tail. */
function parseIpv6(text: string): number[] | undefined {
  const runs = text.split("::");
  if (runs.length > 2) return undefined;

  const parse = (half: string): number[] | undefined => {
    if (half === "") return [];
    const groups: number[] = [];
    const parts = half.split(":");
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? "";
      // A dotted tail is only legal as the last two groups.
      if (part.includes(".")) {
        if (i !== parts.length - 1) return undefined;
        const octets = parseIpv4(part);
        if (octets === undefined) return undefined;
        groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        groups.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parse(runs[0] ?? "");
  if (head === undefined) return undefined;
  if (runs.length === 1) return head.length === 8 ? head : undefined;

  const tail = parse(runs[1] ?? "");
  if (tail === undefined) return undefined;
  const fill = 8 - head.length - tail.length;
  // `::` has to stand for at least one group, which is what makes
  // `1:2:3:4:5:6:7::8` invalid rather than a redundant spelling.
  if (fill < 1) return undefined;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}
