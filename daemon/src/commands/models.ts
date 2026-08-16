import {
  EffectiveCatalogError,
  findEffectiveModel,
  listEffectiveModels,
  type EffectiveModel,
} from "../config/effective_catalog.ts";
import { firstChatModel, resolvedModelToWire, type ResolvedModel } from "../config/models.ts";
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
  resolveSubagentSampler,
  resolveSubagentScopes,
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
import { reasoningDomain } from "../llm/capabilities.ts";
import { missingModelMessage, resolveSubagentModel } from "../tools/subagent.ts";
import { applySamplerValue, capabilityCheck, keyApplicability } from "./model_settings.ts";
import { internalError, invalidRequest, notFound, type CommandError } from "./errors.ts";

export type Args = Record<string, unknown>;

export interface ModelsContext {
  config: LoadedConfig;
  dataDir: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  activeResolvedModel: ResolvedModel | undefined;
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
): ResolvedModel | undefined {
  if (character === undefined) return undefined;
  return resolveChatModelForCharacter(configView(config), character, findEffective);
}

function resolveActiveModel(ctx: ModelsContext): ResolvedModel {
  const resolved = effectiveChatModel(ctx.config, ctx.characterName);
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
  const pinned = ctx.config.app.defaults.background[task] ?? ctx.config.app.defaults.background.model;
  if (pinned !== undefined) return resolve(ctx, pinned, true);

  const character = requireCharacter(ctx);
  const inherited = resolveChatModelForCharacter(configView(ctx.config), character, findEffective);
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
  const first = resolved[0]![1];
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

function subagentModelName(ctx: ModelsContext, subagent: string): string {
  const spec = ctx.config.app.subagents.get(subagent);
  if (spec === undefined) {
    const known = [...ctx.config.app.subagents.keys()].sort();
    const suffix = known.length === 0 ? "none are configured" : `known: ${known.join(", ")}`;
    throw notFound(`unknown sub-agent: ${subagent}; ${suffix}`);
  }

  const modelName = resolveSubagentModel(spec.model, {
    ...(ctx.config.app.defaults.subagent_model === undefined
      ? {}
      : { subagent_model: ctx.config.app.defaults.subagent_model }),
    ...(ctx.config.app.defaults.model === undefined
      ? {}
      : { model: ctx.config.app.defaults.model }),
  });
  if (modelName === undefined) throw invalidRequest(missingModelMessage(subagent));
  return modelName;
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

  const resolved = names.map((name) => [name, resolve(ctx, subagentModelName(ctx, name), true)] as const);
  const first = resolved[0]![1];
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
    model: resolve(ctx, subagentModelName(ctx, subagent), true),
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
  const resolved = effectiveChatModel(ctx.config, ctx.characterName);
  if (resolved !== undefined) {
    return { role: "chat", model: resolved.qualifiedName, source: "character" };
  }
  const fallback = ctx.config.app.defaults.model;
  if (fallback !== undefined && fallback !== "") {
    return { role: "chat", model: qualify(ctx, fallback), source: "defaults.model" };
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
    return { role: task, model: qualify(ctx, perTask), source: `defaults.background.${task}` };
  }
  if (bg.model !== undefined) {
    return { role: task, model: qualify(ctx, bg.model), source: "defaults.background.model" };
  }
  return { role: task, model: chat.model, source: chat.model === null ? null : "inherits chat" };
}

function subagentRole(ctx: ModelsContext): ModelRole {
  const defaults = ctx.config.app.defaults;
  const overrides = [...ctx.config.app.subagents.values()].filter(
    (sub) => sub.model !== undefined,
  ).length;
  const suffix = overrides === 0 ? "" : ` · ${overrides} override`;

  if (defaults.subagent_model !== undefined) {
    return {
      role: "sub-agents",
      model: qualify(ctx, defaults.subagent_model),
      source: `defaults.subagent_model${suffix}`,
    };
  }
  if (defaults.model !== undefined && defaults.model !== "") {
    return {
      role: "sub-agents",
      model: qualify(ctx, defaults.model),
      source: `defaults.model${suffix}`,
    };
  }
  return { role: "sub-agents", model: null, source: overrides === 0 ? null : suffix.trim() };
}

function configuredRole(ctx: ModelsContext, role: string, key: string): ModelRole {
  const name = ctx.config.app.defaults[key as "embedding" | "image_generation"];
  if (name === undefined || name === "") return { role, model: null, source: null };
  return { role, model: qualify(ctx, name), source: `defaults.${key}` };
}

export function modelRoles(ctx: ModelsContext): ModelRole[] {
  const chat = chatRole(ctx);
  return [
    chat,
    ...BACKGROUND_TASKS.map((task) => backgroundRole(ctx, task, chat)),
    subagentRole(ctx),
    configuredRole(ctx, "embedding", "embedding"),
    configuredRole(ctx, "images", "image_generation"),
  ];
}

function effectiveModelToJson(entry: EffectiveModel): unknown {
  const m = entry.resolved;
  return {
    name: m.name,
    qualified_name: m.qualifiedName,
    sdk: m.sdk,
    provider: m.providerKey,
    model_id: m.modelId,
    source: entry.source,
    hidden: entry.hidden,
  };
}

function activeName(ctx: ModelsContext, entries: EffectiveModel[]): string | undefined {
  const resolved = effectiveChatModel(ctx.config, ctx.characterName);
  if (resolved !== undefined) return resolved.qualifiedName;

  const fallback = ctx.config.app.defaults.model;
  if (fallback !== undefined && fallback !== "") {
    try {
      return findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, fallback, true)
        .qualifiedName;
    } catch {
      return fallback;
    }
  }

  return entries[0]?.resolved.qualifiedName;
}

export function listModels(ctx: ModelsContext, args: Args): unknown {
  const includeHidden = asBool(args["include_hidden"]) ?? false;
  const view = configView(ctx.config);
  const entries = listEffectiveModels(view, ctx.config.dirs.cache, includeHidden);

  const hiddenCount = (includeHidden
    ? entries
    : listEffectiveModels(view, ctx.config.dirs.cache, true)
  ).filter((e) => e.hidden).length;

  return {
    models: entries.map(effectiveModelToJson),
    active: activeName(ctx, entries) ?? null,
    roles: modelRoles(ctx),
    include_hidden: includeHidden,
    hidden_count: hiddenCount,
  };
}

const INFO_SCOPE_FIELDS = [
  ["temperature", "temperature"],
  ["top_p", "topP"],
  ["reasoning_effort", "reasoningEffort"],
  ["budget_tokens", "budgetTokens"],
  ["max_output_tokens", "maxOutputTokens"],
  ["cache_ttl", "cacheTtl"],
  ["cache_keepalive", "cacheKeepalive"],
  ["sdk", "sdk"],
  ["replay_prior_thinking", "replayPriorThinking"],
  ["max_tool_iterations", "maxToolIterations"],
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
  const wire = samplerToWire(sampler);
  const out: Record<string, unknown> = {};
  for (const key of SAMPLER_KEYS) out[key] = wire[key] ?? null;
  return out;
}

function samplerToWire(s: SamplerSettings): Record<string, unknown> {
  const keepalive = s.cacheKeepalive;
  return {
    temperature: s.temperature,
    top_p: s.topP,
    reasoning_effort: s.reasoningEffort,
    budget_tokens: s.budgetTokens,
    max_output_tokens: s.maxOutputTokens,
    cache_ttl: s.cacheTtl,
    cache_keepalive:
      keepalive === undefined
        ? undefined
        : keepalive.kind === "off"
          ? "off"
          : keepalive.interval.toString(),
    sdk: s.sdk,
    replay_prior_thinking: s.replayPriorThinking,
    max_tool_iterations: s.maxToolIterations,
    openrouter_provider: s.openrouterProvider,
    gemini_generation: s.geminiGeneration,
    zai_clear_thinking: s.zaiClearThinking,
    zai_subscription: s.zaiSubscription,
  };
}

export function modelInfo(ctx: ModelsContext, args: Args): unknown {
  const name = asName(args["name"]);
  const resolved = name === undefined ? resolveActiveModel(ctx) : resolve(ctx, name, true);
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

export function switchModel(ctx: ModelsContext, args: Args): unknown {
  const name = asStr(args["name"]);
  if (name === undefined) {
    return { active: effectiveChatModel(ctx.config, ctx.characterName)?.qualifiedName ?? null };
  }

  const includeHidden = asBool(args["include_hidden"]) ?? false;
  const resolved = resolve(ctx, name, includeHidden);

  const character = requireCharacter(ctx);
  const prefs = loadCharacterPreferences(ctx, character);
  prefs.selected.provider = resolved.providerKey;
  prefs.selected.modelId = resolved.modelId;
  saveCharacter(ctx, character, prefs);

  ctx.activeModel = name;
  ctx.activeResolvedModel = resolved;
  return {
    active: name,
    qualified_name: resolved.qualifiedName,
    provider: resolved.providerKey,
    model_id: resolved.modelId,
    changed: true,
  };
}

export function resetModel(ctx: ModelsContext): unknown {
  const character = requireCharacter(ctx);
  const prefs = loadCharacterPreferences(ctx, character);
  const previous = { ...prefs.selected };
  prefs.selected = {};
  saveCharacter(ctx, character, prefs);

  const previousActive = ctx.activeModel;
  ctx.activeModel = undefined;
  ctx.activeResolvedModel = undefined;
  return {
    previous: previousActive ?? null,
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
    throw internalError(`Failed to load preferences: ${e instanceof Error ? e.message : e}`);
  }
}

function saveCharacter(ctx: ModelsContext, character: string, prefs: ModelPreferences): void {
  try {
    saveCharacterPreferences(ctx.dataDir, character, prefs);
  } catch (e) {
    throw internalError(`Failed to save preferences: ${e instanceof Error ? e.message : e}`);
  }
}

export function setModelSetting(ctx: ModelsContext, args: Args): unknown {
  const rawKey = asStr(args["key"]);
  if (rawKey === undefined) throw invalidRequest("missing key");
  const key = rawKey.trim();
  if (!SAMPLER_KEYS.includes(key)) {
    throw invalidRequest(`unknown setting key: ${key}; supported: ${SAMPLER_KEYS.join(", ")}`);
  }

  const value = "value" in args ? args["value"] : null;
  const scope = asStr(args["scope"]) ?? "character";
  if (scope !== "character" && scope !== "global") {
    throw invalidRequest(`scope must be "character" or "global", got ${JSON.stringify(scope)}`);
  }

  const target = settingTarget(ctx, args);
  const model = target.model;
  const failure = capabilityCheck(model.sdk, model.modelId, key, value, model.capabilities);
  if (failure !== undefined) throw failure;

  const character = scope === "character" ? requireCharacter(ctx) : undefined;
  const prefs =
    character === undefined ? loadGlobalPreferences(ctx) : loadCharacterPreferences(ctx, character);

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
    key,
    value,
  };
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

const SETTINGS_SCOPE_FIELDS = [
  ...INFO_SCOPE_FIELDS,
  ["openrouter_provider", "openrouterProvider"],
  ["gemini_generation", "geminiGeneration"],
  ["zai_clear_thinking", "zaiClearThinking"],
  ["zai_subscription", "zaiSubscription"],
] as const satisfies readonly (readonly [string, keyof SamplerSettings])[];

export function modelSettings(ctx: ModelsContext, args: Args): unknown {
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
    effective_sampler: samplerJson(sampler),
    saved_global: saved(global),
    saved_character: saved(charPrefs),
    applicability: keyApplicability(model.sdk, model.modelId, model.capabilities),
    reasoning_effort_domain: reasoningDomain(model.sdk, model.capabilities),
    scopes: scopesJson(scopes, SETTINGS_SCOPE_FIELDS),
  };
}
