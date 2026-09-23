import { required } from "../util/required.ts";

import { existsSync, readFileSync, rmSync } from "node:fs";
import { atomicWriteSync } from "../engine/atomic.ts";
import { join } from "node:path";

import { discoverCharacters, type Env } from "../config/dirs.ts";
import {
  ConfigError,
  loadCharacterConfig,
  loadConfig,
  modelRefResolves,
  type LoadedConfig,
} from "../config/loader.ts";
import { NO_CHAT_MODELS_MESSAGE } from "../config/models.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { configView } from "../config/preferences.ts";
import { isSecretConfigPath, REDACTED, redactSecrets, serializeConfigValue } from "../config/serialize.ts";
import { CATALOG_SECTIONS, defaultAppConfig } from "../config/app.ts";
import { configSchema, findSchemaEntry, type LiveInstances, type SchemaEntry } from "../config/schema.ts";
import { schemaValueLiteral, SchemaValueError } from "../config/schema_value.ts";
import {
  setTomlValue,
  tomlKeyDefined,
  unsetTomlValue,
  TomlEditError,
} from "../config/toml_edit.ts";
import { restartRequiredChanges } from "../config/restart.ts";
import { applyDeferredEdits, changedPromptFiles } from "../memory/deferred_edits.ts";
import { ALL_TOOLS, toolEnabled } from "../tools/registry.ts";
import { internalError, invalidRequest, notFound } from "./errors.ts";
import { formatConfigPath, parseConfigPath, publicConfig } from "../config/surface.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { ConfigSources } from "../protocol/ConfigSources.ts";
import type { ConfigSetResult } from "../protocol/ConfigSetResult.ts";
export type { ConfigSetResult } from "../protocol/ConfigSetResult.ts";

export interface ConfigRuntime {
  globalConfig?(): LoadedConfig;
  reloadRuntimeConfig(fresh: LoadedConfig): void;
  adoptGlobalConfig(fresh: LoadedConfig): void;
  notifyPromptSnapshotRefreshed(character: string): void;
}

export interface ConfigContext {
  thread?: string;
  config: LoadedConfig;
  configPath: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  runtime: ConfigRuntime;
  env?: Env;
}

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

export function tools(ctx: ConfigContext, mcpTools: readonly string[] = []): OperationResult<"tools"> {
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
    const sa = required(subagents.get(name));
    return {
      name,
      enabled: cfg.enabled_subagents.includes(name),
      tools: [...sa.tools],
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
    for (const t of required(subagents.get(name)).tools) {
      if (!known.has(t)) warnings.push(`subagent '${name}' references unknown tool '${t}'`);
    }
  }

  return { tools: toolRows, subagents: subagentRows, mcp: [...mcpTools].sort(), warnings };
}

export function configCheck(ctx: ConfigContext, env: NodeJS.ProcessEnv = process.env): OperationResult<"config_check"> {
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

  const checked: OperationResult<"config_check"> = {
    valid: warnings.length === 0,
    warnings,
    info,
    config_dir: ctx.config.dirs.config,
    data_dir: ctx.config.dirs.data,
    cache_dir: ctx.config.dirs.cache,
    chat_models: ctx.config.models.chat.size,
    providers: providerCount,
  };
  return checked;
}

export function config(ctx: ConfigContext, args: OperationInput<"config">): OperationResult<"config"> & { replacement?: string } {
  const key = args.key ?? undefined;
  const value = args.value ?? undefined;
  if (key !== undefined && value !== undefined) return configSet(ctx, key, value);

  const app = reportedConfig(ctx);
  const defaults = reportedDefaults();

  if (key === undefined) return { config: app, defaults };
  const canonical = canonicalKey(key);
  const found = walkConfigKey(app, canonical);
  if (found === undefined) throw notFound(`Config section not found: ${key}`);
  return { key: canonical, config: found.value, defaults: walkConfigKey(defaults, canonical)?.value ?? null };
}

function catalogSections(ctx: ConfigContext): Record<string, unknown> {
  const raw = ctx.config.rawTable;
  const out: Record<string, unknown> = { providers: {} };
  for (const section of CATALOG_SECTIONS) {
    if (raw?.[section] !== undefined) out[section] = serializeConfigValue(raw[section]);
  }
  return out;
}

function reportedConfig(ctx: ConfigContext): Record<string, unknown> {
  return redactSecrets(publicConfig({
    ...(serializeConfigValue(ctx.config.app) as Record<string, unknown>),
    ...catalogSections(ctx),
  })) as Record<string, unknown>;
}

export function reportedDefaults(): Record<string, unknown> {
  const out = serializeConfigValue(defaultAppConfig()) as Record<string, unknown>;
  out.providers = {};
  return publicConfig(out);
}

export function reportedSections(ctx: ConfigContext): string[] {
  return Object.keys(reportedConfig(ctx));
}

export function canonicalKey(key: string): string {
  try { return formatConfigPath(parseConfigPath(key)); }
  catch { throw notFound(`Config section not found: ${key}`); }
}

function walkConfigKey(root: Record<string, unknown>, key: string): { value: unknown } | undefined {
  let current: unknown = root;
  for (const segment of parseConfigPath(key)) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    const table = current as Record<string, unknown>;
    if (!(segment in table)) return undefined;
    current = table[segment];
  }
  return { value: current };
}

function liveInstances(ctx: ConfigContext): LiveInstances {
  const app = reportedConfig(ctx);
  return {
    instancesAt(key: string): readonly string[] {
      const found = walkConfigKey(app, key);
      const table = found?.value;
      if (table === null || typeof table !== "object" || Array.isArray(table)) return [];
      return Object.keys(table);
    },
  };
}

export function schemaOf(ctx: ConfigContext): SchemaEntry[] {
  return configSchema(liveInstances(ctx));
}

function valueSources(ctx: ConfigContext): ConfigSources {
  const sorted = (names: Iterable<string>): string[] => [...names].sort();
  return {
    chat_models: sorted(ctx.config.models.chat.keys()),
    embedding_models: sorted(ctx.config.models.embedding.keys()),
    image_models: sorted(ctx.config.models.imageGeneration.keys()),
    tools: sorted(ALL_TOOLS.map((t) => t.name)),
    subagents: sorted(ctx.config.app.subagents.keys()),
    characters: sorted(discoverCharacters(ctx.config.dirs.config, ctx.config.dirs.workspace)),
    providers: sorted(ctx.config.providers.entries().map(([name]) => name)),
  };
}

export function configSchemaCommand(ctx: ConfigContext) {
  const base: OperationResult<"config_schema"> = { schema: schemaOf(ctx), sources: valueSources(ctx) };
  return base;
}

function checkAgainstSource(ctx: ConfigContext, entry: SchemaEntry, value: string): void {
  if (entry.source === undefined || entry.kind === "list") return;
  const trimmed = value.trim();
  if (trimmed === "") return;

  if (entry.source === "chat_models") {
    try {
      findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, trimmed, true);
    } catch (e) {
      throw notFound(message(e));
    }
    return;
  }

  const known = valueSources(ctx)[entry.source] ?? [];
  if (known.length === 0 || known.includes(trimmed)) return;
  throw notFound(`${entry.key}: no ${entry.source} named "${trimmed}". Known: ${known.join(", ")}`);
}

function targetFile(ctx: ConfigContext, path: readonly string[]): { file: string; path: readonly string[] } {
  const files = [...new Set([ctx.configPath, ...(ctx.config.files ?? [])])];
  for (const file of [...files].reverse()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (tomlKeyDefined(text, path)) return { file, path };

  }
  return { file: ctx.configPath, path };
}

function restoreConfigFile(file: string, before: string, existed: boolean): void {
  try {
    if (existed) atomicWriteSync(file, before);
    else rmSync(file, { force: true });
  } catch (e) {
    throw internalError(
      `${file} was left holding a rejected edit: restoring it failed: ${(e as Error).message}`,
    );
  }
}

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw internalError(`failed to read ${file}: ${(e as Error).message}`);
  }
}

interface ConfigWrite {
  text: string;
  action: string;
}

function commitConfigKey(
  ctx: ConfigContext,
  key: string,
  edit: (before: string, path: readonly string[]) => ConfigWrite,
  rejection: string,
): ConfigSetResult {
  const path = parseConfigPath(key);
  const target = targetFile(ctx, path);
  const file = target.file;
  const before = readOrEmpty(file);

  let written: string;
  let action: string;
  try {
    const result = edit(before, target.path);
    written = result.text;
    action = result.action;
  } catch (e) {
    if (e instanceof TomlEditError) throw invalidRequest(e.message);
    throw e;
  }

  const existed = existsSync(file);

  try {
    atomicWriteSync(file, written);
  } catch (e) {
    throw internalError(`failed to write ${file}: ${(e as Error).message}`);
  }

  let fresh: LoadedConfig;
  try {
    fresh = loadConfig(ctx.configPath, loaderOptions(ctx));
  } catch (e) {
    restoreConfigFile(file, before, existed);
    throw invalidRequest(`${rejection} was rejected: ${message(e)}`);
  }

  const restart = restartRequiredChanges(ctx.runtime.globalConfig?.() ?? ctx.config, fresh);
  const previous = walkConfigKey(reportedConfig(ctx), key)?.value ?? null;
  adopt(ctx, fresh);

  return {
    set: key,
    value: walkConfigKey(reportedConfig(ctx), key)?.value ?? null,
    previous,
    file,
    action,
    restart_required: restart,
    masked_by_preference: preferredModelMask(ctx, key),
  };
}

export function setConfigKey(
  ctx: ConfigContext,
  rawKey: string,
  value: string,
): ConfigSetResult {
  const key = canonicalKey(rawKey);
  const entry = findSchemaEntry(schemaOf(ctx), key);
  if (entry === undefined) throw notFound(`Config section not found: ${rawKey}`);

  let literal: string;
  try {
    literal = schemaValueLiteral(entry, value);
  } catch (e) {
    if (e instanceof SchemaValueError) throw invalidRequest(`${key}: ${e.message}`);
    throw e;
  }

  checkAgainstSource(ctx, entry, value);

  return commitConfigKey(
    ctx,
    key,
    (before, owned) => {
      const path = parseConfigPath(key);
      const source = formatConfigPath(owned) === key ? before : unsetTomlValue(before, owned).text;
      return setTomlValue(source, path, literal);
    },
    `${key} = ${isSecretConfigPath(parseConfigPath(key)) ? REDACTED : literal}`,
  );
}

export function clearConfigKey(ctx: ConfigContext, key: string): ConfigSetResult {
  key = canonicalKey(key);
  return commitConfigKey(
    ctx,
    key,
    (before, owned) => {
      const removal = unsetTomlValue(before, owned);
      return { text: removal.text, action: removal.removed ? "removed" : "absent" };
    },
    `clearing ${key}`,
  );
}

const configSet = (ctx: ConfigContext, rawKey: string, value: string): ConfigSetResult =>
  setConfigKey(ctx, rawKey, value);

function preferredModelMask(ctx: ConfigContext, key: string): string | null {
  if (key !== "chat.model") return null;
  const active = ctx.activeModel;
  return active === undefined || active === ctx.config.app.defaults.model ? null : active;
}

const loaderOptions = (ctx: ConfigContext): { env?: Env; deferEnvironment: boolean } =>
  ({ ...(ctx.env === undefined ? {} : { env: ctx.env }), deferEnvironment: true });

export async function configReload(ctx: ConfigContext, args: OperationInput<"config_reload">): Promise<OperationResult<"config_reload">> {
  const apply = args.apply === true;
  const refreshPrompts = args.refresh_prompts === true;

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

  const restart = restartRequiredChanges(ctx.runtime.globalConfig?.() ?? ctx.config, fresh);
  const character = ctx.characterName;
  const characterDataDir = character === undefined ? undefined : join(ctx.config.dirs.data, character);
  const changed = characterDataDir === undefined || character === undefined ? [] : await changedPromptFiles(
    characterDataDir,
    fresh.dirs.config,
    character,
    fresh.dirs.workspace,
    ctx.thread,
  );

  if (!apply) {
    return {
      applied: false,
      ...(restart.length === 0 ? {} : { restart_required: restart }),
      config_path: ctx.configPath,
      character: character ?? null,
      changed_prompt_files: changed,
    };
  }

  let promptsRefreshed = false;
  if (refreshPrompts) {
    if (character === undefined || characterDataDir === undefined) throw invalidRequest("Refreshing prompts requires a character context");
    try {
      await applyDeferredEdits(
        characterDataDir,
        fresh.dirs.config,
        character,
        fresh.dirs.workspace,
        ctx.thread,
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
    ...(restart.length === 0 ? {} : { restart_required: restart }),
    config_path: ctx.configPath,
    character: character ?? null,
    changed_prompt_files: changed,
    prompts_refreshed: promptsRefreshed,
  };
}

function adopt(ctx: ConfigContext, fresh: LoadedConfig): void {
  fresh.adoptEnvironment?.();
  ctx.runtime.adoptGlobalConfig(fresh);
  ctx.runtime.reloadRuntimeConfig(fresh);
  ctx.config = fresh;
}
