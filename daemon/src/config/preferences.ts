import { settingsDeprecations } from "./surface.ts";
import { shoreLog } from "../log.ts";
import { geminiMode, internalSettingKey, normalizeSettings } from "./surface.ts";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { characterDataDir } from "./dirs.ts";

import {
  firstChatModel,
  hardcodedProviderDefaults,
  defaultSdk,
  keepaliveToString,
  parseCacheKeepalive,
  parseCacheKeepaliveMax,
  resolvedModelFromParts,
  applyKeepalivePolicy,
  sdkFromWire,
  type CacheKeepaliveSetting,
  type ModelCatalog,
  type ModelConfigFields,
  type ResolvedModel,
  type Sdk,
} from "./models.ts";
import { invalidType } from "./models.ts";
import { ConfigDuration } from "./duration.ts";
import { compareByCodePoint, sortedKeys } from "../util/sort.ts";
import type { ThinkingReplay } from "../llm/types.ts";
import type { ProviderRegistry } from "./providers.ts";
import { resolveBackgroundModelName, type DefaultsConfig } from "./app.ts";
import {
  SETTING_STORAGE_FIELDS,
  settingApplicability,
  validateSetting,
} from "../llm/settings.ts";
import { ZAI_SUBSCRIPTION_SETTING_MIGRATION } from "../llm/providers/zai_config.ts";
import { nanogptTransportError } from "../llm/providers/nanogpt_config.ts";
import { keepalivePolicyError } from "../llm/cache_capability.ts";

const PREFERENCES_DIR = "preferences";
const PREFERENCES_FILE = "models.toml";

export type PreferenceErrorKind = "read" | "write" | "parse" | "serialize";

export class PreferenceError extends Error {
  constructor(
    readonly kind: PreferenceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PreferenceError";
  }

  static read(path: string, source: string): PreferenceError {
    return new PreferenceError("read", `failed to read ${path}: ${source}`);
  }

  static write(path: string, source: string): PreferenceError {
    return new PreferenceError("write", `failed to write ${path}: ${source}`);
  }

  static parse(path: string, source: string): PreferenceError {
    return new PreferenceError("parse", `failed to parse ${path}: ${source}`);
  }
}

export interface SamplerSettings {
  temperature?: number;
  topP?: number;
  reasoningEffort?: string;
  budgetTokens?: number;
  maxOutputTokens?: number;
  cacheTtl?: string;
  cacheKeepalive?: CacheKeepaliveSetting;
  cacheKeepaliveMax?: ConfigDuration;
  sdk?: string;
  replayPriorThinking?: ThinkingReplay;
  maxToolIterations?: number;
  openrouterProvider?: unknown;
  geminiGeneration?: number;
  zaiClearThinking?: boolean;
  supportsImages?: boolean;
}

const SAMPLER_FIELDS = SETTING_STORAGE_FIELDS;

export const SAMPLER_KEYS: readonly string[] = SAMPLER_FIELDS.map(([, key]) => key);

export const SAMPLER_FIELD_BY_KEY: ReadonlyMap<string, keyof SamplerSettings> = new Map(
  SAMPLER_FIELDS.map(([field, key]) => [key, field]),
);

function applyOverlay(target: SamplerSettings, overlay: SamplerSettings): void {
  for (const [field] of SAMPLER_FIELDS) {
    const value = overlay[field];
    if (value !== undefined) (target as Record<string, unknown>)[field] = value;
  }
}

export function keepaliveOrUndefined(
  setting: CacheKeepaliveSetting | undefined,
): string | undefined {
  return setting === undefined ? undefined : keepaliveToString(setting);
}

export function samplerIsEmpty(settings: SamplerSettings): boolean {
  return SAMPLER_FIELDS.every(([field]) => settings[field] === undefined);
}

function samplerFromResolvedModel(model: ResolvedModel): SamplerSettings {
  const out: SamplerSettings = {};
  const source: SamplerSettings = model;
  for (const [field] of SAMPLER_FIELDS) {
    const value = source[field];
    if (value !== undefined) (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

export interface SelectedModel {
  provider?: string;
  modelId?: string;
}

export function selectionIsSet(selected: SelectedModel): boolean {
  return selected.provider !== undefined && selected.modelId !== undefined;
}

function selectionPair(selected: SelectedModel): [string, string] | undefined {
  const { provider, modelId } = selected;
  return provider !== undefined && modelId !== undefined ? [provider, modelId] : undefined;
}

export function selectionKey(selected: SelectedModel): string | undefined {
  const pair = selectionPair(selected);
  return pair === undefined ? undefined : preferenceKey(pair[0], pair[1]);
}

export interface ModelPreference {
  sampler: SamplerSettings;
}

export interface PreferenceDefaults {
  sampler: SamplerSettings;
}

export interface ModelPreferences {
  selected: SelectedModel;
  favorites: string[];
  defaults: PreferenceDefaults;
  models: Map<string, ModelPreference>;
  subagents: Map<string, ModelPreference>;
  subagentModels: Map<string, ModelPreference>;
}

export function emptyPreferences(): ModelPreferences {
  return {
    selected: {},
    favorites: [],
    defaults: { sampler: {} },
    models: new Map(),
    subagents: new Map(),
    subagentModels: new Map(),
  };
}

export function preferencesAreEmpty(prefs: ModelPreferences): boolean {
  return (
    !selectionIsSet(prefs.selected) &&
    prefs.favorites.length === 0 &&
    samplerIsEmpty(prefs.defaults.sampler) &&
    prefs.models.size === 0 &&
    prefs.subagents.size === 0 &&
    prefs.subagentModels.size === 0
  );
}

export function isFavorite(prefs: ModelPreferences, qualifiedName: string): boolean {
  return prefs.favorites.includes(qualifiedName);
}

export function addFavorite(prefs: ModelPreferences, qualifiedName: string): boolean {
  if (prefs.favorites.includes(qualifiedName)) return false;
  prefs.favorites.push(qualifiedName);
  prefs.favorites.sort(compareByCodePoint);
  return true;
}

export function removeFavorite(prefs: ModelPreferences, qualifiedName: string): boolean {
  const at = prefs.favorites.indexOf(qualifiedName);
  if (at < 0) return false;
  prefs.favorites.splice(at, 1);
  return true;
}

export function subagentModelPreference(
  prefs: ModelPreferences,
  provider: string,
  modelId: string,
): ModelPreference | undefined {
  return prefs.subagentModels.get(preferenceKey(provider, modelId));
}

export function setSubagentModelPreference(
  prefs: ModelPreferences,
  provider: string,
  modelId: string,
  pref: ModelPreference,
): void {
  prefs.subagentModels.set(preferenceKey(provider, modelId), pref);
  prefs.subagentModels = new Map(
    [...prefs.subagentModels].sort((a, b) => compareByCodePoint(a[0], b[0])),
  );
}

export function subagentPreference(
  prefs: ModelPreferences,
  name: string,
): ModelPreference | undefined {
  return prefs.subagents.get(name);
}

export function setSubagentPreference(
  prefs: ModelPreferences,
  name: string,
  pref: ModelPreference,
): void {
  prefs.subagents.set(name, pref);
  prefs.subagents = new Map([...prefs.subagents].sort((a, b) => compareByCodePoint(a[0], b[0])));
}

export function preferenceKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function modelPreference(
  prefs: ModelPreferences,
  provider: string,
  modelId: string,
): ModelPreference | undefined {
  return prefs.models.get(preferenceKey(provider, modelId));
}

export function setModelPreference(
  prefs: ModelPreferences,
  provider: string,
  modelId: string,
  pref: ModelPreference,
): void {
  prefs.models.set(preferenceKey(provider, modelId), pref);
  prefs.models = new Map(
    [...prefs.models].sort((a, b) => compareByCodePoint(a[0], b[0])),
  );
}

export function globalPreferencesPath(dataDir: string): string {
  return join(dataDir, PREFERENCES_DIR, PREFERENCES_FILE);
}

export function characterPreferencesPath(dataDir: string, character: string): string {
  return join(characterDataDir(dataDir, character), PREFERENCES_DIR, PREFERENCES_FILE);
}

export function loadPreferences(path: string): ModelPreferences {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return emptyPreferences();
    throw PreferenceError.read(path, err.message);
  }

  let table: Record<string, unknown>;
  try {
    table = Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (e) {
    throw PreferenceError.parse(path, (e as Error).message);
  }

  const parsed = readPreferences(table);
  for (const warning of settingsDeprecations(table, path, true)) shoreLog.warn(`Deprecated configuration ${warning.source}: ${warning.path} -> ${warning.replacement} (${warning.boundary})`);
  if ("err" in parsed) throw PreferenceError.parse(path, parsed.err);
  return parsed.ok;
}

export function savePreferences(path: string, prefs: ModelPreferences): void {
  const parent = join(path, "..");
  try {
    mkdirSync(parent, { recursive: true });
  } catch (e) {
    throw PreferenceError.write(path, (e as Error).message);
  }
  try {
    writeFileSync(path, serializePreferences(prefs));
  } catch (e) {
    throw PreferenceError.write(path, (e as Error).message);
  }
}

export function loadForCharacter(
  dataDir: string,
  character: string,
): [ModelPreferences, ModelPreferences] {
  return [
    loadPreferences(globalPreferencesPath(dataDir)),
    loadPreferences(characterPreferencesPath(dataDir, character)),
  ];
}

export function saveCharacterPreferences(
  dataDir: string,
  character: string,
  prefs: ModelPreferences,
): void {
  savePreferences(characterPreferencesPath(dataDir, character), prefs);
}

export function saveGlobalPreferences(dataDir: string, prefs: ModelPreferences): void {
  savePreferences(globalPreferencesPath(dataDir), prefs);
}

export function resolveSelectedModel(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
): [string, string] | undefined {
  if (character !== undefined) {
    const pair = selectionPair(character.selected);
    if (pair !== undefined) return pair;
  }
  return selectionPair(global.selected);
}

function settingsFromLayers(
  staticDefault: ResolvedModel | undefined,
  layers: readonly PreferenceLayer[],
): SamplerSettings {
  const effective: SamplerSettings =
    staticDefault === undefined ? {} : samplerFromResolvedModel(staticDefault);

  for (const layer of layers) {
    applyOverlay(effective, sanitizePersistedOverlay(layer.sampler));
  }
  return sanitizeForModel(effective, staticDefault);
}

function sanitizeForModel(
  sampler: SamplerSettings,
  model: ResolvedModel | undefined,
  warn = true,
): SamplerSettings {
  if (model === undefined) return sampler;
  const cleaned: SamplerSettings = { ...sampler };
  for (const [field, key] of SETTING_STORAGE_FIELDS) {
    const value = cleaned[field];
    if (value === undefined) continue;
    const rejected = settingApplicability(model.sdk, key, model.support) === "rejected";
    const closedReasoning = key === "reasoning_effort" &&
      validateSetting(model.sdk, key, value, model.support) !== undefined;
    if (!rejected && !closedReasoning) continue;
    if (warn) {
      shoreLog.warn(
        `shore: dropping \`${key}\` for model ${model.modelId} (sdk ${model.sdk}): the ` +
          "provider reports that this model does not accept it",
      );
    }
    delete cleaned[field];
  }
  const cadence = cleaned.cacheKeepalive;
  if (cadence?.kind === "every" && keepalivePolicyError(
    sdkFromWire(cleaned.sdk ?? model.sdk) ?? model.sdk,
    model.modelId, cleaned.cacheTtl, cadence.interval.asMillis(),
  ) !== undefined) cleaned.cacheKeepalive = { kind: "off" };
  return cleaned;
}

export function resolveSamplerSettings(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  provider: string,
  modelId: string,
  staticDefault: ResolvedModel | undefined,
): SamplerSettings {
  return settingsFromLayers(
    staticDefault,
    preferenceLayers(global, character, provider, modelId),
  );
}

export function resolveSubagentSampler(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  subagent: string | undefined,
  provider: string,
  modelId: string,
  staticDefault: ResolvedModel | undefined,
): SamplerSettings {
  return settingsFromLayers(
    staticDefault,
    subagentLayers(global, character, subagent, provider, modelId),
  );
}

interface PreferenceLayer {
  sampler: SamplerSettings;
  scope: PreferenceScope;
}

function preferenceLayers(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  provider: string,
  modelId: string,
): PreferenceLayer[] {
  const layers: PreferenceLayer[] = [
    { sampler: global.defaults.sampler, scope: "global_default" },
  ];
  if (character !== undefined) {
    layers.push({ sampler: character.defaults.sampler, scope: "character_default" });
  }
  const globalModel = modelPreference(global, provider, modelId);
  if (globalModel !== undefined) {
    layers.push({ sampler: globalModel.sampler, scope: "global_model" });
  }
  if (character !== undefined) {
    const charModel = modelPreference(character, provider, modelId);
    if (charModel !== undefined) {
      layers.push({ sampler: charModel.sampler, scope: "character_model" });
    }
  }
  return layers;
}

function subagentLayers(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  subagent: string | undefined,
  provider: string,
  modelId: string,
): PreferenceLayer[] {
  const layers: PreferenceLayer[] = [];
  const push = (
    entry: ModelPreference | undefined,
    scope: PreferenceScope,
  ): void => {
    if (entry !== undefined) layers.push({ sampler: entry.sampler, scope });
  };

  push(subagentModelPreference(global, provider, modelId), "global_subagent_model");
  if (character !== undefined) {
    push(subagentModelPreference(character, provider, modelId), "character_subagent_model");
  }
  if (subagent !== undefined) {
    push(subagentPreference(global, subagent), "global_subagent");
    if (character !== undefined) {
      push(subagentPreference(character, subagent), "character_subagent");
    }
  }
  return layers;
}

function sanitizePersistedOverlay(layer: SamplerSettings): SamplerSettings {
  const badSdk = layer.sdk !== undefined && sdkFromWire(layer.sdk) === undefined;
  const zeroCap = layer.maxToolIterations === 0;
  if (!badSdk && !zeroCap) return layer;

  const cleaned: SamplerSettings = { ...layer };
  if (badSdk) delete cleaned.sdk;
  if (zeroCap) {
    shoreLog.warn(
      "shore: preferences carry max_tool_iterations = 0; treating as unset (unlimited)",
    );
    delete cleaned.maxToolIterations;
  }
  return cleaned;
}

export type PreferenceScope =
  | "static_default"
  | "global_default"
  | "character_default"
  | "global_model"
  | "character_model"
  | "global_subagent_model"
  | "character_subagent_model"
  | "global_subagent"
  | "character_subagent";

export type SamplerScopes = Partial<Record<keyof SamplerSettings, PreferenceScope>>;

function scopesFromLayers(
  staticDefault: ResolvedModel | undefined,
  layers: readonly PreferenceLayer[],
): SamplerScopes {
  const scopes: SamplerScopes = {};
  const note = (layer: SamplerSettings, scope: PreferenceScope): void => {
    for (const [field] of SAMPLER_FIELDS) {
      if (layer[field] !== undefined) scopes[field] = scope;
    }
  };

  if (staticDefault !== undefined) {
    note(samplerFromResolvedModel(staticDefault), "static_default");
  }
  for (const layer of layers) {
    note(sanitizePersistedOverlay(layer.sampler), layer.scope);
  }
  const effective: SamplerSettings =
    staticDefault === undefined ? {} : samplerFromResolvedModel(staticDefault);
  for (const layer of layers) applyOverlay(effective, sanitizePersistedOverlay(layer.sampler));
  const sanitized = sanitizeForModel(effective, staticDefault, false);
  for (const [field] of SETTING_STORAGE_FIELDS) {
    if (sanitized[field] === undefined) delete scopes[field];
  }
  return scopes;
}

export function resolveSamplerScopes(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  provider: string,
  modelId: string,
  staticDefault: ResolvedModel | undefined,
): SamplerScopes {
  return scopesFromLayers(staticDefault, preferenceLayers(global, character, provider, modelId));
}

export function resolveSubagentScopes(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  subagent: string | undefined,
  provider: string,
  modelId: string,
  staticDefault: ResolvedModel | undefined,
): SamplerScopes {
  return scopesFromLayers(
    staticDefault,
    subagentLayers(global, character, subagent, provider, modelId),
  );
}

export function findStaticModel(
  catalog: ModelCatalog,
  provider: string,
  modelId: string,
): ResolvedModel | undefined {
  for (const model of catalog.chat.values()) {
    if (model.providerKey === provider && model.modelId === modelId) return model;
  }
  return undefined;
}

export interface LoadedConfigView {
  models: ModelCatalog;
  providers: ProviderRegistry;
  dirs: { data: string; cache: string };
  app: {
    defaults: {
      model?: string;
      subagent_model?: string;
      backgroundModelName: (task: BackgroundTask) => string | undefined;
    };
  };
}

export type BackgroundTask = Exclude<import("../protocol/BackgroundModelTarget.ts").BackgroundModelTarget, "all">;

export function configView(config: {
  models: ModelCatalog;
  providers: ProviderRegistry;
  dirs: { data: string; cache: string };
  app: { defaults: DefaultsConfig };
}): LoadedConfigView {
  return {
    models: config.models,
    providers: config.providers,
    dirs: config.dirs,
    app: {
      defaults: {
        ...(config.app.defaults.model === undefined ? {} : { model: config.app.defaults.model }),
        ...(config.app.defaults.subagent_model === undefined
          ? {}
          : { subagent_model: config.app.defaults.subagent_model }),
        backgroundModelName: (task) => resolveBackgroundModelName(config.app.defaults, task),
      },
    },
  };
}

export type FindEffectiveModel = (
  config: LoadedConfigView,
  cacheDir: string,
  name: string,
  includeHidden: boolean,
) => ResolvedModel;

function resolveProviderModel(
  config: LoadedConfigView,
  provider: string,
  modelId: string,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  const staticMatch = findStaticModel(config.models, provider, modelId);
  if (staticMatch !== undefined) return staticMatch;

  try {
    return findEffective(config, config.dirs.cache, `${provider}:${modelId}`, true);
  } catch {
    return synthesizeSelectedProviderModel(config, provider, modelId);
  }
}

function synthesizeSelectedProviderModel(
  config: LoadedConfigView,
  provider: string,
  modelId: string,
): ResolvedModel | undefined {
  const entry = config.providers.get(provider);
  if (entry === undefined || !entry.enabled) return undefined;

  const fields: ModelConfigFields = { ...hardcodedProviderDefaults(provider).fields };
  if (entry.sdk !== undefined) fields.sdk = entry.sdk;
  if (entry.baseUrl !== undefined) fields.baseUrl = entry.baseUrl;
  if (entry.apiKeyEnv !== undefined) fields.apiKeyEnv = entry.apiKeyEnv;

  return resolvedModelFromParts(
    modelId,
    `${provider}:${modelId}`,
    "chat",
    provider,
    modelId,
    defaultSdk(provider),
    fields,
  );
}

function selectedForCharacter(
  config: LoadedConfigView,
  global: ModelPreferences,
  character: ModelPreferences,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  for (const prefs of [character, global]) {
    const pair = selectionPair(prefs.selected);
    if (pair === undefined) continue;
    const resolved = resolveProviderModel(config, pair[0], pair[1], findEffective);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

export function savedModelForCharacter(
  config: LoadedConfigView,
  character: string,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  let global: ModelPreferences;
  let charPrefs: ModelPreferences;
  try {
    [global, charPrefs] = loadForCharacter(config.dirs.data, character);
  } catch {
    return undefined;
  }
  return selectedForCharacter(config, global, charPrefs, findEffective);
}

export function resolveActiveForCharacter(
  config: LoadedConfigView,
  global: ModelPreferences,
  character: ModelPreferences,
  appDefaultModel: string | undefined,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  const selected = selectedForCharacter(config, global, character, findEffective);
  if (selected !== undefined) return selected;

  if (appDefaultModel !== undefined) {
    try {
      return findEffective(config, config.dirs.cache, appDefaultModel, true);
    } catch (e) {
      shoreLog.warn(
        `shore: [defaults].model "${appDefaultModel}" could not be resolved, ` +
          `falling back to the first configured chat model: ${String(e)}`,
      );
    }
  }

  return firstChatModel(config.models);
}

export function applySamplerOverlay(
  model: ResolvedModel,
  overlay: SamplerSettings,
): ResolvedModel {
  const patched: ResolvedModel = { ...model };

  const direct = [
    ["temperature", "temperature"],
    ["topP", "topP"],
    ["reasoningEffort", "reasoningEffort"],
    ["budgetTokens", "budgetTokens"],
    ["maxOutputTokens", "maxOutputTokens"],
    ["cacheTtl", "cacheTtl"],
    ["cacheKeepalive", "cacheKeepalive"],
    ["replayPriorThinking", "replayPriorThinking"],
    ["maxToolIterations", "maxToolIterations"],
    ["openrouterProvider", "openrouterProvider"],
    ["geminiGeneration", "geminiGeneration"],
    ["zaiClearThinking", "zaiClearThinking"],
    ["supportsImages", "supportsImages"],
  ] as const satisfies readonly (readonly [keyof SamplerSettings, keyof ResolvedModel])[];

  for (const [field, target] of direct) {
    const value = overlay[field];
    if (value !== undefined) (patched as unknown as Record<string, unknown>)[target] = value;
  }

  if (overlay.sdk !== undefined) {
    const sdk = sdkFromWire(overlay.sdk);
    if (sdk === undefined) {
      shoreLog.warn(
        `shore: preferences overlay for ${patched.qualifiedName} carries unknown sdk ` +
          `"${overlay.sdk}"; keeping catalog value`,
      );
    } else {
      patched.sdk = sdk;
    }
  }

  const transportError = nanogptTransportError(patched.providerKey, patched.sdk);
  if (transportError !== undefined) throw new Error(transportError);
  applyKeepalivePolicy(patched);
  return patched;
}

function overlayForCharacter(
  dataDir: string,
  character: string,
  base: ResolvedModel,
  op: string,
): ResolvedModel {
  let global: ModelPreferences;
  let charPrefs: ModelPreferences;
  try {
    [global, charPrefs] = loadForCharacter(dataDir, character);
  } catch (e) {
    shoreLog.warn(
      `shore: preferences load failed for ${character} (${op}); using raw model settings: ` +
        (e as Error).message,
    );
    return base;
  }
  const overlay = resolveSamplerSettings(
    global,
    charPrefs,
    base.providerKey,
    base.modelId,
    base,
  );
  return applySamplerOverlay(base, overlay);
}

export function resolveSubagentBaseModel(
  config: LoadedConfigView,
  character: string | undefined,
  specModel: string | undefined,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  const configured = specModel ?? config.app.defaults.subagent_model;
  if (configured !== undefined) {
    return findEffective(config, config.dirs.cache, configured, true);
  }
  if (character === undefined) return undefined;
  return activeSelection(config, character, findEffective, "resolve_subagent_model").resolved;
}

export function resolveSubagentModelSettings(
  dataDir: string,
  character: string,
  subagent: string,
  base: ResolvedModel,
): ResolvedModel {
  let global: ModelPreferences;
  let charPrefs: ModelPreferences;
  try {
    [global, charPrefs] = loadForCharacter(dataDir, character);
  } catch (e) {
    shoreLog.warn(
      `shore: preferences load failed for ${character} (subagent ${subagent}); ` +
        `using raw model settings: ${(e as Error).message}`,
    );
    return base;
  }
  return applySamplerOverlay(
    base,
    resolveSubagentSampler(
      global,
      charPrefs,
      subagent,
      base.providerKey,
      base.modelId,
      base,
    ),
  );
}

export function resolveBackgroundModel(
  config: LoadedConfigView,
  task: BackgroundTask,
  character: string,
  findEffective: FindEffectiveModel,
  threadModel?: string,
): ResolvedModel | undefined {
  const name = config.app.defaults.backgroundModelName(task);
  if (name === undefined) {
    return resolveChatModelForCharacter(config, character, findEffective, threadModel);
  }

  let base: ResolvedModel;
  try {
    base = findEffective(config, config.dirs.cache, name, true);
  } catch (e) {
    shoreLog.warn(
      `shore: configured ${task} model "${name}" not found in catalog for ${character}; ` +
        `falling back to active chat model: ${(e as Error).message}`,
    );
    return resolveChatModelForCharacter(config, character, findEffective, threadModel);
  }
  return overlayForCharacter(config.dirs.data, character, base, task);
}

function pinnedModel(
  config: LoadedConfigView,
  pinned: string,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  const colon = pinned.indexOf(":");
  if (colon > 0 && colon < pinned.length - 1) {
    return resolveProviderModel(
      config,
      pinned.slice(0, colon),
      pinned.slice(colon + 1),
      findEffective,
    );
  }
  try {
    return findEffective(config, config.dirs.cache, pinned, true);
  } catch {
    return undefined;
  }
}

export function resolveThreadPin(
  config: LoadedConfigView,
  character: string,
  pinned: string,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  const resolved = pinnedModel(config, pinned, findEffective);
  if (resolved !== undefined) return resolved;
  shoreLog.warn(
    `shore: thread model ${JSON.stringify(pinned)} for ${character} could not be resolved; ` +
      "falling back to the character's active model",
  );
  return undefined;
}

export function resolveChatModelForCharacter(
  config: LoadedConfigView,
  character: string,
  findEffective: FindEffectiveModel,
  threadModel?: string,
): ResolvedModel | undefined {
  const { global, charPrefs, resolved } = activeSelection(
    config,
    character,
    findEffective,
    "resolve_chat_model",
    threadModel,
  );
  if (resolved === undefined) return undefined;

  const overlay = resolveSamplerSettings(
    global,
    charPrefs,
    resolved.providerKey,
    resolved.modelId,
    resolved,
  );
  return applySamplerOverlay(resolved, overlay);
}

export function resolveActiveModelAndOverlay(
  config: LoadedConfigView,
  character: string,
  findEffective: FindEffectiveModel,
  threadModel?: string,
): { model: ResolvedModel | undefined; overlay: SamplerSettings } {
  const { global, charPrefs, resolved } = activeSelection(
    config,
    character,
    findEffective,
    "resolve_active_model",
    threadModel,
  );
  if (resolved === undefined) return { model: undefined, overlay: {} };

  return {
    model: resolved,
    overlay: resolveSamplerSettings(
      global,
      charPrefs,
      resolved.providerKey,
      resolved.modelId,
      undefined,
    ),
  };
}

function activeSelection(
  config: LoadedConfigView,
  character: string,
  findEffective: FindEffectiveModel,
  op: string,
  threadModel?: string,
): { global: ModelPreferences; charPrefs: ModelPreferences; resolved: ResolvedModel | undefined } {
  let global = emptyPreferences();
  let charPrefs = emptyPreferences();
  try {
    [global, charPrefs] = loadForCharacter(config.dirs.data, character);
  } catch (e) {
    shoreLog.warn(
      `shore: preferences load failed for ${character} (${op}); ` +
        `using empty defaults: ${(e as Error).message}`,
    );
  }

  const pinned =
    threadModel === undefined
      ? undefined
      : resolveThreadPin(config, character, threadModel, findEffective);

  const resolved =
    pinned ??
    resolveActiveForCharacter(
      config,
      global,
      charPrefs,
      config.app.defaults.model,
      findEffective,
    );
  return { global, charPrefs, resolved };
}

type ReadResult<T> = { ok: T } | { err: string };

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownField(table: Record<string, unknown>, known: readonly string[]): string | undefined {
  for (const key of sortedKeys(table)) {
    if (!known.includes(key)) {
      return `unknown field \`${key}\`, expected ${expectedList(known)}`;
    }
  }
  return undefined;
}

function readSampler(table: Record<string, unknown>): ReadResult<SamplerSettings> {
  try { table = normalizeSettings(table, "preferences"); }
  catch (error) { return { err: error instanceof Error ? error.message : String(error) }; }
  if (Object.hasOwn(table, "zai_subscription")) {
    return { err: ZAI_SUBSCRIPTION_SETTING_MIGRATION };
  }
  const unknown = unknownField(table, SAMPLER_KEYS.map(internalSettingKey));
  if (unknown !== undefined) return { err: unknown };

  const out: SamplerSettings = {};
  const numbers = [
    ["temperature", "temperature"],
    ["topP", "top_p"],
  ] as const;
  for (const [field, key] of numbers) {
    const raw = table[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number") return { err: invalidType(raw, "f64") };
    out[field] = raw;
  }

  const integers = [
    ["budgetTokens", "budget_tokens"],
    ["maxOutputTokens", "max_output_tokens"],
    ["maxToolIterations", "max_tool_iterations"],
    ["geminiGeneration", "gemini_generation"],
  ] as const;
  for (const [field, key] of integers) {
    const raw = table[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw)) return { err: invalidType(raw, "u32") };
    if (raw < 0 || raw > 0xffff_ffff) {
      return { err: `invalid value: integer \`${raw}\`, expected u32` };
    }
    out[field] = raw;
  }

  const strings = [
    ["reasoningEffort", "reasoning_effort"],
    ["cacheTtl", "cache_ttl"],
    ["sdk", "sdk"],
  ] as const;
  for (const [field, key] of strings) {
    const raw = table[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return { err: invalidType(raw, "a string") };
    out[field] = raw;
  }

  const booleans = [
    ["zaiClearThinking", "zai_clear_thinking"],
    ["supportsImages", "supports_images"],
  ] as const;
  for (const [field, key] of booleans) {
    const raw = table[key];
    if (raw === undefined) continue;
    if (typeof raw !== "boolean") return { err: invalidType(raw, "a boolean") };
    out[field] = raw;
  }

  const keepalive = table["cache_keepalive"];
  if (keepalive !== undefined) {
    if (typeof keepalive !== "string") return { err: invalidType(keepalive, "a string") };
    const parsed = parseCacheKeepalive(keepalive);
    if ("err" in parsed) return parsed;
    out.cacheKeepalive = parsed.ok;
  }

  const keepaliveMax = table["cache_keepalive_max"];
  if (keepaliveMax !== undefined) {
    if (typeof keepaliveMax !== "string") return { err: invalidType(keepaliveMax, "a string") };
    const parsed = parseCacheKeepaliveMax(keepaliveMax);
    if ("err" in parsed) return parsed;
    out.cacheKeepaliveMax = parsed.ok;
  }

  const replay = table["replay_prior_thinking"];
  if (replay !== undefined) {
    const parsed = readThinkingReplay(replay);
    if ("err" in parsed) return parsed;
    out.replayPriorThinking = parsed.ok;
  }

  if (table["openrouter_provider"] !== undefined) {
    out.openrouterProvider = table["openrouter_provider"];
  }

  return { ok: out };
}

function readThinkingReplay(value: unknown): ReadResult<ThinkingReplay> {
  if (typeof value === "boolean") return { ok: value ? "all" : "none" };
  if (value === "all" || value === "none") return { ok: value };
  return {
    err: `invalid replay_prior_thinking ${JSON.stringify(value)}; ` +
      `expected "all", "none" (or legacy true/false)`,
  };
}

export function readPreferences(table: Record<string, unknown>): ReadResult<ModelPreferences> {
  const unknown = unknownField(table, [
    "selected",
    "favorites",
    "defaults",
    "models",
    "subagents",
    "subagent_models",
  ]);
  if (unknown !== undefined) return { err: unknown };

  const out = emptyPreferences();

  const favorites = table["favorites"];
  if (favorites !== undefined) {
    if (!Array.isArray(favorites)) {
      return { err: "invalid type: expected an array for `favorites`" };
    }
    for (const raw of favorites) {
      if (typeof raw !== "string") return { err: invalidType(raw, "a string") };
      if (raw !== "" && !out.favorites.includes(raw)) out.favorites.push(raw);
    }
    out.favorites.sort(compareByCodePoint);
  }

  const selected = table["selected"];
  if (selected !== undefined) {
    if (!isTable(selected)) return { err: "invalid type: expected a table for `selected`" };
    const bad = unknownField(selected, ["provider", "model_id"]);
    if (bad !== undefined) return { err: bad };
    for (const [field, key] of [
      ["provider", "provider"],
      ["modelId", "model_id"],
    ] as const) {
      const raw = selected[key];
      if (raw === undefined) continue;
      if (typeof raw !== "string") return { err: invalidType(raw, "a string") };
      out.selected[field] = raw;
    }
  }

  const defaults = table["defaults"];
  if (defaults !== undefined) {
    if (!isTable(defaults)) return { err: "invalid type: expected a table for `defaults`" };
    const bad = unknownField(defaults, ["sampler"]);
    if (bad !== undefined) return { err: bad };
    const sampler = defaults["sampler"];
    if (sampler !== undefined) {
      if (!isTable(sampler)) return { err: "invalid type: expected a table for `sampler`" };
      const read = readSampler(sampler);
      if ("err" in read) return read;
      out.defaults.sampler = read.ok;
    }
  }

  for (const [section, slot] of [
    ["models", "models"],
    ["subagents", "subagents"],
    ["subagent_models", "subagentModels"],
  ] as const satisfies readonly (readonly [
    string,
    "models" | "subagents" | "subagentModels",
  ])[]) {
    const raw = table[section];
    if (raw === undefined) continue;
    if (!isTable(raw)) return { err: `invalid type: expected a table for \`${section}\`` };
    const entries: [string, ModelPreference][] = [];
    for (const key of sortedKeys(raw)) {
      const value = raw[key];
      if (!isTable(value)) return { err: `invalid type: expected a table for \`${key}\`` };
      const read = readSampler(value);
      if ("err" in read) return read;
      entries.push([key, { sampler: read.ok }]);
    }
    out[slot] = new Map(entries);
  }

  return { ok: out };
}

export function serializePreferences(prefs: ModelPreferences): string {
  const blocks: string[] = [];

  if (prefs.favorites.length > 0) {
    blocks.push(`favorites = ${tomlInline(prefs.favorites)}`);
  }

  const selected: string[] = ["[selected]"];
  if (prefs.selected.provider !== undefined) {
    selected.push(`provider = ${tomlString(prefs.selected.provider)}`);
  }
  if (prefs.selected.modelId !== undefined) {
    selected.push(`model_id = ${tomlString(prefs.selected.modelId)}`);
  }
  blocks.push(selected.join("\n"));

  blocks.push(["[defaults.sampler]", ...samplerLines(prefs.defaults.sampler)].join("\n"));

  if (prefs.models.size === 0) {
    blocks.push("[models]");
  } else {
    for (const [key, pref] of prefs.models) {
      blocks.push([`[models.${tomlString(key)}]`, ...samplerLines(pref.sampler)].join("\n"));
    }
  }

  for (const [key, pref] of prefs.subagentModels) {
    blocks.push(
      [`[subagent_models.${tomlString(key)}]`, ...samplerLines(pref.sampler)].join("\n"),
    );
  }

  for (const [key, pref] of prefs.subagents) {
    blocks.push([`[subagents.${tomlString(key)}]`, ...samplerLines(pref.sampler)].join("\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}

function samplerLines(sampler: SamplerSettings): string[] {
  const out: string[] = [];
  for (const [field, key] of SAMPLER_FIELDS) {
    const value = field === "geminiGeneration" ? geminiMode(sampler[field]) : sampler[field];
    if (value === undefined) continue;
    if (field === "cacheKeepalive") {
      out.push(`${key} = ${tomlString(keepaliveToString(value as CacheKeepaliveSetting))}`);
    } else if (field === "cacheKeepaliveMax") {
      out.push(`${key} = ${tomlString((value as ConfigDuration).toString())}`);
    } else if (field === "temperature" || field === "topP") {
      out.push(`${key} = ${tomlFloat(value as number)}`);
    } else if (typeof value === "string") {
      out.push(`${key} = ${tomlString(value)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out.push(`${key} = ${tomlScalar(value)}`);
    } else {
      out.push(`${key} = ${tomlInline(value)}`);
    }
  }
  return out;
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

function tomlScalar(value: number | boolean): string {
  return String(value);
}

function tomlFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function tomlInline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlInline).join(", ")}]`;
  if (isTable(value)) {
    const body = sortedKeys(value)
      .map((k) => `${k} = ${tomlInline(value[k])}`)
      .join(", ");
    return `{ ${body} }`;
  }
  if (typeof value === "string") return tomlString(value);
  return String(value);
}

export type { Sdk };

function expectedList(known: readonly string[]): string {
  if (known.length === 1) return `\`${known[0]}\``;
  if (known.length === 2) return `\`${known[0]}\` or \`${known[1]}\``;
  const head = known.slice(0, -1).map((k) => `\`${k}\``).join(", ");
  return `one of ${head}, \`${known[known.length - 1]}\``;
}
