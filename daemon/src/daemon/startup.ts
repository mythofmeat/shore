import { statSync } from "node:fs";

import type { WebConfig } from "../config/app.ts";
import { rustJoin, configDir } from "../config/dirs.ts";
import { loadConfig, type LoadedConfig } from "../config/loader.ts";
import { webBinding } from "../web/policy.ts";

export interface Cli {
  readonly config?: string | undefined;
  readonly addr?: string | undefined;
  readonly instanceId?: string | undefined;
}

export type StartupValueSource = "cli" | "env" | "config";

export interface StartupConfig {
  readonly loaded: LoadedConfig;
  readonly configPath: string;
  readonly web: WebConfig;
  readonly webSource: StartupValueSource;
}

export class StartupError extends Error {
  constructor(
    readonly kind:
      | "invalid_config_path"
      | "load_config"
      | "own_data_directory"
      | "register_instance"
      | "server_run",
    message: string,
  ) {
    super(message);
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

  const [web, webSource] = resolveWebConfig(loaded.app.daemon.web, env, cli.addr);
  return {
    loaded,
    configPath: explicitConfigPath ?? defaultConfigPath(env),
    web,
    webSource,
  };
}

export function resolveWebConfig(config: WebConfig, env: NodeJS.ProcessEnv, cliAddr?: string): [WebConfig, StartupValueSource] {
  const fromEnv = env["SHORE_WEB_ADDR"]?.trim();
  const [addr, source, named] = cliAddr === undefined ? [fromEnv, "env", "SHORE_WEB_ADDR"] as const : [cliAddr.trim(), "cli", "--addr"] as const;
  if (addr === undefined || addr === "") return [config, "config"];
  const web = { ...config, enabled: true, bind_addr: addr };
  try { webBinding(web); }
  catch (error) { throw new StartupError("load_config", `Invalid ${named} ${JSON.stringify(addr)}: ${error instanceof Error ? error.message : String(error)}`); }
  return [web, source];
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

function defaultConfigPath(env?: NodeJS.ProcessEnv): string {
  return rustJoin(configDir(env), "config.toml");
}
