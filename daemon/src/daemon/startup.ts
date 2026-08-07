import { statSync } from "node:fs";

import { rustJoin, configDir } from "../config/dirs.ts";
import { loadConfig, type LoadedConfig } from "../config/loader.ts";
import { resolveDaemonToken, type ResolvedToken } from "../config/token.ts";

export interface Cli {
  readonly config?: string | undefined;
  readonly addr?: string | undefined;
  readonly instanceId?: string | undefined;
}

export type StartupValueSource = "cli" | "env" | "config";

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
  readonly token: ResolvedToken;
  readonly bindAddr: string;
  readonly bindAddrSource: StartupValueSource;
}

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

export function resolveListenAddr(
  cliAddr: string | undefined,
  envAddr: string | undefined,
  loaded: LoadedConfig,
): [string, StartupValueSource] {
  if (cliAddr !== undefined) return [cliAddr, "cli"];
  if (envAddr !== undefined && envAddr.trim() !== "") return [envAddr, "env"];
  return [loaded.app.daemon.addr, "config"];
}

export function startupEnvAddr(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env["SHORE_ADDR"];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

export function defaultConfigPath(env?: NodeJS.ProcessEnv): string {
  return rustJoin(configDir(env), "config.toml");
}
