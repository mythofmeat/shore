import { join } from "node:path";

import { ConfigDuration } from "../config/duration.ts";
import { discoverCharacters, type Env } from "../config/dirs.ts";
import {
  ConfigError,
  loadCharacterConfig,
  loadConfig,
  modelRefResolves,
  type LoadedConfig,
} from "../config/loader.ts";
import { findModel, NO_CHAT_MODELS_MESSAGE } from "../config/models.ts";
import type { ResolvedModel } from "../config/models.ts";
import { serializeConfigValue } from "../config/serialize.ts";
import { defaultAppConfig } from "../config/app.ts";
import { applyDeferredEdits, changedPromptFiles } from "../memory/deferred_edits.ts";
import { ALL_TOOLS, toolEnabled } from "../tools/registry.ts";
import { internalError, invalidRequest, notFound } from "./errors.ts";
import type { Args } from "./navigation.ts";

export interface ConfigRuntime {
  reloadRuntimeConfig(fresh: LoadedConfig): void;
  setUsageConfig(fresh: LoadedConfig): void;
  setCacheKeepaliveCeiling(ceiling: ConfigDuration): void;
  notifyPromptSnapshotRefreshed(character: string): void;
}

export interface ConfigContext {
  config: LoadedConfig;
  configPath: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  activeResolvedModel: ResolvedModel | undefined;
  runtime: ConfigRuntime;
  env?: Env;
}

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asBool = (v: unknown): boolean => v === true;

const message = (e: unknown): string =>
  e instanceof ConfigError ? e.display : e instanceof Error ? e.message : String(e);

function mcpServerOf(tool: string): string | undefined {
  const parts = tool.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return undefined;
  return parts[1];
}

function toolResolver(ctx: ConfigContext): (tool: string) => boolean {
  const builtin = new Set(ALL_TOOLS.map((t) => t.name));
  const servers = ctx.config.app.mcp;
  return (tool) => {
    if (builtin.has(tool)) return true;
    const server = mcpServerOf(tool);
    return server !== undefined && servers.has(server);
  };
}

export function tools(ctx: ConfigContext): unknown {
  const cfg = ctx.config.app.tools;
  const subagents = ctx.config.app.subagents;
  const known = { has: toolResolver(ctx) };

  const toolRows = ALL_TOOLS.map((def) => ({
    tool: def.name,
    main: toolEnabled(cfg, def.name),
    subagents: cfg.enabled_subagents.filter((s) =>
      (subagents.get(s)?.tools ?? []).some((t) => t === def.name),
    ),
  }));

  const subagentRows = [...subagents.keys()].sort().map((name) => {
    const sa = subagents.get(name)!;
    return {
      name,
      enabled: cfg.enabled_subagents.includes(name),
      tools: sa.tools,
      model: sa.model ?? null,
    };
  });

  const warnings: string[] = [];
  for (const t of cfg.enabled_tools) {
    if (!known.has(t)) warnings.push(`enabled_tools references unknown tool '${t}'`);
  }
  for (const s of cfg.enabled_subagents) {
    if (!subagents.has(s)) {
      warnings.push(`enabled_subagents references undefined subagent '${s}'`);
    }
  }
  for (const name of [...subagents.keys()].sort()) {
    for (const t of subagents.get(name)!.tools) {
      if (!known.has(t)) warnings.push(`subagent '${name}' references unknown tool '${t}'`);
    }
  }

  return { tools: toolRows, subagents: subagentRows, warnings };
}

export function configCheck(ctx: ConfigContext, env: NodeJS.ProcessEnv = process.env): unknown {
  const warnings: string[] = [];
  const info: string[] = [];

  const defaultModel = ctx.config.app.defaults.model;
  const defaultResolves =
    defaultModel !== undefined &&
    modelRefResolves(ctx.config.models, ctx.config.providers, defaultModel);

  const providerCount = ctx.config.providers.size;

  if (ctx.config.models.chat.size > 0) {
    info.push(`${ctx.config.models.chat.size} chat model(s) configured`);
  } else if (providerCount > 0) {
    info.push(`${providerCount} provider(s) configured; models come from discovery`);
  } else if (!defaultResolves) {
    warnings.push(NO_CHAT_MODELS_MESSAGE);
  }

  if (defaultModel !== undefined) {
    if (defaultResolves) info.push(`Default model: ${defaultModel}`);
    else {
      warnings.push(`Default model "${defaultModel}" not found in catalog`);
    }
  } else if (ctx.config.models.chat.size > 0) {
    warnings.push("No default model set. First chat model will be used.");
  }

  for (const model of ctx.config.models.chat.values()) {
    const keyEnv = model.apiKeyEnv;
    if (keyEnv !== undefined && env[keyEnv] === undefined) {
      warnings.push(
        `API key env var $${keyEnv} not set (needed by model ${model.qualifiedName})`,
      );
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
    info,
    config_dir: ctx.config.dirs.config,
    data_dir: ctx.config.dirs.data,
    cache_dir: ctx.config.dirs.cache,
    chat_models: ctx.config.models.chat.size,
    providers: providerCount,
    memory_mode: "markdown",
  };
}

export function config(ctx: ConfigContext, args: Args): unknown {
  const key = asStr(args["key"]);
  const value = asStr(args["value"]);
  if (key !== undefined && value !== undefined) return configSet(ctx, key, value);

  const app = serializeConfigValue(ctx.config.app) as Record<string, unknown>;
  const defaults = serializeConfigValue(defaultAppConfig()) as Record<string, unknown>;

  if (key === undefined) return { config: app, defaults };

  const found = walkConfigKey(app, key);
  if (found === undefined) throw notFound(notFoundMessage(key));
  return { key, config: found.value, defaults: walkConfigKey(defaults, key)?.value ?? null };
}

const SETTABLE_KEY_PATHS: ReadonlyMap<string, string> = new Map([
  ["model", "defaults.model"],
  ["defaults.model", "defaults.model"],
  ["stream", "defaults.stream"],
  ["defaults.stream", "defaults.stream"],
  ["autonomy.enabled", "behavior.autonomy.enabled"],
  ["behavior.autonomy.enabled", "behavior.autonomy.enabled"],
]);

export const settableKeySpellings = (): string[] => [...SETTABLE_KEY_PATHS.keys()];

function notFoundMessage(key: string): string {
  const readable = SETTABLE_KEY_PATHS.get(key);
  if (readable === undefined || readable === key) return `Config section not found: ${key}`;
  return `Config section not found: ${key} — settable under that name; read it as ${readable}`;
}

function walkConfigKey(root: Record<string, unknown>, key: string): { value: unknown } | undefined {
  let current: unknown = root;
  for (const segment of key.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    const table = current as Record<string, unknown>;
    if (!(segment in table)) return undefined;
    current = table[segment];
  }
  return { value: current };
}

function configSet(ctx: ConfigContext, key: string, value: string): unknown {
  switch (key) {
    case "defaults.model":
    case "model": {
      try {
        findModel(ctx.config.models, value);
      } catch (e) {
        throw notFound(message(e));
      }
      ctx.activeModel = value;
      ctx.activeResolvedModel = undefined;
      return { set: key, value };
    }
    case "defaults.stream":
    case "stream": {
      const v = parseBool(value);
      ctx.config.app.defaults.stream = v;
      return { set: key, value: v };
    }
    case "autonomy.enabled":
    case "behavior.autonomy.enabled": {
      const v = parseBool(value);
      ctx.config.app.behavior.autonomy.enabled = v;
      return { set: "autonomy.enabled", value: v };
    }
    default:
      throw invalidRequest(
        `Config key not settable at runtime: ${key}. ` +
          "Supported: defaults.model, defaults.stream, autonomy.enabled",
      );
  }
}

const loaderOptions = (ctx: ConfigContext): { env?: Env } =>
  ctx.env === undefined ? {} : { env: ctx.env };

function parseBool(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("expected true or false");
}

export async function configReload(ctx: ConfigContext, args: Args): Promise<unknown> {
  const apply = asBool(args["apply"]);
  const refreshPrompts = asBool(args["refresh_prompts"]);

  let fresh: LoadedConfig;
  try {
    fresh = loadConfig(ctx.configPath, loaderOptions(ctx));
  } catch (e) {
    throw invalidRequest(`Config error: ${message(e)}`);
  }

  for (const name of discoverCharacters(fresh.dirs.config, fresh.dirs.workspace)) {
    try {
      loadCharacterConfig(fresh, name);
    } catch (e) {
      throw invalidRequest(`Config error in character overlay '${name}': ${message(e)}`);
    }
  }

  const character = ctx.characterName;
  if (character === undefined) {
    throw invalidRequest("config_reload requires a character context");
  }

  const characterDataDir = join(ctx.config.dirs.data, character);
  const changed = await changedPromptFiles(
    characterDataDir,
    fresh.dirs.config,
    character,
    fresh.dirs.workspace,
  );

  if (!apply) {
    return {
      applied: false,
      config_path: ctx.configPath,
      character,
      changed_prompt_files: changed,
    };
  }

  let promptsRefreshed = false;
  if (refreshPrompts) {
    try {
      await applyDeferredEdits(
        characterDataDir,
        fresh.dirs.config,
        character,
        fresh.dirs.workspace,
      );
    } catch (e) {
      throw internalError(`Failed to refresh active prompt snapshot: ${message(e)}`);
    }
    ctx.runtime.notifyPromptSnapshotRefreshed(character);
    promptsRefreshed = true;
  }

  adopt(ctx, fresh);

  return {
    applied: true,
    config_path: ctx.configPath,
    character,
    changed_prompt_files: changed,
    prompts_refreshed: promptsRefreshed,
  };
}

export function configReset(ctx: ConfigContext): unknown {
  let fresh: LoadedConfig;
  try {
    fresh = loadConfig(ctx.configPath, loaderOptions(ctx));
  } catch (e) {
    throw internalError(`Failed to reload config: ${message(e)}`);
  }

  ctx.activeModel = undefined;
  ctx.activeResolvedModel = undefined;
  adopt(ctx, fresh);

  return {
    reset: true,
    message: "Configuration reloaded from disk",
    config_path: ctx.configPath,
    invalidated: { runtime_overrides: true },
  };
}

function adopt(ctx: ConfigContext, fresh: LoadedConfig): void {
  ctx.runtime.reloadRuntimeConfig(fresh);
  ctx.runtime.setUsageConfig(fresh);
  ctx.runtime.setCacheKeepaliveCeiling(fresh.app.cache.keepalive_max);
  ctx.config = fresh;
}
