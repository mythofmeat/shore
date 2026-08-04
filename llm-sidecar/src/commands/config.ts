/**
 * The configuration half of the SWP command surface: what the tool surface
 * looks like, whether the config is sane, what is in it, and reloading it.
 *
 * Ported from `crates/daemon/src/commands/state/config.rs`, pinned by
 * `tests/commands_fixtures/config_commands_parity.json`.
 *
 * # Four sections the Rust serialises and this does not
 *
 * `config` ships the whole `AppConfig` twice — effective and default — so the
 * client can diff them. The Rust at the fixture's commit still had
 * `memory.dreaming`, `tools.sandbox`, `connections.matrix` and
 * `defaults.dreaming`; all four were removed from the schema earlier in this
 * rewrite, and `config_fixtures/app_parity.json` pins three of them as
 * *rejected* unknown fields. So the blob this returns is the current schema's,
 * and the replay strips those four from the recorded side rather than pretending
 * the port reintroduces them. Every other field, and every value, matches.
 *
 * # Ordering is the safety property in `configReload`
 *
 * Prompts are refreshed *before* the fresh config is adopted, so that an I/O
 * failure leaves the daemon wholly on the previous state rather than half on
 * each. Validation — global, then every character overlay — happens before
 * either. The runtime hooks are an interface here rather than the Rust's
 * `ctx.autonomy` and `ctx.llm_client` because those two are separate units of
 * this phase; what this module owes them is a call, in order, which is exactly
 * what the interface says.
 */

import { join } from "node:path";

import { ConfigDuration } from "../config/duration.ts";
import { discoverCharacters, type Env } from "../config/dirs.ts";
import { ConfigError, loadCharacterConfig, loadConfig, type LoadedConfig } from "../config/loader.ts";
import { findModel } from "../config/models.ts";
import type { ResolvedModel } from "../config/models.ts";
import { serializeConfigValue } from "../config/serialize.ts";
import { defaultAppConfig } from "../config/app.ts";
import { applyDeferredEdits, changedPromptFiles } from "../memory/deferred_edits.ts";
import { ALL_TOOLS, toolEnabled } from "../tools/registry.ts";
import { internalError, invalidRequest, notFound } from "./errors.ts";
import type { Args } from "./navigation.ts";

/**
 * What `configReload` and `configReset` have to tell the rest of the daemon.
 *
 * The Rust called four methods across `ctx.autonomy` and `ctx.llm_client`.
 * Naming them here keeps the ordering rule testable without this module
 * depending on either subsystem.
 */
export interface ConfigRuntime {
  /** The scheduler's copy of the runtime config. */
  reloadRuntimeConfig(fresh: LoadedConfig): void;
  /** The ledger's usage/budget settings. */
  setUsageConfig(fresh: LoadedConfig): void;
  /** The ceiling on how long a cache keepalive may stretch. */
  setCacheKeepaliveCeiling(ceiling: ConfigDuration): void;
  /** Drop the cached background request, which still holds the old prompt. */
  notifyPromptSnapshotRefreshed(character: string): void;
}

export interface ConfigContext {
  /** Mutated in place by `configReload` and `configReset`, as the Rust did. */
  config: LoadedConfig;
  /** The file the daemon was pointed at; reloads re-read exactly this. */
  configPath: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  activeResolvedModel: ResolvedModel | undefined;
  runtime: ConfigRuntime;
  /**
   * The environment the daemon resolved its directories from.
   *
   * Threaded through the reloads on purpose: `load_config` in the Rust read the
   * process environment every time, so a reload always landed on the same
   * `ShoreDirs`. Here the loader takes the environment as an argument, and
   * leaving it out would let a reload silently re-resolve XDG and move the data
   * directory out from under the running daemon.
   */
  env?: Env;
}

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asBool = (v: unknown): boolean => v === true;

const message = (e: unknown): string =>
  e instanceof ConfigError ? e.display : e instanceof Error ? e.message : String(e);

// ── tools ─────────────────────────────────────────────────────────────────

/**
 * The effective tool surface: every registered tool, whether the main character
 * has it, and which enabled sub-agents own it.
 *
 * The roster is the *registry's*, not the config's — every tool that exists
 * appears, and the config only moves `main`. Dangling references are reported
 * rather than dropped, because a typo in `enabled_tools` is otherwise silent:
 * the tool simply never turns on and nothing says why.
 */
export function tools(ctx: ConfigContext): unknown {
  const cfg = ctx.config.app.tools;
  const subagents = ctx.config.app.subagents;
  const known = new Set(ALL_TOOLS.map((t) => t.name));

  const toolRows = ALL_TOOLS.map((def) => ({
    tool: def.name,
    main: toolEnabled(cfg, def.name),
    subagents: cfg.enabled_subagents.filter((s) =>
      (subagents.get(s)?.tools ?? []).some((t) => t === def.name),
    ),
  }));

  // `BTreeMap` order, which is what a client renders the roster in. The
  // loader already stores these sorted, so this sort cannot be observed and no
  // mutant that removes it can be killed. It stays because the ordering is a
  // property of *this* answer — a roster a person reads — rather than something
  // to inherit from whichever map type the loader happens to build.
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

// ── config_check ──────────────────────────────────────────────────────────

/**
 * Validate what is loaded and report it as warnings and information.
 *
 * `valid` is "no warnings at all", so a missing default model makes the whole
 * report invalid — it is not graded by severity. The no-default-model warning
 * is gated on the catalog being non-empty, so an empty config produces one
 * warning rather than two saying the same thing.
 */
export function configCheck(ctx: ConfigContext, env: NodeJS.ProcessEnv = process.env): unknown {
  const warnings: string[] = [];
  const info: string[] = [];

  if (ctx.config.models.chat.size === 0) {
    warnings.push(
      "No chat models configured. Add a [providers.*] entry and set " +
        "[defaults].model to a provider:model_id.",
    );
  } else {
    info.push(`${ctx.config.models.chat.size} chat model(s) configured`);
  }

  const defaultModel = ctx.config.app.defaults.model;
  if (defaultModel !== undefined) {
    let found = true;
    try {
      findModel(ctx.config.models, defaultModel);
    } catch {
      found = false;
    }
    if (found) info.push(`Default model: ${defaultModel}`);
    else warnings.push(`Default model "${defaultModel}" not found in catalog`);
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
    memory_mode: "markdown",
  };
}

// ── config, read and set ──────────────────────────────────────────────────

/**
 * Read the config, a section of it, or set one of three runtime overrides.
 *
 * It is a set only when `key` *and* `value` are both strings; a `value` with no
 * `key` is still a read, and a non-string `key` is no key at all.
 */
export function config(ctx: ConfigContext, args: Args): unknown {
  const key = asStr(args["key"]);
  const value = asStr(args["value"]);
  if (key !== undefined && value !== undefined) return configSet(ctx, key, value);

  const app = serializeConfigValue(ctx.config.app) as Record<string, unknown>;
  const defaults = serializeConfigValue(defaultAppConfig()) as Record<string, unknown>;

  if (key === undefined) return { config: app, defaults };
  if (!(key in app)) throw notFound(`Config section not found: ${key}`);
  return { key, config: app[key], defaults: defaults[key] ?? null };
}

/**
 * The three keys that can move at runtime.
 *
 * The model arm echoes the key *as spelled* while the autonomy arm echoes its
 * canonical name; that asymmetry is the Rust's and is pinned rather than
 * tidied. Setting the model also drops `activeResolvedModel`, because the
 * pre-resolved value no longer matches the name beside it and the next command
 * has to resolve again.
 */
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

/**
 * `loadConfig`'s options, with `env` present only when the context carries one.
 *
 * `exactOptionalPropertyTypes` distinguishes an absent key from one spelled
 * `undefined`, and the loader's default only applies to the former.
 */
const loaderOptions = (ctx: ConfigContext): { env?: Env } =>
  ctx.env === undefined ? {} : { env: ctx.env };

/** Rust's `bool::from_str`, which takes exactly `true` and `false`. */
function parseBool(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("expected true or false");
}

// ── config_reload ─────────────────────────────────────────────────────────

/**
 * Re-read the config from disk, in two phases the client drives.
 *
 * `{}` validates and reports which prompt-visible files differ from the active
 * snapshot, changing nothing. `{apply: true}` re-validates and then adopts.
 * Unlike `configReset`, runtime overrides survive — the active model is not
 * cleared.
 *
 * Order is the safety property. Validation of the global config and of *every*
 * character overlay happens first, so a typo in one character's `config.toml`
 * aborts the whole reload rather than silently falling back at merge time.
 * Then, if asked, prompts are refreshed; only then is the config adopted. An
 * I/O failure at the refresh step therefore leaves the daemon entirely on the
 * old state.
 */
export async function configReload(ctx: ConfigContext, args: Args): Promise<unknown> {
  const apply = asBool(args["apply"]);
  const refreshPrompts = asBool(args["refresh_prompts"]);

  let fresh: LoadedConfig;
  try {
    fresh = loadConfig(ctx.configPath, loaderOptions(ctx));
  } catch (e) {
    throw invalidRequest(`Config error: ${message(e)}`);
  }

  for (const name of discoverCharacters(fresh.dirs.config)) {
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
  const changed = await changedPromptFiles(characterDataDir, fresh.dirs.config, character);

  // `restart_required` is the dispatcher's annotation, not this command's: it
  // compares global to global, and this context holds the character-merged
  // config, which would make every overlay look like a restart.
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
      await applyDeferredEdits(characterDataDir, fresh.dirs.config, character);
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

// ── config_reset ──────────────────────────────────────────────────────────

/**
 * Drop every runtime override and reload from disk.
 *
 * The same adoption as `configReload`, plus clearing the active model — which
 * is the whole difference between the two — and a different error code for the
 * same broken file: `internal_error` here, `invalid_request` there. Both are
 * the Rust's and both are pinned.
 */
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

/** Hand the fresh config to everyone who caches part of it, then take it. */
function adopt(ctx: ConfigContext, fresh: LoadedConfig): void {
  ctx.runtime.reloadRuntimeConfig(fresh);
  ctx.runtime.setUsageConfig(fresh);
  ctx.runtime.setCacheKeepaliveCeiling(fresh.app.behavior.autonomy.cache_keepalive_max);
  ctx.config = fresh;
}
