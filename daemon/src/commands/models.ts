/**
 * The model half of the SWP command surface: listing what is selectable,
 * describing one, switching between them, and reading or writing the per-model
 * settings.
 *
 * Ported from the command half of `crates/daemon/src/commands/state/models.rs`,
 * pinned by `tests/commands_fixtures/models_parity.json`. The parsing and
 * capability half is in `./model_settings.ts`.
 *
 * # A discovered model's qualified name is not a resolver input
 *
 * `chat.<provider>.<model_id>` is a display-only synthetic name. Feeding it back
 * to the resolver always misses, which is why the session carries a
 * *pre-resolved* {@link ModelsContext.activeResolvedModel} beside the name the
 * user typed: every path that needs the active model reads that first and only
 * falls back to resolving a string when it is absent. Persistence uses
 * `(provider, model_id)` for the same reason — an alias survives a rename of
 * the catalog key, and a discovered model has no catalog key at all.
 *
 * # `include_hidden` is per-call, and it moves more than the list
 *
 * `discovery.ignore` hides a model from `list_models` *and* from selection. The
 * flag opts past both for one call, and — since the reported active model falls
 * back to the first entry when nothing is selected — passing it can change which
 * model a fresh session reports as active. That is the Rust's behaviour and the
 * fixture pins it.
 */

import {
  EffectiveCatalogError,
  findEffectiveModel,
  listEffectiveModels,
  type EffectiveModel,
} from "../config/effective_catalog.ts";
import { resolvedModelToWire, type ResolvedModel } from "../config/models.ts";
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
  resolveBackgroundModel,
  resolveChatModelForCharacter,
  resolveSamplerSettings,
  resolveSamplerScopes,
  samplerIsEmpty,
  saveCharacterPreferences,
  saveGlobalPreferences,
  SAMPLER_KEYS,
  type BackgroundTask,
  type ModelPreferences,
  type SamplerScopes,
  type SamplerSettings,
} from "../config/preferences.ts";
import { reasoningDomain } from "../llm/capabilities.ts";
import { applySamplerValue, capabilityCheck, keyApplicability } from "./model_settings.ts";
import { internalError, invalidRequest, notFound, type CommandError } from "./errors.ts";

/** Args arrive as a decoded JSON object; every field is optional and untyped. */
export type Args = Record<string, unknown>;

/**
 * What these commands need from the session.
 *
 * The Rust's `CommandContext` carried a `data_dir` beside `config.dirs.data`.
 * They are the same path — `main.rs` builds the context from
 * `loaded.dirs.data` — and this module was the only place that read the
 * standalone one, so there is one field here.
 *
 * `activeModel` and `activeResolvedModel` are mutable: `switchModel` and
 * `resetModel` move them, and the next command in the same connection reads
 * what they left.
 */
export interface ModelsContext {
  config: LoadedConfig;
  dataDir: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  activeResolvedModel: ResolvedModel | undefined;
}

// ── shared resolution ─────────────────────────────────────────────────────

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** A non-empty string argument, which is how the Rust treated `""` — as absent. */
const asName = (v: unknown): string | undefined => {
  const s = asStr(v);
  return s === undefined || s === "" ? undefined : s;
};

function catalogError(e: unknown): CommandError {
  if (!(e instanceof EffectiveCatalogError)) {
    return internalError(e instanceof Error ? e.message : String(e));
  }
  // A name that is merely ambiguous is the caller's to disambiguate; one that is
  // missing or hidden is a lookup that found nothing it may return.
  return e.kind === "ambiguous" ? invalidRequest(e.message) : notFound(e.message);
}

/** `findEffectiveModel`, with the catalog's failures already mapped. */
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

/**
 * The model this session is on.
 *
 * The pre-resolved selection wins outright — see the note at the top about
 * synthetic qualified names — and `includeHidden` is true on the fallback path
 * because the user has already explicitly chosen this selection; hiding it from
 * them now would be refusing to describe what they are using.
 */
function resolveActiveModel(ctx: ModelsContext): ResolvedModel {
  if (ctx.activeResolvedModel !== undefined) return ctx.activeResolvedModel;
  const name = ctx.activeModel ?? ctx.config.app.defaults.model;
  if (name === undefined) throw invalidRequest("No model specified and no active model set");
  return resolve(ctx, name, true);
}

const BACKGROUND_TASKS: readonly BackgroundTask[] = ["heartbeat", "compaction"];

function backgroundTask(selector: string): BackgroundTask {
  if (selector === "heartbeat" || selector === "compaction") return selector;
  throw invalidRequest(
    `unknown background task: ${selector}; expected all, heartbeat, or compaction`,
  );
}

/**
 * The *base* model behind a background task: the config pin, or the character's
 * active chat model when there is none.
 *
 * Deliberately without the sampler overlay, unlike `resolveBackgroundModel` —
 * this only needs the `provider:model_id` identity to key a settings read or
 * write onto, so a user can tune the heartbeat's model without first switching
 * chat to it.
 */
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

/**
 * The model a `background_task` selector names. `"all"` only works when every
 * task collapses to one identity; otherwise it reports the mapping so the user
 * knows which task to target instead.
 */
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

/** A `background_task` selector beats an explicit `name`, which beats the active model. */
function settingTarget(ctx: ModelsContext, args: Args): ResolvedModel {
  const selector = asStr(args["background_task"]);
  if (selector !== undefined) return backgroundSettingTarget(ctx, selector);

  const name = asName(args["name"]);
  if (name !== undefined) return resolve(ctx, name, true);

  return resolveActiveModel(ctx);
}

// ── background_models ─────────────────────────────────────────────────────

/**
 * Which model each background task resolves to, and where that came from.
 *
 * Read-only companion to `[defaults.background]`. A pin that does not resolve
 * is reported as the raw name rather than as an error — this is a diagnostic,
 * and "you pinned something that is not there" is more useful than a failure.
 */
export function backgroundModels(ctx: ModelsContext): unknown {
  const bg = ctx.config.app.defaults.background;
  const background = BACKGROUND_TASKS.map((task) => {
    const perTask = bg[task];
    const pinned = perTask ?? bg.model;
    if (pinned !== undefined) {
      let qualified = pinned;
      try {
        qualified = findEffectiveModel(
          configView(ctx.config),
          ctx.config.dirs.cache,
          pinned,
          true,
        ).qualifiedName;
      } catch {
        // Keep the name the user wrote.
      }
      return {
        task,
        model: qualified,
        source: perTask !== undefined ? `config: background.${task}` : "config: background.model",
      };
    }

    const inherited =
      ctx.characterName === undefined
        ? undefined
        : resolveChatModelForCharacter(configView(ctx.config), ctx.characterName, findEffective);
    return {
      task,
      model: inherited?.qualifiedName ?? "(unresolved)",
      source: "inherited: active chat model",
    };
  });
  return { background };
}

// ── list_models ───────────────────────────────────────────────────────────

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

/**
 * The canonical name of the active selection, for the client's marker.
 *
 * Four sources in order: the pre-resolved model, the session's string, the
 * config default, and — when none of those is set — the first entry in the list
 * *as filtered*, which is why `include_hidden` can move it.
 *
 * The two string paths fall back through the plain catalog and then to the raw
 * string, so a name that resolves nowhere is still reported rather than
 * silently becoming "no active model".
 */
function activeName(ctx: ModelsContext, entries: EffectiveModel[]): string | undefined {
  if (ctx.activeResolvedModel !== undefined) return ctx.activeResolvedModel.qualifiedName;

  // The Rust had a second fallback here — retry through the plain catalog —
  // which cannot fire: `findEffectiveModel` *starts* with that same lookup and
  // only reaches its own paths once it has failed. Dropped rather than ported.
  const byName = (name: string): string => {
    try {
      return findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, name, true)
        .qualifiedName;
    } catch {
      return name;
    }
  };

  const active = ctx.activeModel;
  if (active !== undefined && active !== "") return byName(active);

  const fallback = ctx.config.app.defaults.model;
  if (fallback !== undefined && fallback !== "") return byName(fallback);

  return entries[0]?.resolved.qualifiedName;
}

/**
 * The selectable chat models. Tool-only, embedding and image-generation
 * profiles are excluded on purpose: they are not chat targets.
 */
export function listModels(ctx: ModelsContext, args: Args): unknown {
  const includeHidden = asBool(args["include_hidden"]) ?? false;
  const view = configView(ctx.config);
  const entries = listEffectiveModels(view, ctx.config.dirs.cache, includeHidden);

  // The count is of everything hidden, not of what this call returned, so it
  // stays a stable "and N more" no matter which way the flag went.
  const hiddenCount = (includeHidden
    ? entries
    : listEffectiveModels(view, ctx.config.dirs.cache, true)
  ).filter((e) => e.hidden).length;

  return {
    models: entries.map(effectiveModelToJson),
    active: activeName(ctx, entries) ?? null,
    include_hidden: includeHidden,
    hidden_count: hiddenCount,
  };
}

// ── model_info ────────────────────────────────────────────────────────────

/** The ten scope fields `model_info` reports — the vendor knobs are not among them. */
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

/** The sampler view in the fixture's spelling: every key present, absent as null. */
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

/**
 * Everything about one model: the resolved catalog entry, plus — when a
 * character is attached — the effective sampler and which layer set each field.
 *
 * Without a character there is no preference stack to read, so the two extra
 * keys are absent rather than empty.
 */
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

// ── switch_model / reset_model ────────────────────────────────────────────

/**
 * Select a model, or report the current selection when given no name.
 *
 * The session keeps the *name the user typed* so CLI flows that echo it keep
 * working, while the file records `(provider, model_id)` so an alias survives.
 * The resolved model is parked alongside so the next command in the same
 * connection need not re-resolve — and for a discovered model, cannot.
 */
export function switchModel(ctx: ModelsContext, args: Args): unknown {
  const name = asStr(args["name"]);
  if (name === undefined) return { active: ctx.activeModel ?? null };

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

/** Clear the character's selection so it falls back through the config chain. */
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

// ── set_model_setting ─────────────────────────────────────────────────────

/**
 * Write one sampler field into the character's or the global preferences.
 *
 * The order is load-bearing. The target model is resolved first, because the
 * capability check needs its sdk; the check runs before the file is read, so a
 * refused setting never touches it; and an entry whose sampler ends up empty is
 * removed rather than left as an empty table.
 */
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
  const failure = capabilityCheck(target.sdk, target.modelId, key, value);
  if (failure !== undefined) throw failure;

  const character = scope === "character" ? requireCharacter(ctx) : undefined;
  const prefs =
    character === undefined ? loadGlobalPreferences(ctx) : loadCharacterPreferences(ctx, character);

  const entryKey = preferenceKey(target.providerKey, target.modelId);
  const entry = prefs.models.get(entryKey) ?? { sampler: {} };
  applySamplerValue(entry.sampler, key, value);

  // An entry whose sampler is now empty is dropped rather than left behind as
  // an empty table, so the file stays a record of what the user actually set.
  if (samplerIsEmpty(entry.sampler)) prefs.models.delete(entryKey);
  else prefs.models.set(entryKey, entry);

  if (character === undefined) saveGlobal(ctx, prefs);
  else saveCharacter(ctx, character, prefs);

  return {
    changed: true,
    scope,
    model: target.qualifiedName,
    provider: target.providerKey,
    model_id: target.modelId,
    key,
    value,
  };
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

// ── model_settings ────────────────────────────────────────────────────────

/** All fourteen keys, unlike `model_info`'s ten. */
const SETTINGS_SCOPE_FIELDS = [
  ...INFO_SCOPE_FIELDS,
  ["openrouter_provider", "openrouterProvider"],
  ["gemini_generation", "geminiGeneration"],
  ["zai_clear_thinking", "zaiClearThinking"],
  ["zai_subscription", "zaiSubscription"],
] as const satisfies readonly (readonly [string, keyof SamplerSettings])[];

/**
 * The effective settings for a model, what each layer saved, and how the sdk
 * treats every key.
 *
 * With no character attached both preference layers are empty — including the
 * *global* one, which does exist on disk. That is the Rust's behaviour: it
 * loads the pair or neither.
 */
export function modelSettings(ctx: ModelsContext, args: Args): unknown {
  const target = settingTarget(ctx, args);
  const character = ctx.characterName;
  const [global, charPrefs] =
    character === undefined
      ? [emptyPreferences(), undefined]
      : loadPreferencesFor(ctx.dataDir, character);

  const sampler = resolveSamplerSettings(
    global,
    charPrefs,
    target.providerKey,
    target.modelId,
    target,
  );
  const scopes = resolveSamplerScopes(
    global,
    charPrefs,
    target.providerKey,
    target.modelId,
    target,
  );
  const saved = (prefs: ModelPreferences | undefined): unknown => {
    const entry = prefs === undefined ? undefined : modelPreference(prefs, target.providerKey, target.modelId);
    return entry === undefined ? null : samplerJson(entry.sampler);
  };

  return {
    model: target.qualifiedName,
    provider: target.providerKey,
    model_id: target.modelId,
    effective_sampler: samplerJson(sampler),
    saved_global: saved(global),
    saved_character: saved(charPrefs),
    applicability: keyApplicability(target.sdk, target.modelId),
    reasoning_effort_domain: reasoningDomain(target.sdk, target.modelId),
    scopes: scopesJson(scopes, SETTINGS_SCOPE_FIELDS),
  };
}
