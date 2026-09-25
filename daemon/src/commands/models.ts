import { canonicalSettingKey, geminiMode } from "../config/surface.ts";
import { required } from "../util/required.ts";
import { nanogptTransportError } from "../llm/providers/nanogpt_config.ts";
import { keepaliveTtlWarning } from "../llm/cache_capability.ts";
import { parseCacheKeepalive } from "../config/keepalive.ts";

import {
  EffectiveCatalogError,
  findEffectiveModel,
  listEffectiveModels,
  type EffectiveModel,
} from "../config/effective_catalog.ts";
import { firstChatModel, resolvedModelToWire, sdkFromWire, type ResolvedModel, type Sdk } from "../config/models.ts";
import type { LoadedConfig } from "../config/loader.ts";
import {
  characterPreferencesPath,
  configView,
  emptyPreferences,
  globalPreferencesPath,
  loadForCharacter,
  loadPreferences,
  modelPreference,
  preferenceKey,
  resolveChatModelForCharacter,
  resolveSamplerSettings,
  resolveSamplerScopes,
  resolveSubagentBaseModel,
  resolveSubagentSampler,
  resolveSubagentScopes,
  addFavorite,
  isFavorite,
  removeFavorite,
  samplerIsEmpty,
  saveCharacterPreferences,
  saveGlobalPreferences,
  subagentModelPreference,
  subagentPreference,
  SAMPLER_KEYS,
  type BackgroundTask,
  type ModelPreferences,
  type SamplerScopes,
  type SamplerSettings,
} from "../config/preferences.ts";
import type { SubagentConfig } from "../config/app.ts";
import { SETTING_STORAGE_FIELDS, parsedSettingValue, samplerToWire, settingSchema } from "../llm/settings.ts";
import { missingModelMessage } from "../tools/subagent.ts";
import type { Env } from "../config/dirs.ts";
import {
  clearConfigKey,
  setConfigKey,
  type ConfigContext,
  type ConfigRuntime,
} from "./config.ts";
import { applySamplerValue, capabilityCheck } from "./model_settings.ts";
import { internalError, invalidRequest, notFound, type CommandError } from "./errors.ts";

export type Args = Record<string, unknown>;

export interface ModelsContext {
  config: LoadedConfig;
  dataDir: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  thread?: string;
  threadModel?: string;
  configPath?: string;
  runtime?: ConfigRuntime;
  env?: Env;
}

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

const asName = (v: unknown): string | undefined => {
  const s = asStr(v);
  return s === undefined || s === "" ? undefined : s;
};

function catalogError(e: unknown): CommandError {
  if (!(e instanceof EffectiveCatalogError)) {
    return internalError(e instanceof Error ? e.message : String(e));
  }
  return e.kind === "ambiguous" ? invalidRequest(e.message) : notFound(e.message);
}

function resolve(ctx: ModelsContext, name: string, includeHidden: boolean): ResolvedModel {
  try {
    return findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, name, includeHidden);
  } catch (e) {
    throw catalogError(e);
  }
}

const findEffective = (config: ReturnType<typeof configView>, cacheDir: string, name: string, includeHidden: boolean) =>
  findEffectiveModel(config, cacheDir, name, includeHidden);

function requireCharacter(ctx: ModelsContext): string {
  if (ctx.characterName === undefined) {
    throw invalidRequest("this command requires an attached character");
  }
  return ctx.characterName;
}

export function effectiveChatModel(
  config: LoadedConfig,
  character: string | undefined,
  threadModel?: string,
): ResolvedModel | undefined {
  if (character === undefined) return undefined;
  return resolveChatModelForCharacter(configView(config), character, findEffective, threadModel);
}

function resolveActiveModel(ctx: ModelsContext): ResolvedModel {
  const resolved = effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel);
  if (resolved !== undefined) return resolved;

  const fallback = ctx.config.app.defaults.model;
  if (fallback !== undefined) return resolve(ctx, fallback, true);

  const first = firstChatModel(ctx.config.models);
  if (first === undefined) throw invalidRequest("No model specified and no active model set");
  return first;
}

const BACKGROUND_TASKS: readonly BackgroundTask[] = ["heartbeat", "compaction"];

function backgroundTask(selector: string): BackgroundTask {
  if (selector === "heartbeat" || selector === "compaction") return selector;
  throw invalidRequest(
    `unknown background task: ${selector}; expected all, heartbeat, or compaction`,
  );
}

function backgroundTargetModel(ctx: ModelsContext, task: BackgroundTask): ResolvedModel {
  const pinned = ctx.config.app.defaults.background[task];
  if (pinned !== undefined) return resolve(ctx, pinned, true);

  const character = requireCharacter(ctx);
  const inherited = resolveChatModelForCharacter(
    configView(ctx.config), character, findEffective,
    task === "compaction" ? ctx.threadModel : undefined,
  );
  if (inherited === undefined) {
    throw notFound(
      `${task} has no configured model and the catalog has no chat model to inherit`,
    );
  }
  return inherited;
}

function backgroundSettingTarget(ctx: ModelsContext, selector: string): ResolvedModel {
  if (selector !== "all") return backgroundTargetModel(ctx, backgroundTask(selector));

  const resolved = BACKGROUND_TASKS.map(
    (task) => [task, backgroundTargetModel(ctx, task)] as const,
  );
  const first = required(resolved[0])[1];
  const same = resolved.every(
    ([, m]) => m.providerKey === first.providerKey && m.modelId === first.modelId,
  );
  if (same) return first;

  const mapping = resolved.map(([task, m]) => `${task} → ${m.qualifiedName}`).join(", ");
  throw invalidRequest(
    `background tasks use different models (${mapping}); target a specific task instead of \`all\``,
  );
}

export type SettingTarget =
  | { kind: "model"; model: ResolvedModel }
  | { kind: "subagent"; subagent: string; model: ResolvedModel }
  | { kind: "subagent_model"; model: ResolvedModel };

const ALL_SUBAGENTS = "all";

function requireSubagent(ctx: ModelsContext, subagent: string): SubagentConfig {
  const spec = ctx.config.app.subagents.get(subagent);
  if (spec !== undefined) return spec;
  const known = [...ctx.config.app.subagents.keys()].sort();
  const suffix = known.length === 0 ? "none are configured" : `known: ${known.join(", ")}`;
  throw notFound(`unknown sub-agent: ${subagent}; ${suffix}`);
}

function subagentTargetModel(ctx: ModelsContext, subagent: string): ResolvedModel {
  const spec = requireSubagent(ctx, subagent);

  let model: ResolvedModel | undefined;
  try {
    model = resolveSubagentBaseModel(
      configView(ctx.config),
      ctx.characterName,
      spec.model,
      findEffective,
    );
  } catch (e) {
    throw catalogError(e);
  }
  if (model === undefined) {
    throw invalidRequest(missingModelMessage(subagent, ctx.characterName));
  }
  return model;
}

function targetableSubagents(ctx: ModelsContext): string[] {
  const configured = [...ctx.config.app.subagents.keys()].sort();
  const enabled = configured.filter((name) =>
    ctx.config.app.tools.enabled_subagents.includes(name),
  );
  return enabled.length === 0 ? configured : enabled;
}

function sharedSubagentModel(ctx: ModelsContext): ResolvedModel {
  const names = targetableSubagents(ctx);
  if (names.length === 0) throw notFound("no sub-agents are configured");

  const resolved = names.map((name) => [name, subagentTargetModel(ctx, name)] as const);
  const first = required(resolved[0])[1];
  const same = resolved.every(
    ([, m]) => m.providerKey === first.providerKey && m.modelId === first.modelId,
  );
  if (same) return first;

  const mapping = resolved.map(([name, m]) => `${name} → ${m.qualifiedName}`).join(", ");
  throw invalidRequest(
    `sub-agents use different models (${mapping}); target one by name instead of \`all\``,
  );
}

function subagentSettingTarget(ctx: ModelsContext, subagent: string): SettingTarget {
  if (subagent === ALL_SUBAGENTS) {
    return { kind: "subagent_model", model: sharedSubagentModel(ctx) };
  }
  return {
    kind: "subagent",
    subagent,
    model: subagentTargetModel(ctx, subagent),
  };
}

function settingTarget(ctx: ModelsContext, args: Args): SettingTarget {
  const subagent = asName(args["subagent"]);
  if (subagent !== undefined) return subagentSettingTarget(ctx, subagent);

  const selector = asStr(args["background_task"]);
  if (selector !== undefined) {
    return { kind: "model", model: backgroundSettingTarget(ctx, selector) };
  }

  const name = asName(args["name"]);
  if (name !== undefined) return { kind: "model", model: resolve(ctx, name, true) };

  return { kind: "model", model: resolveActiveModel(ctx) };
}

function qualify(ctx: ModelsContext, name: string): string {
  try {
    return findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, name, true)
      .qualifiedName;
  } catch {
    return name;
  }
}

interface ModelRole {
  role: string;
  model: string | null;
  source: string | null;
}

function chatRole(ctx: ModelsContext): ModelRole {
  const resolved = effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel);
  if (resolved !== undefined) {
    return {
      role: "chat",
      model: resolved.qualifiedName,
      source: ctx.threadModel === undefined ? "character" : `thread ${ctx.thread ?? ""}`.trim(),
    };
  }
  const fallback = ctx.config.app.defaults.model;
  if (fallback !== undefined && fallback !== "") {
    return { role: "chat", model: qualify(ctx, fallback), source: "chat.model" };
  }
  const first = firstChatModel(ctx.config.models);
  if (first !== undefined) {
    return { role: "chat", model: first.qualifiedName, source: "first in catalog" };
  }
  return { role: "chat", model: null, source: null };
}

function backgroundRole(ctx: ModelsContext, task: BackgroundTask, chat: ModelRole): ModelRole {
  const bg = ctx.config.app.defaults.background;
  const perTask = bg[task];
  if (perTask !== undefined) {
    return { role: task, model: qualify(ctx, perTask), source: `${task}.model` };
  }
  return { role: task, model: chat.model, source: chat.model === null ? null : "inherits chat" };
}

function subagentRole(ctx: ModelsContext, chat: ModelRole): ModelRole {
  const subagentModel = ctx.config.app.defaults.subagent_model;
  const overrides = [...ctx.config.app.subagents.values()].filter(
    (sub) => sub.model !== undefined,
  ).length;
  const suffix = overrides === 0 ? "" : ` · ${overrides} override`;

  if (subagentModel !== undefined) {
    return {
      role: "sub-agents",
      model: qualify(ctx, subagentModel),
      source: `subagents.model${suffix}`,
    };
  }
  if (chat.model === null) {
    return { role: "sub-agents", model: null, source: overrides === 0 ? null : suffix.trim() };
  }
  return { role: "sub-agents", model: chat.model, source: `inherits chat${suffix}` };
}

function configuredRole(ctx: ModelsContext, role: string, key: string): ModelRole {
  const name = ctx.config.app.defaults[key as "embedding" | "image_generation"];
  if (name === undefined || name === "") return { role, model: null, source: null };
  return { role, model: qualify(ctx, name), source: key === "embedding" ? "embedding.model" : "image.model" };
}

export function modelRoles(ctx: ModelsContext): ModelRole[] {
  const chat = chatRole(ctx);
  return [
    chat,
    ...BACKGROUND_TASKS.map((task) => backgroundRole(ctx, task, chat)),
    subagentRole(ctx, chat),
    configuredRole(ctx, "embedding", "embedding"),
    configuredRole(ctx, "images", "image_generation"),
  ];
}

function effectiveModelToJson(entry: EffectiveModel, favorites: ReadonlySet<string>): unknown {
  const m = entry.resolved;
  return {
    name: m.name,
    qualified_name: m.qualifiedName,
    sdk: m.sdk,
    model_id: m.modelId,
    source: entry.source,
    hidden: entry.hidden,
    favorite: favorites.has(m.qualifiedName),
    ...(entry.subscriptionIncluded === undefined
      ? {}
      : { subscription_included: entry.subscriptionIncluded }),
  };
}

function modelsByProvider(
  entries: EffectiveModel[],
  favorites: ReadonlySet<string>,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const entry of entries) {
    (out[entry.resolved.providerKey] ??= []).push(effectiveModelToJson(entry, favorites));
  }
  return out;
}

function favoriteNames(ctx: ModelsContext): Set<string> {
  return new Set(loadGlobalPreferences(ctx).favorites);
}

function activeName(ctx: ModelsContext): string | undefined {
  const resolved = effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel);
  if (resolved !== undefined) return resolved.qualifiedName;

  const fallback = ctx.config.app.defaults.model;
  if (fallback === undefined || fallback === "") {
    return firstChatModel(ctx.config.models)?.qualifiedName;
  }
  try {
    return findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, fallback, true)
      .qualifiedName;
  } catch {
    return fallback;
  }
}

function favoritesOutsideTheWalk(
  ctx: ModelsContext,
  view: ReturnType<typeof configView>,
  favorites: ReadonlySet<string>,
  walked: EffectiveModel[],
): EffectiveModel[] {
  const seen = new Set(walked.map((e) => e.resolved.qualifiedName));
  const out: EffectiveModel[] = [];
  for (const favorite of favorites) {
    try {
      const resolved = findEffectiveModel(view, ctx.config.dirs.cache, favorite, true);
      if (seen.has(resolved.qualifiedName)) continue;
      seen.add(resolved.qualifiedName);
      out.push({ source: "favorite", resolved, hidden: false });
    } catch {
      continue;
    }
  }
  return out;
}

export function listModels(ctx: ModelsContext, args: Args): unknown {
  const favoritesOnly = asBool(args["favorites_only"]) ?? false;
  const includeHidden = asBool(args["include_hidden"]) ?? false;
  const view = configView(ctx.config);
  const favorites = favoriteNames(ctx);

  const walked = listEffectiveModels(view, ctx.config.dirs.cache, true);
  const all = [...walked, ...favoritesOutsideTheWalk(ctx, view, favorites, walked)];
  const shown = all.filter((e) => {
    const favorite = favorites.has(e.resolved.qualifiedName);
    if (favoritesOnly) return favorite;
    return includeHidden || !e.hidden || favorite;
  });
  const hiddenCount = all.filter(
    (e) => e.hidden && !favorites.has(e.resolved.qualifiedName),
  ).length;

  return {
    models: modelsByProvider(shown, favorites),
    active: activeName(ctx) ?? null,
    roles: modelRoles(ctx),
    include_hidden: includeHidden,
    favorites_only: favoritesOnly,
    favorite_count: favorites.size,
    hidden_count: hiddenCount,
  };
}

export function favoriteModel(ctx: ModelsContext, args: Args): unknown {
  const name = asName(args["name"]);
  if (name === undefined) throw invalidRequest("missing model name");

  const resolved = resolve(ctx, name, true);
  const prefs = loadGlobalPreferences(ctx);
  const want = asBool(args["favorite"]) ?? !isFavorite(prefs, resolved.qualifiedName);
  const changed = want
    ? addFavorite(prefs, resolved.qualifiedName)
    : removeFavorite(prefs, resolved.qualifiedName);
  if (changed) saveGlobal(ctx, prefs);

  return {
    qualified_name: resolved.qualifiedName,
    provider: resolved.providerKey,
    model_id: resolved.modelId,
    favorite: want,
    changed,
    favorites: [...prefs.favorites],
  };
}

const INFO_SCOPE_FIELDS = [
  ["temperature", "temperature"],
  ["top_p", "topP"],
  ["reasoning_effort", "reasoningEffort"],
  ["reasoning_budget_tokens", "budgetTokens"],
  ["max_output_tokens", "maxOutputTokens"],
  ["cache_ttl", "cacheTtl"],
  ["cache_keepalive", "cacheKeepalive"],
  ["cache_keepalive_pings", "cacheKeepalivePings"],
  ["sdk", "sdk"],
  ["reasoning_replay", "replayPriorThinking"],
  ["max_tool_rounds", "maxToolIterations"],
] as const satisfies readonly (readonly [string, keyof SamplerSettings])[];

function scopesJson(
  scopes: SamplerScopes,
  fields: readonly (readonly [string, keyof SamplerSettings])[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, field] of fields) out[key] = scopes[field] ?? null;
  return out;
}

function samplerJson(sampler: SamplerSettings): Record<string, unknown> {
  return samplerToWire(sampler, true);
}

function targetedRole(args: Args): boolean {
  return asName(args["subagent"]) !== undefined || asStr(args["background_task"]) !== undefined;
}

export function modelInfo(ctx: ModelsContext, args: Args): unknown {
  const name = asName(args["name"]);
  const byRole = targetedRole(args);
  if (name !== undefined && byRole) {
    throw invalidRequest("name a model or name a role, not both");
  }

  const resolved = byRole
    ? settingTarget(ctx, args).model
    : name === undefined
      ? resolveActiveModel(ctx)
      : resolve(ctx, name, true);
  const data = resolvedModelToWire(resolved);

  const character = ctx.characterName;
  if (character !== undefined) {
    const [global, charPrefs] = loadPreferencesFor(ctx.dataDir, character);
    data["effective_sampler"] = samplerJson(
      resolveSamplerSettings(global, charPrefs, resolved.providerKey, resolved.modelId, resolved),
    );
    data["scopes"] = scopesJson(
      resolveSamplerScopes(global, charPrefs, resolved.providerKey, resolved.modelId, resolved),
      INFO_SCOPE_FIELDS,
    );
  }
  return data;
}

function loadPreferencesFor(
  dataDir: string,
  character: string,
): [ModelPreferences, ModelPreferences] {
  try {
    return loadForCharacter(dataDir, character);
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }
}

const backgroundKeys = (selector: string): string[] =>
  selector === "all"
    ? BACKGROUND_TASKS.map((task) => `${task}.model`)
    : [`${backgroundTask(selector)}.model`];

function configContext(ctx: ModelsContext): ConfigContext {
  if (ctx.configPath === undefined || ctx.runtime === undefined) {
    throw internalError("background model changes need a config-backed session");
  }
  return ctx as ConfigContext & { configPath: string; runtime: ConfigRuntime };
}

function pinBackgroundModel(ctx: ModelsContext, selector: string, args: Args): unknown {
  const name = asName(args["name"]);
  if (name === undefined) throw invalidRequest("missing model name");

  const includeHidden = asBool(args["include_hidden"]) ?? false;
  const resolved = resolve(ctx, name, includeHidden);
  const config = configContext(ctx);

  const keys = backgroundKeys(selector);
  const key = keys[0] as string;
  const written = setConfigKey(config, key, resolved.qualifiedName);
  for (const other of keys.slice(1)) setConfigKey(config, other, resolved.qualifiedName);

  return {
    active: resolved.qualifiedName,
    qualified_name: resolved.qualifiedName,
    provider: resolved.providerKey,
    model_id: resolved.modelId,
    changed: true,
    role: selector === "all" ? "background" : selector,
    config_key: key,
    config_keys: keys,
    cleared: [],
    file: written.file,
    restart_required: written.restart_required,
  };
}

function unpinBackgroundModel(ctx: ModelsContext, selector: string): unknown {
  const config = configContext(ctx);
  const keys = backgroundKeys(selector);

  const cleared: string[] = [];
  let file: string | undefined;
  for (const key of keys) {
    const removed = clearConfigKey(config, key);
    file = removed.file;
    if (removed.action === "removed") cleared.push(key);
  }

  const chat = chatRole(ctx);
  const task = selector === "all" ? "heartbeat" : backgroundTask(selector);
  const role = backgroundRole(ctx, task, chat);

  return {
    active: role.model,
    role: selector === "all" ? "background" : selector,
    cleared,
    source: role.source,
    file: file ?? null,
    reset_to: role.source ?? "config default",
  };
}

const SUBAGENT_MODEL_KEY = "subagents.model";

const subagentModelKey = (name: string): string => `subagents.${name}.model`;

function subagentsWithOwnModel(ctx: ModelsContext): string[] {
  return [...ctx.config.app.subagents.entries()]
    .filter(([, spec]) => spec.model !== undefined)
    .map(([name]) => name)
    .sort();
}

function subagentRoleName(selector: string): string {
  return selector === ALL_SUBAGENTS ? "sub-agents" : `sub-agent: ${selector}`;
}

function pinSubagentModel(ctx: ModelsContext, selector: string, args: Args): unknown {
  const name = asName(args["name"]);
  if (name === undefined) throw invalidRequest("missing model name");

  if (selector !== ALL_SUBAGENTS) requireSubagent(ctx, selector);
  const includeHidden = asBool(args["include_hidden"]) ?? false;
  const resolved = resolve(ctx, name, includeHidden);
  const config = configContext(ctx);

  const overridden = selector === ALL_SUBAGENTS ? subagentsWithOwnModel(ctx) : [];
  const key = selector === ALL_SUBAGENTS ? SUBAGENT_MODEL_KEY : subagentModelKey(selector);
  const written = setConfigKey(config, key, resolved.qualifiedName);
  const cleared = overridden.map((each) => clearConfigKey(config, subagentModelKey(each)).set);

  return {
    active: resolved.qualifiedName,
    qualified_name: resolved.qualifiedName,
    provider: resolved.providerKey,
    model_id: resolved.modelId,
    changed: true,
    role: subagentRoleName(selector),
    config_key: key,
    cleared,
    file: written.file,
    restart_required: written.restart_required,
  };
}

function unpinSubagentModel(ctx: ModelsContext, selector: string): unknown {
  if (selector !== ALL_SUBAGENTS) requireSubagent(ctx, selector);
  const config = configContext(ctx);

  const keys =
    selector === ALL_SUBAGENTS
      ? [SUBAGENT_MODEL_KEY, ...subagentsWithOwnModel(ctx).map(subagentModelKey)]
      : [subagentModelKey(selector)];

  const cleared: string[] = [];
  let file: string | undefined;
  for (const key of keys) {
    const removed = clearConfigKey(config, key);
    file = removed.file;
    if (removed.action === "removed") cleared.push(key);
  }

  const role = subagentRole(ctx, chatRole(ctx));
  return {
    active: role.model,
    role: subagentRoleName(selector),
    cleared,
    source: role.source,
    file: file ?? null,
    reset_to: role.source ?? "config default",
  };
}

export async function changeThreadModel(
  ctx: ModelsContext,
  args: Args,
  setModel: (model: string | undefined) => Promise<unknown>,
  reset = false,
): Promise<unknown> {
  if (reset) {
    await setModel(undefined);
    return {
      active: effectiveChatModel(ctx.config, ctx.characterName)?.qualifiedName ?? null,
      reset_to: "character default",
    };
  }
  const name = asStr(args["name"]);
  if (name === undefined) return switchModel(ctx, args);
  const resolved = resolve(ctx, name, asBool(args["include_hidden"]) ?? false);
  await setModel(resolved.qualifiedName);
  return {
    active: resolved.qualifiedName,
    qualified_name: resolved.qualifiedName,
    provider: resolved.providerKey,
    model_id: resolved.modelId,
    changed: true,
  };
}

export function switchModel(ctx: ModelsContext, args: Args): unknown {
  const subagent = asName(args["subagent"]);
  if (subagent !== undefined) return pinSubagentModel(ctx, subagent, args);

  const selector = asStr(args["background_task"]);
  if (selector !== undefined) return pinBackgroundModel(ctx, selector, args);

  const name = asStr(args["name"]);
  if (name === undefined) {
    return {
      active:
        effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel)?.qualifiedName ?? null,
    };
  }

  const includeHidden = asBool(args["include_hidden"]) ?? false;
  const resolved = resolve(ctx, name, includeHidden);

  const character = requireCharacter(ctx);
  const prefs = loadCharacterPreferences(ctx, character);
  prefs.selected.provider = resolved.providerKey;
  prefs.selected.modelId = resolved.modelId;
  saveCharacter(ctx, character, prefs);

  return {
    active: name,
    qualified_name: resolved.qualifiedName,
    provider: resolved.providerKey,
    model_id: resolved.modelId,
    changed: true,
    ...(ctx.threadModel === undefined ? {} : { shadowed_by_thread: ctx.thread ?? null }),
  };
}

export function resetModel(ctx: ModelsContext, args: Args = {}): unknown {
  const subagent = asName(args["subagent"]);
  if (subagent !== undefined) return unpinSubagentModel(ctx, subagent);

  const selector = asStr(args["background_task"]);
  if (selector !== undefined) return unpinBackgroundModel(ctx, selector);

  const character = requireCharacter(ctx);
  const prefs = loadCharacterPreferences(ctx, character);
  const previous = { ...prefs.selected };
  prefs.selected = {};
  saveCharacter(ctx, character, prefs);

  return {
    previous_provider: previous.provider ?? null,
    previous_model_id: previous.modelId ?? null,
    active: null,
    reset_to: "config default",
  };
}

function loadCharacterPreferences(ctx: ModelsContext, character: string): ModelPreferences {
  try {
    return loadPreferences(characterPreferencesPath(ctx.dataDir, character));
  } catch (e) {
    throw internalError(`Failed to load preferences: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function saveCharacter(ctx: ModelsContext, character: string, prefs: ModelPreferences): void {
  try {
    saveCharacterPreferences(ctx.dataDir, character, prefs);
  } catch (e) {
    throw internalError(`Failed to save preferences: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function setModelSetting(ctx: ModelsContext, args: Args): unknown {
  const rawKey = asStr(args["key"]);
  if (rawKey === undefined) throw invalidRequest("missing key");
  const key = canonicalSettingKey(rawKey.trim());
  if (!SAMPLER_KEYS.includes(key)) {
    throw invalidRequest(`unknown setting key: ${key}; supported: ${SAMPLER_KEYS.join(", ")}`);
  }

  const rawValue = "value" in args ? args["value"] : null;
  const value = rawKey.trim() === "gemini_generation" ? geminiMode(typeof rawValue === "string" && /^\d+$/.test(rawValue) ? Number(rawValue) : rawValue) : rawValue;
  const scope = asStr(args["scope"]) ?? "character";
  if (scope !== "character" && scope !== "global") {
    throw invalidRequest(`scope must be "character" or "global", got ${JSON.stringify(scope)}`);
  }

  const target = settingTarget(ctx, args);
  const model = target.model;
  const character = scope === "character" ? requireCharacter(ctx) : undefined;
  const prefs =
    character === undefined ? loadGlobalPreferences(ctx) : loadCharacterPreferences(ctx, character);
  const global = character === undefined ? prefs : loadGlobalPreferences(ctx);
  const charPrefs = character === undefined ? undefined : prefs;
  const current = target.kind === "model"
    ? resolveSamplerSettings(global, charPrefs, model.providerKey, model.modelId, model)
    : resolveSubagentSampler(global, charPrefs, target.kind === "subagent" ? target.subagent : undefined,
        model.providerKey, model.modelId, model);
  const sdk = sdkFromWire(current.sdk ?? model.sdk) ?? model.sdk;
  const failure = capabilityCheck(sdk, key, value, model.support, model.modelId);
  if (failure !== undefined) throw failure;
  if (key === "sdk" && value === "gemini") {
    const error = nanogptTransportError(model.providerKey, value);
    if (error !== undefined) throw invalidRequest(error);
  }
  const warning = keepaliveWarningAfter(sdk, model.modelId, current, key, value);

  const slot =
    target.kind === "subagent"
      ? prefs.subagents
      : target.kind === "subagent_model"
        ? prefs.subagentModels
        : prefs.models;
  const entryKey =
    target.kind === "subagent" ? target.subagent : preferenceKey(model.providerKey, model.modelId);
  const entry = slot.get(entryKey) ?? { sampler: {} };
  applySamplerValue(entry.sampler, key, value);

  if (samplerIsEmpty(entry.sampler)) slot.delete(entryKey);
  else slot.set(entryKey, entry);

  if (character === undefined) saveGlobal(ctx, prefs);
  else saveCharacter(ctx, character, prefs);

  return {
    changed: true,
    scope,
    model: model.qualifiedName,
    provider: model.providerKey,
    model_id: model.modelId,
    ...targetJson(target),
    ...aliasedRolesJson(ctx, args, model),
    key,
    value,
    ...(warning === undefined ? {} : { warning }),
  };
}

function keepaliveWarningAfter(
  sdk: Sdk,
  modelId: string,
  current: SamplerSettings,
  key: string,
  value: unknown,
): string | undefined {
  if (key !== "cache_keepalive" && key !== "cache_ttl") return undefined;
  const cadence = key === "cache_keepalive"
    ? typeof value === "string" ? parseCacheKeepalive(value) : undefined
    : current.cacheKeepalive === undefined ? undefined : { ok: current.cacheKeepalive };
  if (cadence === undefined || "err" in cadence || cadence.ok.kind === "off") return undefined;
  const parsedTtl = key === "cache_ttl" ? parsedSettingValue(key, value) : undefined;
  const ttl = parsedTtl === undefined
    ? current.cacheTtl
    : "value" in parsedTtl && typeof parsedTtl.value === "string" ? parsedTtl.value : undefined;
  return keepaliveTtlWarning(sdk, modelId, ttl, cadence.ok.interval.asMillis());
}

const SAMPLER_ROLES = ["chat", "heartbeat", "compaction", "sub-agents"];

function aliasedRolesJson(
  ctx: ModelsContext,
  args: Args,
  model: ResolvedModel,
): Record<string, unknown> {
  const selector = asStr(args["background_task"]);
  if (selector === undefined) return {};

  const targeted = new Set<string>(
    selector === "all" ? [...BACKGROUND_TASKS] : [backgroundTask(selector)],
  );
  const shared = modelRoles(ctx)
    .filter((role) => SAMPLER_ROLES.includes(role.role) && !targeted.has(role.role))
    .filter((role) => sharesPreferenceKey(ctx, role.model, model))
    .map((role) => role.role);

  return shared.length === 0 ? {} : { background_task: selector, also_affects: shared };
}

function sharesPreferenceKey(
  ctx: ModelsContext,
  name: string | null,
  model: ResolvedModel,
): boolean {
  if (name === null) return false;
  try {
    const other = resolve(ctx, name, true);
    return other.providerKey === model.providerKey && other.modelId === model.modelId;
  } catch {
    return false;
  }
}

function targetJson(target: SettingTarget): Record<string, unknown> {
  switch (target.kind) {
    case "subagent":
      return { subagent: target.subagent };
    case "subagent_model":
      return { subagent: ALL_SUBAGENTS, applies_to: "every sub-agent on this model" };
    case "model":
      return {};
  }
}

function loadGlobalPreferences(ctx: ModelsContext): ModelPreferences {
  try {
    return loadPreferences(globalPreferencesPath(ctx.dataDir));
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }
}

function saveGlobal(ctx: ModelsContext, prefs: ModelPreferences): void {
  try {
    saveGlobalPreferences(ctx.dataDir, prefs);
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }
}

const SETTINGS_SCOPE_FIELDS = SETTING_STORAGE_FIELDS.map(
  ([field, key]) => [key, field] as const,
);

interface OverviewSetting {
  key: string;
  value: unknown;
  scope: "character" | "global";
}

interface OverviewRole {
  role: string;
  flag: string;
  model: string | null;
  source: string | null;
  inherited: boolean;
  settings: OverviewSetting[];
  same_settings_as: string | null;
  error: string | null;
}

interface OverviewSlot {
  role: string;
  flag: string;
  source: string | null;
  resolve: () => SettingTarget;
}

function preferenceEntryFor(
  target: SettingTarget,
  prefs: ModelPreferences,
): { sampler: SamplerSettings } | undefined {
  switch (target.kind) {
    case "subagent":
      return subagentPreference(prefs, target.subagent);
    case "subagent_model":
      return subagentModelPreference(prefs, target.model.providerKey, target.model.modelId);
    case "model":
      return modelPreference(prefs, target.model.providerKey, target.model.modelId);
  }
}

function preferenceIdentity(target: SettingTarget): string {
  const key = preferenceKey(target.model.providerKey, target.model.modelId);
  switch (target.kind) {
    case "subagent":
      return `subagent:${target.subagent}`;
    case "subagent_model":
      return `subagent-model:${key}`;
    case "model":
      return `model:${key}`;
  }
}

function savedSettingsFor(
  target: SettingTarget,
  global: ModelPreferences,
  charPrefs: ModelPreferences | undefined,
): OverviewSetting[] {
  const found = new Map<string, OverviewSetting>();
  const collect = (prefs: ModelPreferences | undefined, scope: "character" | "global"): void => {
    if (prefs === undefined) return;
    const entry = preferenceEntryFor(target, prefs);
    if (entry === undefined) return;
    const wire = samplerToWire(entry.sampler);
    for (const key of SAMPLER_KEYS) {
      const value = wire[key];
      if (value !== undefined) found.set(key, { key, value, scope });
    }
  };
  collect(global, "global");
  collect(charPrefs, "character");
  return [...found.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function overviewSlots(ctx: ModelsContext): OverviewSlot[] {
  const chat = chatRole(ctx);
  const slots: OverviewSlot[] = [
    {
      role: "chat",
      flag: "--chat",
      source: chat.source,
      resolve: () => ({ kind: "model", model: resolveActiveModel(ctx) }),
    },
  ];

  for (const task of BACKGROUND_TASKS) {
    slots.push({
      role: task,
      flag: `--background=${task}`,
      source: backgroundRole(ctx, task, chat).source,
      resolve: () => ({ kind: "model", model: backgroundTargetModel(ctx, task) }),
    });
  }

  slots.push({
    role: "sub-agents",
    flag: "--subagent",
    source: subagentRole(ctx, chat).source,
    resolve: () => ({ kind: "subagent_model", model: sharedSubagentModel(ctx) }),
  });

  for (const name of [...ctx.config.app.subagents.keys()].sort()) {
    const own = ctx.config.app.subagents.get(name)?.model;
    slots.push({
      role: `sub-agent: ${name}`,
      flag: `--subagent=${name}`,
      source: own === undefined ? "inherits sub-agents" : subagentModelKey(name),
      resolve: () => subagentSettingTarget(ctx, name),
    });
  }

  return slots;
}

export function modelSettingsOverview(ctx: ModelsContext): unknown {
  const character = ctx.characterName;
  const [global, charPrefs] =
    character === undefined
      ? [emptyPreferences(), undefined]
      : loadPreferencesFor(ctx.dataDir, character);

  const claimed = new Map<string, string>();
  const roles: OverviewRole[] = [];

  for (const slot of overviewSlots(ctx)) {
    let target: SettingTarget | undefined;
    let error: string | null = null;
    try {
      target = slot.resolve();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const identity = target === undefined ? undefined : preferenceIdentity(target);
    const sharesWith = identity === undefined ? null : (claimed.get(identity) ?? null);
    if (identity !== undefined && sharesWith === null) claimed.set(identity, slot.role);

    roles.push({
      role: slot.role,
      flag: slot.flag,
      model: target?.model.qualifiedName ?? null,
      source: slot.source,
      inherited: slot.source === null || slot.source.startsWith("inherits"),
      settings: target === undefined ? [] : savedSettingsFor(target, global, charPrefs),
      same_settings_as: sharesWith,
      error,
    });
  }

  const worthShowing = (row: OverviewRole): boolean =>
    row.role === "chat" || row.error !== null || !row.inherited || row.settings.length > 0;

  const shown = roles.filter(worthShowing);
  return {
    overview: true,
    character: character ?? null,
    roles: shown,
    inherited_count: roles.length - shown.length,
  };
}

function requestedKey(ctx: ModelsContext, args: Args): string | undefined {
  const raw = asName(args["key"]);
  if (raw === undefined) return undefined;
  const key = canonicalSettingKey(raw.trim());
  if (SAMPLER_KEYS.includes(key)) return key;
  if (ctx.config.app.subagents.has(key)) {
    throw invalidRequest(
      `${key} is a sub-agent, not a setting; write --subagent=${key} to target it`,
    );
  }
  throw invalidRequest(`unknown setting key: ${key}; supported: ${SAMPLER_KEYS.join(", ")}`);
}

export function modelSettings(ctx: ModelsContext, args: Args): unknown {
  if (asBool(args["overview"]) === true) return modelSettingsOverview(ctx);

  const only = requestedKey(ctx, args);
  const target = settingTarget(ctx, args);
  const model = target.model;
  const character = ctx.characterName;
  const [global, charPrefs] =
    character === undefined
      ? [emptyPreferences(), undefined]
      : loadPreferencesFor(ctx.dataDir, character);

  const subagentName = target.kind === "subagent" ? target.subagent : undefined;
  const sampler =
    target.kind === "model"
      ? resolveSamplerSettings(global, charPrefs, model.providerKey, model.modelId, model)
      : resolveSubagentSampler(
          global,
          charPrefs,
          subagentName,
          model.providerKey,
          model.modelId,
          model,
        );
  const scopes =
    target.kind === "model"
      ? resolveSamplerScopes(global, charPrefs, model.providerKey, model.modelId, model)
      : resolveSubagentScopes(
          global,
          charPrefs,
          subagentName,
          model.providerKey,
          model.modelId,
          model,
        );
  const saved = (prefs: ModelPreferences | undefined): unknown => {
    if (prefs === undefined) return null;
    const entry =
      target.kind === "subagent"
        ? subagentPreference(prefs, target.subagent)
        : target.kind === "subagent_model"
          ? subagentModelPreference(prefs, model.providerKey, model.modelId)
          : modelPreference(prefs, model.providerKey, model.modelId);
    return entry === undefined ? null : samplerJson(entry.sampler);
  };

  return {
    model: model.qualifiedName,
    provider: model.providerKey,
    model_id: model.modelId,
    ...targetJson(target),
    ...(only === undefined ? {} : { key: only }),
    effective_sampler: samplerJson(sampler),
    saved_global: saved(global),
    saved_character: saved(charPrefs),
    setting_schema: settingSchema(sdkFromWire(sampler.sdk ?? model.sdk) ?? model.sdk, model.support, model.modelId),
    scopes: scopesJson(scopes, SETTINGS_SCOPE_FIELDS),
  };
}
