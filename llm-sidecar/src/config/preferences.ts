/**
 * Daemon-owned, durable model preferences.
 *
 * Port of `crates/daemon/src/preferences/mod.rs`.
 *
 * Storage layout:
 *
 * - `<data_dir>/preferences/models.toml` — global
 * - `<data_dir>/<character>/preferences/models.toml` — per-character
 *
 * Per-model entries are keyed by **stable provider key + upstream model_id**,
 * joined by `:` — never by display name or short alias — so preferences
 * survive renames in the static catalog and follow the same model across
 * discovered and manual entries.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  findModel,
  firstChatModel,
  hardcodedProviderDefaults,
  defaultSdk,
  keepaliveToString,
  parseCacheKeepalive,
  resolvedModelFromParts,
  sdkFromWire,
  type CacheKeepaliveSetting,
  type ModelCatalog,
  type ModelConfigFields,
  type ResolvedModel,
  type Sdk,
} from "./models.ts";
import { CatalogError, invalidType } from "./models.ts";
import { compareByCodePoint, sortedKeys } from "../sort.ts";
import type { ThinkingReplay } from "../llm/types.ts";
import type { ProviderRegistry } from "./providers.ts";
import { loadActiveModel } from "./runtime_state.ts";

const PREFERENCES_DIR = "preferences";
const PREFERENCES_FILE = "models.toml";

// ── Errors ──────────────────────────────────────────────────────────────

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

// ── Sampler settings ────────────────────────────────────────────────────

/**
 * Per-model sampler overrides written by the user.
 *
 * Every field is optional — absent means "inherit from the next layer up".
 */
export interface SamplerSettings {
  temperature?: number;
  topP?: number;
  /** `"low" | "medium" | "high"`, or `"off"` to explicitly disable reasoning. */
  reasoningEffort?: string;
  budgetTokens?: number;
  maxOutputTokens?: number;
  cacheTtl?: string;
  cacheKeepalive?: CacheKeepaliveSetting;
  /** Wire SDK override. Lets a user force, e.g., the Anthropic wire shape for
   *  a model the discovery cache labelled `openai`. Validated on write. */
  sdk?: string;
  /** Per-model override for `[memory.thinking].replay_prior_thinking`. The
   *  quality effect is model-dependent, so there is no default in either
   *  direction. The DeepSeek/Kimi reasoning-replay floor is orthogonal and
   *  still enforced regardless. */
  replayPriorThinking?: ThinkingReplay;
  /** Maximum tool-loop iterations per turn. Absent means **unlimited**. The
   *  single surface governing every agentic loop — chat, heartbeat,
   *  compaction, dreaming. Honored by every sdk, not capability-gated. */
  maxToolIterations?: number;
  openrouterProvider?: unknown;
  geminiGeneration?: number;
  zaiClearThinking?: boolean;
  zaiSubscription?: boolean;
}

/** Field name pairs: the TypeScript property and its TOML key. */
const SAMPLER_FIELDS = [
  ["temperature", "temperature"],
  ["topP", "top_p"],
  ["reasoningEffort", "reasoning_effort"],
  ["budgetTokens", "budget_tokens"],
  ["maxOutputTokens", "max_output_tokens"],
  ["cacheTtl", "cache_ttl"],
  ["cacheKeepalive", "cache_keepalive"],
  ["sdk", "sdk"],
  ["replayPriorThinking", "replay_prior_thinking"],
  ["maxToolIterations", "max_tool_iterations"],
  ["openrouterProvider", "openrouter_provider"],
  ["geminiGeneration", "gemini_generation"],
  ["zaiClearThinking", "zai_clear_thinking"],
  ["zaiSubscription", "zai_subscription"],
] as const satisfies readonly (readonly [keyof SamplerSettings, string])[];

const SAMPLER_KEYS = SAMPLER_FIELDS.map(([, key]) => key);

/** Apply `overlay` on top of `target`: each field set in `overlay` replaces
 *  the corresponding field. Absent overlay fields leave `target` alone. */
export function applyOverlay(target: SamplerSettings, overlay: SamplerSettings): void {
  for (const [field] of SAMPLER_FIELDS) {
    const value = overlay[field];
    if (value !== undefined) (target as Record<string, unknown>)[field] = value;
  }
}

/** The TOML spelling of a keepalive setting, or `undefined` when unset. */
export function keepaliveOrUndefined(
  setting: CacheKeepaliveSetting | undefined,
): string | undefined {
  return setting === undefined ? undefined : keepaliveToString(setting);
}

export function samplerIsEmpty(settings: SamplerSettings): boolean {
  return SAMPLER_FIELDS.every(([field]) => settings[field] === undefined);
}

/** The sampler-shaped fields of a resolved static-catalog model. */
export function samplerFromResolvedModel(model: ResolvedModel): SamplerSettings {
  const out: SamplerSettings = { sdk: model.sdk };
  const copy = [
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
    ["zaiSubscription", "zaiSubscription"],
  ] as const satisfies readonly (readonly [keyof SamplerSettings, keyof ResolvedModel])[];
  for (const [field, source] of copy) {
    const value = model[source];
    if (value !== undefined) (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

// ── Selected model ──────────────────────────────────────────────────────

/**
 * The `[selected]` block. Both fields must be set for the selection to be
 * valid — a partial selection is treated as "not selected".
 */
export interface SelectedModel {
  provider?: string;
  modelId?: string;
}

export function selectionIsSet(selected: SelectedModel): boolean {
  return selected.provider !== undefined && selected.modelId !== undefined;
}

/** `[provider, modelId]` if both are set. */
export function selectionPair(selected: SelectedModel): [string, string] | undefined {
  const { provider, modelId } = selected;
  return provider !== undefined && modelId !== undefined ? [provider, modelId] : undefined;
}

export function selectionKey(selected: SelectedModel): string | undefined {
  const pair = selectionPair(selected);
  return pair === undefined ? undefined : preferenceKey(pair[0], pair[1]);
}

// ── File shape ──────────────────────────────────────────────────────────

/** A `[models."<provider>:<model_id>"]` entry — today just a sampler bag. */
export interface ModelPreference {
  sampler: SamplerSettings;
}

/** The `[defaults]` block. */
export interface PreferenceDefaults {
  sampler: SamplerSettings;
}

/** Top-level shape of `models.toml`, global or character-scoped. */
export interface ModelPreferences {
  selected: SelectedModel;
  defaults: PreferenceDefaults;
  /** Per-model entries keyed by `<provider>:<model_id>`, in BTreeMap order. */
  models: Map<string, ModelPreference>;
}

export function emptyPreferences(): ModelPreferences {
  return { selected: {}, defaults: { sampler: {} }, models: new Map() };
}

export function preferencesAreEmpty(prefs: ModelPreferences): boolean {
  return (
    !selectionIsSet(prefs.selected) &&
    samplerIsEmpty(prefs.defaults.sampler) &&
    prefs.models.size === 0
  );
}

/** Stable preference key: `<provider>:<model_id>`. */
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

/**
 * Insert or update a per-model entry.
 *
 * Clearing every sampler field and calling this does NOT delete the entry —
 * {@link clearModelPreference} does.
 */
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

export function clearModelPreference(
  prefs: ModelPreferences,
  provider: string,
  modelId: string,
): ModelPreference | undefined {
  const key = preferenceKey(provider, modelId);
  const previous = prefs.models.get(key);
  prefs.models.delete(key);
  return previous;
}

// ── Paths ───────────────────────────────────────────────────────────────

export function globalPreferencesPath(dataDir: string): string {
  return join(dataDir, PREFERENCES_DIR, PREFERENCES_FILE);
}

export function characterPreferencesPath(dataDir: string, character: string): string {
  return join(dataDir, character, PREFERENCES_DIR, PREFERENCES_FILE);
}

// ── Load / save ─────────────────────────────────────────────────────────

/**
 * Load preferences from `path`.
 *
 * A missing file is empty defaults. Malformed TOML or an unknown field is a
 * `PreferenceError` so the caller can surface it instead of silently
 * overwriting the user's settings.
 */
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
  if ("err" in parsed) throw PreferenceError.parse(path, parsed.err);
  return parsed.ok;
}

/** Save preferences to `path`, creating parent directories as needed. */
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

/** Load `(global, character)` preferences. Either file may be missing. */
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

// ── Resolver ────────────────────────────────────────────────────────────

/**
 * Which model is selected after layering global and character.
 * Character beats global; a partial selection is ignored at its layer.
 */
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

/**
 * Resolve sampler settings for `(provider, modelId)`.
 *
 * Layer order, lowest to highest precedence:
 *
 * 0. `staticDefault` — the sampler-shaped fields of a catalog `ResolvedModel`.
 *    Pass `undefined` from callers that merge the static catalog separately
 *    (the chat request path, which applies the overlay via
 *    {@link applySamplerOverlay}); pass the model from display paths so the
 *    effective view matches what a request would use.
 * 1. `global.defaults.sampler`
 * 2. `character.defaults.sampler`
 * 3. `global.models[<key>]`
 * 4. `character.models[<key>]`
 */
export function resolveSamplerSettings(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  provider: string,
  modelId: string,
  staticDefault: ResolvedModel | undefined,
): SamplerSettings {
  const effective: SamplerSettings =
    staticDefault === undefined ? {} : samplerFromResolvedModel(staticDefault);

  for (const layer of preferenceLayers(global, character, provider, modelId)) {
    applyOverlay(effective, sanitizePersistedOverlay(layer));
  }
  return effective;
}

/** The four preference layers in precedence order, skipping absent ones. */
function preferenceLayers(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  provider: string,
  modelId: string,
): SamplerSettings[] {
  const layers: SamplerSettings[] = [global.defaults.sampler];
  if (character !== undefined) layers.push(character.defaults.sampler);
  const globalModel = modelPreference(global, provider, modelId);
  if (globalModel !== undefined) layers.push(globalModel.sampler);
  if (character !== undefined) {
    const charModel = modelPreference(character, provider, modelId);
    if (charModel !== undefined) layers.push(charModel.sampler);
  }
  return layers;
}

/**
 * Strip overlay fields the patch path would silently discard, so an
 * inspection view shows the values a real request would use.
 *
 * Two cases. An `sdk` string {@link sdkFromWire} cannot parse — a corrupted
 * hand-edit shouldn't make the effective sampler diverge from
 * {@link applySamplerOverlay}'s result. And `maxToolIterations = 0`, which is
 * not a valid persisted value: absent already means unlimited and the setter
 * rejects 0, but a hand-edited file can still carry it, and left intact the
 * tool loops would read it as "cap reached before the first round" — a silent
 * no-op that contradicts the documented default.
 */
function sanitizePersistedOverlay(layer: SamplerSettings): SamplerSettings {
  const badSdk = layer.sdk !== undefined && sdkFromWire(layer.sdk) === undefined;
  const zeroCap = layer.maxToolIterations === 0;
  if (!badSdk && !zeroCap) return layer;

  const cleaned: SamplerSettings = { ...layer };
  if (badSdk) delete cleaned.sdk;
  if (zeroCap) {
    console.warn(
      "shore: preferences carry max_tool_iterations = 0; treating as unset (unlimited)",
    );
    delete cleaned.maxToolIterations;
  }
  return cleaned;
}

// ── Scopes ──────────────────────────────────────────────────────────────

/** Where in the preference stack a sampler field landed. */
export type PreferenceScope =
  /** Unset at every layer; the static catalog default is in effect. */
  | "static_default"
  | "global_default"
  | "character_default"
  | "global_model"
  | "character_model";

export type SamplerScopes = Partial<Record<keyof SamplerSettings, PreferenceScope>>;

/**
 * Which layer last set each sampler field. Higher precedence wins; fields no
 * layer set stay absent.
 */
export function resolveSamplerScopes(
  global: ModelPreferences,
  character: ModelPreferences | undefined,
  provider: string,
  modelId: string,
  staticDefault: ResolvedModel | undefined,
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
  note(sanitizePersistedOverlay(global.defaults.sampler), "global_default");
  if (character !== undefined) {
    note(sanitizePersistedOverlay(character.defaults.sampler), "character_default");
  }
  const globalModel = modelPreference(global, provider, modelId);
  if (globalModel !== undefined) {
    note(sanitizePersistedOverlay(globalModel.sampler), "global_model");
  }
  if (character !== undefined) {
    const charModel = modelPreference(character, provider, modelId);
    if (charModel !== undefined) {
      note(sanitizePersistedOverlay(charModel.sampler), "character_model");
    }
  }
  return scopes;
}

// ── Catalog bridging ────────────────────────────────────────────────────

/**
 * The static-catalog model matching `(provider, modelId)`.
 *
 * The inverse of "save selection" for static entries: users select by short
 * name, the catalog resolves it, and `(providerKey, modelId)` is persisted.
 * Discovered-model lookups go through the effective catalog instead.
 */
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

/**
 * The config surface the resolver needs.
 *
 * Declared here rather than imported so this module does not depend on the
 * whole `LoadedConfig` loader, which has not been ported. `app` carries only
 * the two `[defaults]` keys the chain reads.
 */
export interface LoadedConfigView {
  models: ModelCatalog;
  providers: ProviderRegistry;
  dirs: { data: string; cache: string };
  app: {
    defaults: {
      model?: string;
      /** `defaults.background.<task>` falling back to `defaults.background.model`. */
      backgroundModelName: (task: BackgroundTask) => string | undefined;
    };
  };
}

export type BackgroundTask = "heartbeat" | "compaction";

/** Injected so preferences does not import the effective catalog, which
 *  imports preferences' own types. Mirrors the Rust module boundary. */
export type FindEffectiveModel = (
  config: LoadedConfigView,
  cacheDir: string,
  name: string,
  includeHidden: boolean,
) => ResolvedModel;

/**
 * Resolve a saved `(provider, modelId)` selection against the effective
 * catalog. If the discovery cache was deleted, the pair is reconstructed from
 * the provider registry so cache deletion does not lose the selection.
 *
 * `includeHidden` is always true here: a previously selected discovered model
 * should keep resolving across restarts even if `discovery.ignore` would now
 * hide it. The user chose it explicitly; `discovery.ignore` scopes listing,
 * not restoration.
 */
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

/**
 * Rebuild a previously selected discovered model when its disposable
 * discovery cache has been deleted. Selection durability comes from the
 * preferences file; the cache only supplies richer metadata.
 */
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
    // Canonical `provider:model_id` identity, not the retired
    // `chat.<provider>.<model_id>` cosplay.
    `${provider}:${modelId}`,
    "chat",
    provider,
    modelId,
    defaultSdk(provider),
    fields,
  );
}

/**
 * The active model for a session.
 *
 * 1. Character preferences `[selected]` → effective catalog by
 *    `(providerKey, modelId)`.
 * 2. Global preferences `[selected]` → same lookup.
 * 3. Legacy `runtime_state.json` active model → catalog by name. Migration
 *    fallback for installs that have not written preferences yet.
 * 4. `app.defaults.model`, through the effective catalog so it accepts a
 *    static alias *or* a `provider:model_id` ref.
 * 5. First chat model in the static catalog.
 */
export function resolveActiveForCharacter(
  config: LoadedConfigView,
  global: ModelPreferences,
  character: ModelPreferences,
  legacyActiveModel: string | undefined,
  appDefaultModel: string | undefined,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  for (const prefs of [character, global]) {
    const pair = selectionPair(prefs.selected);
    if (pair === undefined) continue;
    const resolved = resolveProviderModel(config, pair[0], pair[1], findEffective);
    if (resolved !== undefined) return resolved;
  }

  if (legacyActiveModel !== undefined) {
    try {
      return findModel(config.models, legacyActiveModel);
    } catch (e) {
      if (!(e instanceof CatalogError)) throw e;
    }
  }

  if (appDefaultModel !== undefined) {
    // May be a static alias *or* a `provider:model_id` reference, so route
    // through the effective catalog — a config with zero `[chat.*]` entries
    // can still name its default model.
    try {
      return findEffective(config, config.dirs.cache, appDefaultModel, true);
    } catch {
      // Fall through to the first-chat-model default.
    }
  }

  return firstChatModel(config.models);
}

/**
 * Patch a `ResolvedModel` with a sampler overlay. Returns a fresh model —
 * never mutates the catalog entry.
 */
export function applySamplerOverlay(
  model: ResolvedModel,
  overlay: SamplerSettings,
): ResolvedModel {
  const patched: ResolvedModel = { ...model };

  const direct = [
    ["temperature", "temperature"],
    ["topP", "topP"],
    // `"off"` is the explicit-disable sentinel and is PRESERVED here rather
    // than collapsed away: the request builder translates it into an explicit
    // thinking-off signal, which is what lets the OpenRouter adapter send
    // `reasoning.effort = "none"`. Merely omitting the field would leave an
    // always-on reasoning model reasoning by default.
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
    ["zaiSubscription", "zaiSubscription"],
  ] as const satisfies readonly (readonly [keyof SamplerSettings, keyof ResolvedModel])[];

  for (const [field, target] of direct) {
    const value = overlay[field];
    // The pairs above are checked by `satisfies`, but TypeScript widens both
    // sides across the loop, so the per-pair correspondence has to be asserted.
    if (value !== undefined) (patched as unknown as Record<string, unknown>)[target] = value;
  }

  if (overlay.sdk !== undefined) {
    // The setter validates before this reaches the file, so anything
    // unparseable here is a corrupted edit: log and keep the catalog's sdk.
    const sdk = sdkFromWire(overlay.sdk);
    if (sdk === undefined) {
      console.warn(
        `shore: preferences overlay for ${patched.qualifiedName} carries unknown sdk ` +
          `"${overlay.sdk}"; keeping catalog value`,
      );
    } else {
      patched.sdk = sdk;
    }
  }

  return patched;
}

/**
 * Layer the global+character overlay onto a resolved model.
 *
 * A missing preferences file produces empty defaults rather than a warning;
 * other errors are logged with `op` for forensics and the raw model returned
 * so the caller can proceed.
 */
export function overlayForCharacter(
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
    console.warn(
      `shore: preferences load failed for ${character} (${op}); using raw model settings: ` +
        `${(e as Error).message}`,
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

/**
 * The model for a background task, with the per-character overlay applied.
 *
 * 1. `defaults.background.<task>`
 * 2. `defaults.background.model`
 * 3. The character's currently-selected chat model
 * 4. `defaults.model`
 * 5. First chat model in the catalog
 *
 * Steps 3–5 are {@link resolveChatModelForCharacter}'s chain, so an unset
 * `[defaults.background]` means background tasks follow whatever model the
 * character uses for chat.
 *
 * Before this existed, every background-task site re-implemented the chain and
 * either forgot the overlay or copy-pasted it inconsistently. The missing
 * overlay silently dropped per-character `max_output_tokens`, capping
 * responses at 4096 and truncating compaction XML mid-element.
 */
export function resolveBackgroundModel(
  config: LoadedConfigView,
  task: BackgroundTask,
  character: string,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  const name = config.app.defaults.backgroundModelName(task);
  if (name === undefined) {
    // No background-specific model configured — follow the character's chat
    // model so a `shore model <name>` swap moves background work too.
    return resolveChatModelForCharacter(config, character, findEffective);
  }

  let base: ResolvedModel;
  try {
    // Route through the effective catalog so a pin written as
    // `provider:model_id` resolves with no static `[chat.*]` entry.
    base = findEffective(config, config.dirs.cache, name, true);
  } catch (e) {
    // The user *explicitly* configured a model for this task but it doesn't
    // resolve — almost always a typo. Warn loudly and fall back so the daemon
    // stays up.
    console.warn(
      `shore: configured ${task} model "${name}" not found in catalog for ${character}; ` +
        `falling back to active chat model: ${(e as Error).message}`,
    );
    return resolveChatModelForCharacter(config, character, findEffective);
  }
  return overlayForCharacter(config.dirs.data, character, base, task);
}

/**
 * The user's currently-selected chat model with the sampler overlay applied,
 * mirroring what a fresh chat request would build.
 *
 * Used by the heartbeat cold-rebuild path so the rebuilt request shares
 * chat's cache prefix instead of diverging on a stale `defaults.model`.
 */
export function resolveChatModelForCharacter(
  config: LoadedConfigView,
  character: string,
  findEffective: FindEffectiveModel,
): ResolvedModel | undefined {
  let global = emptyPreferences();
  let charPrefs = emptyPreferences();
  try {
    [global, charPrefs] = loadForCharacter(config.dirs.data, character);
  } catch (e) {
    console.warn(
      `shore: preferences load failed for ${character} (resolve_chat_model); ` +
        `using empty defaults: ${(e as Error).message}`,
    );
  }

  const legacy = loadActiveModel(join(config.dirs.data, character));
  const resolved = resolveActiveForCharacter(
    config,
    global,
    charPrefs,
    legacy,
    config.app.defaults.model,
    findEffective,
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


// ── TOML reading and writing ────────────────────────────────────────────

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
  const unknown = unknownField(table, SAMPLER_KEYS);
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
    ["zaiSubscription", "zai_subscription"],
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

/** `all` | `none`, with legacy bool configs still accepted. */
function readThinkingReplay(value: unknown): ReadResult<ThinkingReplay> {
  if (typeof value === "boolean") return { ok: value ? "all" : "none" };
  if (value === "all" || value === "none") return { ok: value };
  return {
    err: `invalid replay_prior_thinking ${JSON.stringify(value)}; ` +
      `expected "all", "none" (or legacy true/false)`,
  };
}

function readPreferences(table: Record<string, unknown>): ReadResult<ModelPreferences> {
  const unknown = unknownField(table, ["selected", "defaults", "models"]);
  if (unknown !== undefined) return { err: unknown };

  const out = emptyPreferences();

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

  const models = table["models"];
  if (models !== undefined) {
    if (!isTable(models)) return { err: "invalid type: expected a table for `models`" };
    const entries: [string, ModelPreference][] = [];
    for (const key of sortedKeys(models)) {
      const value = models[key];
      if (!isTable(value)) return { err: `invalid type: expected a table for \`${key}\`` };
      const read = readSampler(value);
      if ("err" in read) return read;
      entries.push([key, { sampler: read.ok }]);
    }
    // Already in BTreeMap order: `sortedKeys` above walks the table in it.
    out.models = new Map(entries);
  }

  return { ok: out };
}

/**
 * Serialize to TOML.
 *
 * Hand-rolled rather than delegated: Bun ships a TOML *parser* but no
 * serializer, and this file is user-facing — it is what `cat models.toml`
 * shows. Written in the same section order `toml::to_string_pretty` produces
 * so a round-trip through the daemon does not reshuffle a user's file.
 */
export function serializePreferences(prefs: ModelPreferences): string {
  const blocks: string[] = [];

  // `toml::to_string_pretty` emits every top-level table header, populated or
  // not, so an empty file still shows the schema. Reproduced because the file
  // is user-facing and both implementations may write it during migration.
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

  return `${blocks.join("\n\n")}\n`;
}

function samplerLines(sampler: SamplerSettings): string[] {
  const out: string[] = [];
  for (const [field, key] of SAMPLER_FIELDS) {
    const value = sampler[field];
    if (value === undefined) continue;
    if (field === "cacheKeepalive") {
      out.push(`${key} = ${tomlString(keepaliveToString(value as CacheKeepaliveSetting))}`);
    } else if (field === "temperature" || field === "topP") {
      // A TOML float must keep its decimal point: `temperature = 1` re-reads
      // as an integer, which the Rust `f64` field rejects outright. This is
      // the one place the port has to know a field's TOML type, because a
      // JavaScript number carries no such distinction.
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

/** Always emits a decimal point, so the value re-reads as a TOML float. */
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

/**
 * How serde phrases the accepted set. Two fields get `a` or `b`; three or more
 * get a comma list under `one of`. Matching this exactly is what makes the
 * unknown-field errors compare byte for byte.
 */
function expectedList(known: readonly string[]): string {
  if (known.length === 1) return `\`${known[0]}\``;
  if (known.length === 2) return `\`${known[0]}\` or \`${known[1]}\``;
  const head = known.slice(0, -1).map((k) => `\`${k}\``).join(", ");
  return `one of ${head}, \`${known[known.length - 1]}\``;
}
