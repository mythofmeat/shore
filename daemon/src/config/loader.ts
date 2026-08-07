/**
 * Shore's config loading: `config.toml`, `include = [...]`, `conf.d/`, the
 * config-local `.env`, the deep merge that composes them, and the two-phase
 * parse that turns the merged table into a validated `LoadedConfig`.
 *
 * Ports `crates/common/src/config/mod.rs`. The file semantics came first
 * (cab4f1a5) because everything in that half operates on raw TOML tables and
 * could move before `app.rs` did; `parseConfigTable` and `validateConfig` are
 * the rest, and they need `AppConfig`, `ModelCatalog` and `ProviderRegistry`
 * all three.
 *
 * `deepMerge` is the whole reason the raw table is retained on a loaded config
 * at all. A character override is applied to the *unparsed* global table and
 * the result re-parsed from scratch, rather than merged field-by-field over a
 * parsed struct — so a character can set `[tools] enabled_tools` without
 * inheriting the global list, and a table it does not mention keeps every
 * global key.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { compareByCodePoint } from "../sort.ts";
import {
  budgetPeriodRank,
  normalizeDeprecatedAliases,
  parseAppConfig,
  validateCompaction,
  type AppConfig,
  type UsageBudgetConfig,
  type UsageConfig,
} from "./app.ts";
import {
  rustJoin,
  resolveShoreDirs,
  type Env,
  type HomeLookup,
  type ShoreDirs,
} from "./dirs.ts";
import { applyDotenv } from "./dotenv.ts";
import { rustTrim } from "./duration.ts";
import { catalogFromSections, findModel, CatalogError, type ModelCatalog } from "./models.ts";
import { ProviderRegistry, ProviderRegistryError } from "./providers.ts";

/** A parsed TOML table. */
export type TomlTable = Record<string, unknown>;

/** Raw Shore TOML after `include` and `conf.d/` merging. */
export interface RawConfigTable {
  table: TomlTable;
  dirs: ShoreDirs;
}

/** Which stage of loading failed. Mirrors the `ConfigError` variants. */
export type ConfigErrorKind =
  | "read_file"
  | "parse_app"
  | "parse_include"
  | "conf_d"
  | "catalog"
  | "provider_registry"
  | "validation";

/** A config load failure, carrying the path it happened at where there is one. */
export class ConfigError extends Error {
  readonly kind: ConfigErrorKind;
  readonly path: string | undefined;

  constructor(kind: ConfigErrorKind, message: string, path?: string) {
    super(message);
    this.name = "ConfigError";
    this.kind = kind;
    this.path = path;
  }

  /**
   * The message the Rust's `thiserror` `#[error(..)]` attribute produces.
   *
   * Only the semantic half is reproduced. The `toml` crate decorates a parse
   * error with a line/caret frame whose shape is inconsistent between
   * otherwise identical failures, and three earlier fixtures in this series
   * already stop short of it for the same reason.
   */
  get display(): string {
    switch (this.kind) {
      case "read_file":
        return `failed to read ${this.path}: ${this.message}`;
      case "parse_app":
        return `failed to parse config.toml: ${this.message}`;
      case "parse_include":
        return `failed to parse include file ${this.path}: ${this.message}`;
      case "conf_d":
        return `failed to parse conf.d file ${this.path}: ${this.message}`;
      case "catalog":
        return `failed to parse model catalog: ${this.message}`;
      case "provider_registry":
        return `failed to parse provider registry: ${this.message}`;
      case "validation":
        return `validation error: ${this.message}`;
    }
  }
}

// --- merging ---------------------------------------------------------------

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `overlay` into `base`, in place.
 *
 * Tables recurse; everything else is overwritten wholesale. Arrays in
 * particular are *replaced*, not concatenated — a character's
 * `tools.enabled_tools` is its own list and not an addition to the global one.
 *
 * The walk is over `overlay`'s keys in code-point order, matching the Rust's
 * iteration of a `toml::Table` (`BTreeMap`, since the `toml` crate is built
 * without `preserve_order`).
 *
 * That sort is an unkillable mutant and is kept deliberately. Every key is
 * written exactly once, so the merged *contents* cannot depend on the order;
 * what does depend on it is the merged object's own key order, which decides
 * which key a later `deny_unknown_fields` parse reports first when a document
 * has two bad ones. Every consumer in this codebase reaches that table through
 * `sortedKeys`, so nothing observes it today — but a consumer that walks the
 * table directly would, and it would then disagree with the daemon. Removing
 * the sort makes the port correct only for as long as that stays true.
 */
export function deepMerge(base: TomlTable, overlay: TomlTable): void {
  for (const key of Object.keys(overlay).sort(compareByCodePoint)) {
    const overlayVal = overlay[key];
    const baseVal = base[key];
    if (isTable(baseVal) && isTable(overlayVal)) {
      deepMerge(baseVal, overlayVal);
    } else {
      base[key] = overlayVal;
    }
  }
}

// --- reading ---------------------------------------------------------------

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readFileOrThrow(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError("read_file", (e as Error).message, path);
  }
}

/**
 * Apply `<configDir>/.env` to the environment, as the Rust's
 * `dotenvy::from_path_override` does.
 *
 * This is where provider API keys come from. `[providers.<key>] api_key_env`
 * names a variable and the credential layer reads it off `process.env` at call
 * time, so a daemon that skips this file has no keys for any provider and every
 * generation fails before it reaches the network — which is not obvious from
 * anything the config itself says.
 *
 * A missing file is the normal case and is silent. A file that exists but
 * cannot be read or parsed warns and is skipped, rather than failing the load:
 * that is dotenvy's behaviour and the Rust's, and it keeps a stray character in
 * a secrets file from making the daemon unstartable.
 */
function loadDotenv(
  configDir: string,
  target: Record<string, string | undefined>,
  onWarn: ConfigWarn,
): void {
  const path = rustJoin(configDir, ".env");
  if (!exists(path)) return;

  try {
    const applied = applyDotenv(path, target);
    if (applied.length > 0) {
      // Names only — the values are the secrets this file exists to hold. Worth
      // a line because the failure it makes visible is otherwise silent: the
      // daemon starts fine and only the first generation reveals there were no
      // credentials.
      console.info(`shore: loaded ${applied.length} variables from ${path}`);
    }
  } catch (e) {
    onWarn("Failed to load .env file", [
      ["path", path],
      ["error", e instanceof Error ? e.message : String(e)],
    ]);
  }
}

function parseToml(content: string, kind: ConfigErrorKind, path?: string): TomlTable {
  try {
    return Bun.TOML.parse(content) as TomlTable;
  } catch (e) {
    throw new ConfigError(kind, (e as Error).message, path);
  }
}

/**
 * Merge every `*.toml` under `dir` into `table`, in sorted filename order.
 *
 * A missing directory is not an error. Any *other* read failure is, and
 * deliberately so — the Rust distinguishes `NotFound` from a permissions or
 * I/O error precisely so that an unreadable `conf.d/` cannot silently load a
 * partial config.
 *
 * The extension test is `path.extension() == "toml"`, which is case-sensitive
 * (`.TOML` is skipped) and which yields `None` for a file named exactly
 * `.toml` — a dotfile with no stem has no extension in Rust's model, so it is
 * skipped too. Both are pinned.
 */
function loadConfD(dir: string, table: TomlTable): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ConfigError("read_file", (e as Error).message, dir);
  }

  const paths = entries
    .filter((name) => hasTomlExtension(name))
    .map((name) => rustJoin(dir, name))
    .sort(compareByCodePoint);

  for (const path of paths) {
    const content = readFileOrThrow(path);
    deepMerge(table, parseToml(content, "conf_d", path));
  }
}

/**
 * Rust's `Path::extension() == Some("toml")`.
 *
 * `extension` is the part after the final `.` of the file name, but only when
 * the name has a non-empty stem before it. `a.toml` has one; `.toml` does not;
 * `a.b.toml` has `toml`; `toml` has none.
 */
function hasTomlExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return name.slice(dot + 1) === "toml";
}

/**
 * Load `config.toml` plus its `include` list and `conf.d/` overlays into one
 * raw table, without deserializing any schema.
 *
 * Ordering is load-bearing and is the Rust's: `config.toml` first, then each
 * `include` entry in the order written, then `conf.d/*.toml` sorted by path.
 * So `conf.d` wins over `include`, which wins over `config.toml` — and `include`
 * files override the very file that listed them, which reads backwards until
 * you notice `include` is removed from the table before the merge.
 *
 * A missing `config.toml` is not an error: the Rust writes a commented starter
 * file and continues with an empty table. That write is a side effect on a
 * caller-supplied directory, so it is opt-in here via `createDefault` rather
 * than fired implicitly by a function whose name says "load".
 *
 * {@link createDefaultConfig} is that effect, and `startDaemon` is what opts in.
 * Anything else — a reload, a `config --check`, a test — loads without it and
 * writes nothing.
 */
export function loadRawConfigTable(
  configPath: string | undefined,
  options: {
    env?: Env;
    homeLookup?: HomeLookup;
    createDefault?: (configDir: string) => void;
    onWarn?: ConfigWarn;
    envTarget?: Record<string, string | undefined>;
  } = {},
): RawConfigTable {
  const dirs = resolveShoreDirs(options.env, options.homeLookup);

  // A custom config path re-homes the whole config directory, so character
  // lookups resolve beside the file the daemon was pointed at.
  const configDirectory = configPath === undefined ? dirs.config : parentOf(configPath);
  if (configPath !== undefined) dirs.config = configDirectory;

  const configFile = configPath ?? rustJoin(configDirectory, "config.toml");

  loadDotenv(configDirectory, options.envTarget ?? process.env, options.onWarn ?? consoleConfigWarn);

  let table: TomlTable;
  if (exists(configFile)) {
    table = parseToml(readFileOrThrow(configFile), "parse_app");
  } else {
    options.createDefault?.(configDirectory);
    table = {};
  }

  // `include` is *removed*, not merely read, so it never reaches `AppConfig`
  // — which is `deny_unknown_fields` and would reject it.
  const includes = table.include;
  delete table.include;
  if (Array.isArray(includes)) {
    for (const item of includes) {
      if (typeof item !== "string") continue;
      const includePath = rustJoin(configDirectory, item);
      // A missing include is skipped with a warning, not an error. An include
      // that exists but does not parse is fatal.
      if (!exists(includePath)) continue;
      deepMerge(table, parseToml(readFileOrThrow(includePath), "parse_include", includePath));
    }
  }

  loadConfD(rustJoin(configDirectory, "conf.d"), table);

  return { table, dirs };
}

/**
 * `Path::parent()`, falling back to `.` as the Rust's `unwrap_or(Path::new("."))`
 * does.
 *
 * `parent` is the path minus its final component, without normalizing: the
 * parent of `a/b` is `a`, of `/x` is `/`, and of a bare `config.toml` is the
 * empty string — which is why the Rust's fallback exists at all, since an empty
 * parent is `Some("")` rather than `None` only for rooted paths. A bare
 * filename yields `Some("")`, so the config directory becomes `""` and every
 * lookup below it is relative to the process's working directory.
 */
export function parentOf(path: string): string {
  // Trailing separators are not components: the parent of `a/b/` is `a`.
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end -= 1;
  const trimmed = path.slice(0, end);

  // The root has no parent — the only input for which the Rust's `unwrap_or`
  // actually fires.
  if (trimmed === "/") return ".";

  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return "";
  if (slash === 0) return "/";
  return trimmed.slice(0, slash);
}

/**
 * Apply a character's `characters/{name}/config.toml` over a global raw table.
 *
 * Returns `undefined` when the character has no override file, which is the
 * common case and is not an error. The merge is against a *copy* of the global
 * table, so repeated calls for different characters cannot contaminate each
 * other — the Rust clones for the same reason.
 */
export function loadCharacterConfigTable(
  global: RawConfigTable,
  characterName: string,
): TomlTable | undefined {
  const path = rustJoin(global.dirs.config, "characters", characterName, "config.toml");
  if (!exists(path)) return undefined;

  const overlay = parseToml(readFileOrThrow(path), "parse_include", path);
  const merged = structuredClone(global.table);
  deepMerge(merged, overlay);
  return merged;
}

/** The starter `config.toml` the Rust writes when none exists. */
export const DEFAULT_CONFIG_TOML = `# Shore configuration
# See examples/config.toml for all available options.
#
# Characters are discovered from the characters/ directory.
# Create characters/<name>/workspace/SOUL.md to define a character.
#
# Models are referenced as \`provider:model_id\` against a [providers.*] entry.
# You can also use \`include = ["extra.toml"]\` or conf.d/*.toml for modular config.

# include = ["models.toml"]  # optional explicit includes

# [defaults]
# model = "anthropic:claude-sonnet-4-6"   # provider:model_id

# [providers.anthropic]
# api_key_env = "ANTHROPIC_API_KEY"
#
# [providers.anthropic.defaults]
# cache_ttl = "1h"

# [daemon]
# addr = "127.0.0.1:7320"             # env override: SHORE_ADDR
# unsafe_allow_remote_access = false  # required for non-loopback binds
#                                     # env override: SHORE_UNSAFE_ALLOW_REMOTE_ACCESS
# allowed_hosts = []                  # IPs or CIDR ranges, e.g. ["10.0.0.5", "172.18.0.0/16"]
#                                     # allowlist only; not auth/TLS
`;

/**
 * Write {@link DEFAULT_CONFIG_TOML} into a config directory that has none,
 * creating the directory first.
 *
 * This is the effect {@link loadRawConfigTable}'s `createDefault` hook exists
 * for — kept here beside the template it writes, and passed in from the daemon's
 * composition root rather than fired by the loader itself.
 *
 * Neither half is fatal. The Rust `warn!`s and continues on both, because a
 * read-only config directory is a legitimate deployment — a container with the
 * config baked in and `SHORE_ADDR` doing the rest — and a daemon that can talk
 * must not refuse to start over a starter file nobody will edit.
 *
 * Returns the path written, or `undefined` if either half failed, so the caller
 * can say where it went. A first run has no other way to find out.
 */
export function createDefaultConfig(
  configDirectory: string,
  onWarn: ConfigWarn = consoleConfigWarn,
): string | undefined {
  try {
    mkdirSync(configDirectory, { recursive: true });
  } catch (e) {
    onWarn("Could not create config directory", [["error", String(e)]]);
    return undefined;
  }

  const path = rustJoin(configDirectory, "config.toml");
  try {
    writeFileSync(path, DEFAULT_CONFIG_TOML);
  } catch (e) {
    onWarn("Could not write default config.toml", [["error", String(e)]]);
    return undefined;
  }
  return path;
}

// --- warnings ---------------------------------------------------------------

/**
 * Where an advisory config diagnostic goes.
 *
 * The Rust emits these through `tracing`, whose subscriber is ambient and
 * swappable; this is the same seam, made explicit because the sidecar has no
 * ambient log context to swap. It is not decoration — `validateConfig`'s entire
 * job is deciding which bad reference blocks startup and which merely warns,
 * and five of its six advisory paths have no other observable effect. A sink
 * that could not be observed would make those paths untestable.
 *
 * `fields` are the structured key/value pairs in emission order, matching what
 * the `warn!` call site attaches.
 */
export type ConfigWarn = (
  message: string,
  fields: readonly (readonly [string, string])[],
) => void;

/** The default sink: one `console.warn` line, message then fields. */
export const consoleConfigWarn: ConfigWarn = (message, fields) => {
  const suffix = fields.map(([key, value]) => ` ${key}=${value}`).join("");
  console.warn(`shore: ${message}${suffix}`);
};

// --- assembly ---------------------------------------------------------------

/** Fully loaded daemon configuration. */
export interface LoadedConfig {
  app: AppConfig;
  models: ModelCatalog;
  providers: ProviderRegistry;
  dirs: ShoreDirs;
  /**
   * The merged table as it stood *before* model-section extraction, kept for
   * per-character merging. `undefined` for a config assembled programmatically
   * rather than loaded, which is why {@link loadCharacterConfig} falls back to
   * an empty base rather than refusing.
   */
  rawTable: TomlTable | undefined;
}

/** A section value as `toml::Value::as_table()` sees it: a table, or nothing. */
function sectionTable(value: unknown): TomlTable | undefined {
  return isTable(value) ? value : undefined;
}

/**
 * Deserialize a merged TOML table into a validated `LoadedConfig`.
 *
 * The model sections are lifted out before `AppConfig` — which is
 * `deny_unknown_fields` — ever sees the table, which is the only reason
 * `[chat.*]` is not an unknown-field error. Four names are lifted: `chat`,
 * `embedding`, `image_generation` and `providers`.
 *
 * `[tools]` is deliberately NOT among them. It used to be the model catalog's
 * second category and is now the tool-surface section of `AppConfig`, so
 * lifting it would silently discard the entire tool allowlist rather than fail.
 *
 * The lift is unconditional but the *use* is `as_table()`, so `chat = "nope"`
 * is removed and then silently ignored — neither an unknown field nor a catalog
 * error. Pinned, because it is invisible from any valid config.
 *
 * Order is load-bearing and is the Rust's: `AppConfig` first, so a bad section
 * name beats a bad `[providers.*]` entry; then the registry, so a bad provider
 * beats a bad `[chat.*]` model; then the catalog, which inherits the registry's
 * transport defaults; then validation.
 */
export function parseConfigTable(
  table: TomlTable,
  dirs: ShoreDirs,
  onWarn: ConfigWarn = consoleConfigWarn,
): LoadedConfig {
  // Deep-cloned, not aliased: a character overlay is merged into this table,
  // and the Rust's `table.clone()` is what keeps that from reaching back into
  // the global config.
  const rawTable = structuredClone(table);

  const remainder = { ...table };
  const chatSection = sectionTable(remainder.chat);
  const embeddingSection = sectionTable(remainder.embedding);
  const imageGenerationSection = sectionTable(remainder.image_generation);
  const providersSection = sectionTable(remainder.providers);
  delete remainder.chat;
  delete remainder.embedding;
  delete remainder.image_generation;
  delete remainder.providers;

  const parsed = parseAppConfig(remainder);
  if ("err" in parsed) throw new ConfigError("parse_app", parsed.err);
  const app = parsed.ok;

  // Forwards the legacy top-level `defaults.heartbeat` into
  // `defaults.background.heartbeat`. It runs *before* validation, so a warning
  // about that value names the key it was moved to, never the key the user
  // wrote.
  normalizeDeprecatedAliases(app.defaults);

  let providers: ProviderRegistry;
  try {
    providers = ProviderRegistry.fromSection(providersSection);
  } catch (e) {
    if (!(e instanceof ProviderRegistryError)) throw e;
    throw new ConfigError("provider_registry", e.message);
  }

  let models: ModelCatalog;
  try {
    models = catalogFromSections(
      chatSection,
      embeddingSection,
      imageGenerationSection,
      providers,
    );
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    throw new ConfigError("catalog", e.message);
  }

  validateConfig(app, models, providers, onWarn);

  return { app, models, providers, dirs, rawTable };
}

/** Load, merge and validate the daemon configuration. */
export function loadConfig(
  configPath: string | undefined,
  options: {
    env?: Env;
    homeLookup?: HomeLookup;
    createDefault?: (configDir: string) => void;
    onWarn?: ConfigWarn;
  } = {},
): LoadedConfig {
  const raw = loadRawConfigTable(configPath, options);
  return parseConfigTable(raw.table, raw.dirs, options.onWarn);
}

/**
 * Apply a character's `characters/{name}/config.toml` over a loaded global
 * config and re-parse the result from scratch.
 *
 * Returns `undefined` when the character has no override file, which is the
 * common case and is not an error.
 *
 * A `LoadedConfig` with no raw table merges the overlay over an *empty* base
 * rather than over the global's parsed values — the Rust's
 * `unwrap_or_default()`. That only happens for a programmatically assembled
 * config, but it means the character would silently lose every global setting,
 * so it is worth knowing rather than discovering.
 */
export function loadCharacterConfig(
  global: LoadedConfig,
  characterName: string,
  onWarn: ConfigWarn = consoleConfigWarn,
): LoadedConfig | undefined {
  const path = rustJoin(global.dirs.config, "characters", characterName, "config.toml");
  if (!exists(path)) return undefined;

  // A character file that does not parse is fatal, and reports as an include
  // rather than as `config.toml` — it is not the file the daemon was pointed at.
  const overlay = parseToml(readFileOrThrow(path), "parse_include", path);
  const merged = structuredClone(global.rawTable ?? {});
  deepMerge(merged, overlay);
  return parseConfigTable(merged, global.dirs, onWarn);
}

// --- validation -------------------------------------------------------------

function validationError(message: string): ConfigError {
  return new ConfigError("validation", message);
}

/**
 * Cross-field validation, run once the catalog and registry exist.
 *
 * The split between reject and warn is the point of this function, and it is
 * not uniform:
 *
 * - **Chat defaults warn.** An active model can be chosen at runtime through
 *   per-character preferences, and the runtime resolver accepts discovered
 *   `provider:model_id` refs the static catalog never saw. A bad one must not
 *   stop the daemon from starting, because the fix does not require editing
 *   the file.
 * - **Enabled sub-agents reject.** Their model chain has no per-character
 *   override, so an unresolvable one would surface on first `ask_<name>` call
 *   instead. Disabled sub-agents fall back to warning — they are never exposed.
 * - **Embedding and image_generation reject.** An embedding swap invalidates
 *   every vector store, and these globals have no runtime override at all.
 *
 * The order of the checks is observable whenever a config has more than one
 * fault, since the first one throws. It is pinned by a dozen cases in
 * `validate_parity.json` and is not free to change.
 */
export function validateConfig(
  app: AppConfig,
  catalog: ModelCatalog,
  providers: ProviderRegistry,
  onWarn: ConfigWarn = consoleConfigWarn,
): void {
  warnOnUnresolvableModelRef(catalog, providers, "defaults.model", app.defaults.model, onWarn);
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "defaults.background.model",
    app.defaults.background.model,
    onWarn,
  );
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "defaults.background.heartbeat",
    app.defaults.background.heartbeat,
    onWarn,
  );
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "defaults.background.compaction",
    app.defaults.background.compaction,
    onWarn,
  );
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "defaults.subagent_model",
    app.defaults.subagent_model,
    onWarn,
  );

  for (const [name, sub] of app.subagents) {
    // Exact equality, inlined rather than routed through `subagentEnabled`.
    // The two agree today, but they are separate decisions: if the allowlist
    // ever grew globs, the runtime would honour them and this check would
    // not, and borrowing the helper would have quietly coupled them.
    if (app.tools.enabled_subagents.includes(name)) {
      // `??` and not `||`: an empty model string is a *set* model, so it
      // shadows the defaults and is rejected rather than falling through.
      const resolved = sub.model ?? app.defaults.subagent_model ?? app.defaults.model;
      if (resolved === undefined) {
        throw validationError(
          `subagents.${name} is enabled but resolves to no model; set ` +
            `subagents.${name}.model, defaults.subagent_model, or defaults.model`,
        );
      }
      if (!modelRefResolves(catalog, providers, resolved)) {
        throw validationError(
          `subagents.${name} resolves to model "${resolved}", which is not ` +
            "in the static catalog and is not a `provider:model_id` ref to " +
            `an enabled provider; ask_${name} would fail on first use`,
        );
      }
    } else {
      warnOnUnresolvableModelRef(
        catalog,
        providers,
        `subagents.${name}.model`,
        sub.model,
        onWarn,
      );
    }
  }

  validateMcpServers(app, onWarn);
  validateDefaultEmbedding(providers, app.defaults.embedding, onWarn);
  validateDefaultImageGeneration(providers, app.defaults.image_generation, onWarn);
  validateUsageConfig(app.usage);

  const compaction = validateCompaction(app.memory.compaction);
  if (compaction !== undefined) throw validationError(compaction);
}

/**
 * Each `[mcp.*]` server must set exactly one transport, `command` xor `url`.
 *
 * The test is presence, not non-emptiness: `command = ""` is a transport and
 * loads. That distinction does not survive a truthiness check, which is the
 * whole reason it is spelled out.
 *
 * The advisory sweep afterwards catches an `mcp__<server>__*` grant naming a
 * server with no definition, which would silently grant nothing.
 */
function validateMcpServers(app: AppConfig, onWarn: ConfigWarn): void {
  for (const [name, server] of app.mcp) {
    const hasCommand = server.command !== undefined;
    const hasUrl = server.url !== undefined;
    if (hasCommand && hasUrl) {
      throw validationError(
        `mcp.${name} sets both \`command\` and \`url\`; set exactly one transport`,
      );
    }
    if (!hasCommand && !hasUrl) {
      throw validationError(
        `mcp.${name} sets neither \`command\` nor \`url\`; set exactly one transport`,
      );
    }
  }

  // The global allowlist first, then each sub-agent's own grants in map order.
  const referenced = [
    ...app.tools.enabled_tools,
    ...[...app.subagents.values()].flatMap((s) => s.tools),
  ];
  for (const pattern of referenced) {
    if (!pattern.startsWith("mcp__")) continue;
    // `mcp__hue` has no tool segment, so the whole remainder is the server;
    // a bare `mcp__` leaves an empty one and is skipped.
    const server = pattern.slice("mcp__".length).split("__")[0] ?? "";
    if (server !== "" && server !== "*" && !app.mcp.has(server)) {
      onWarn(
        `tool grant references MCP server with no [mcp.${server}] definition; ` +
          "it will match no tools",
        [
          ["pattern", pattern],
          ["server", server],
        ],
      );
    }
  }
}

/**
 * Validate `[usage]`.
 *
 * Every numeric guard here is a float comparison written as "reject the bad
 * range", so NaN — which compares false against everything — passes all of
 * them. `multiplier = nan` loads. That is the Rust's behaviour and the port
 * reproduces it rather than tightening it, because tightening it here would
 * make the sidecar reject a config the daemon accepts.
 */
function validateUsageConfig(config: UsageConfig): void {
  if (config.timezone !== "local" && config.timezone !== "utc") {
    throw validationError(
      `usage.timezone must be "local" or "utc", got "${config.timezone}"`,
    );
  }

  if (config.spike_warnings.multiplier <= 1.0) {
    throw validationError("usage.spike_warnings.multiplier must be greater than 1.0");
  }
  if (config.spike_warnings.min_cost_usd < 0.0) {
    throw validationError("usage.spike_warnings.min_cost_usd must be non-negative");
  }

  const names = new Set<string>();
  for (const [idx, budget] of config.budgets.entries()) {
    if (budget.cost_usd <= 0.0) {
      throw validationError(`usage.budgets[${idx}].cost_usd must be greater than 0`);
    }
    for (const threshold of budget.warn_at) {
      if (threshold <= 0.0) {
        throw validationError(
          `usage.budgets[${idx}].warn_at values must be greater than 0`,
        );
      }
    }
    validateBudgetAnchors(idx, budget);
    validateBudgetPace(idx, budget);

    // A blank name becomes its 1-based index, so two blanks never collide with
    // each other — but a literal "budget 1" collides with a blank at index 0.
    const trimmed = rustTrim(budget.name);
    const name = trimmed === "" ? `budget ${idx + 1}` : trimmed;
    if (names.has(name)) {
      throw validationError(`usage budget name "${name}" is duplicated`);
    }
    names.add(name);
  }
}

/** Anchors must be in range *and* belong to the period they anchor. */
function validateBudgetAnchors(idx: number, budget: UsageBudgetConfig): void {
  if (budget.reset_hour !== undefined) {
    // Range first: an out-of-range hour on an hourly budget reports the range.
    if (budget.reset_hour > 23) {
      throw validationError(
        `usage.budgets[${idx}].reset_hour must be 0-23, got ${budget.reset_hour}`,
      );
    }
    if (budget.period === "hour") {
      throw validationError(
        `usage.budgets[${idx}].reset_hour is not valid for period = "hour"`,
      );
    }
  }

  if (budget.reset_day_of_week !== undefined && budget.period !== "week") {
    throw validationError(
      `usage.budgets[${idx}].reset_day_of_week is only valid for period = "week"`,
    );
  }

  if (budget.reset_day_of_month !== undefined) {
    const day = budget.reset_day_of_month;
    if (day < 1 || day > 31) {
      throw validationError(
        `usage.budgets[${idx}].reset_day_of_month must be 1-31, got ${day}`,
      );
    }
    if (budget.period !== "month") {
      throw validationError(
        `usage.budgets[${idx}].reset_day_of_month is only valid for period = "month"`,
      );
    }
  }
}

/**
 * A pace sub-window must be strictly shorter than the period it subdivides:
 * an equal pace makes the allowance the budget itself, and a longer one has no
 * defined division.
 *
 * `pace_action` / `pace_warn_at` / `pace_warn_action` with no `pace_period` are
 * rejected rather than ignored, so a typo fails at load instead of silently
 * doing nothing.
 */
function validateBudgetPace(idx: number, budget: UsageBudgetConfig): void {
  const pace = budget.pace_period;
  if (pace === undefined) {
    if (budget.pace_action !== undefined) {
      throw validationError(`usage.budgets[${idx}].pace_action requires pace_period`);
    }
    if (budget.pace_warn_at !== undefined) {
      throw validationError(`usage.budgets[${idx}].pace_warn_at requires pace_period`);
    }
    if (budget.pace_warn_action !== undefined) {
      throw validationError(`usage.budgets[${idx}].pace_warn_action requires pace_period`);
    }
    return;
  }

  if (budgetPeriodRank(pace) >= budgetPeriodRank(budget.period)) {
    throw validationError(
      `usage.budgets[${idx}].pace_period = "${pace}" must be shorter than ` +
        `period = "${budget.period}"`,
    );
  }

  for (const threshold of budget.pace_warn_at ?? []) {
    if (threshold <= 0.0) {
      throw validationError(
        `usage.budgets[${idx}].pace_warn_at values must be greater than 0`,
      );
    }
  }
}

/**
 * Check the `provider_key` half of an aux (`embedding` / `image_generation`)
 * ref against the registry.
 *
 * A **disabled** provider is a hard error: it yields zero key candidates, so
 * the aux resolver can never succeed, and failing here keeps config load in
 * lockstep with runtime instead of passing validation and dying at resolve
 * time. An **absent** provider only warns — well-known keys resolve through
 * built-in transport defaults, and the credential check happens at runtime.
 */
function validateAuxProvider(
  providers: ProviderRegistry,
  field: string,
  providerKey: string,
  onWarn: ConfigWarn,
): void {
  const entry = providers.get(providerKey);
  if (entry === undefined) {
    onWarn(
      `${field} references provider "${providerKey}" not configured under ` +
        `[providers.${providerKey}]; built-in transport defaults are used for ` +
        "well-known providers, otherwise set base_url/api_key_env there",
      [
        ["field", field],
        ["provider", providerKey],
      ],
    );
    return;
  }
  if (!entry.enabled) {
    throw validationError(
      `${field} references provider "${providerKey}" which is disabled in ` +
        `[providers.${providerKey}] (enabled = false); a disabled provider yields no ` +
        `credentials, so ${field} cannot resolve. Enable the provider or change ${field}.`,
    );
  }
}

/**
 * `defaults.embedding` must be a `provider:model_id` identity.
 *
 * Shore ships only a hosted OpenAI-compatible embedder — there is no runtime
 * local one — so a bundled id is rejected here rather than validating and then
 * degrading to lexical search at runtime.
 */
function validateDefaultEmbedding(
  providers: ProviderRegistry,
  name: string | undefined,
  onWarn: ConfigWarn,
): void {
  if (name === undefined) return;
  const split = splitOnce(name, ":");
  if (split === undefined) {
    throw validationError(
      `defaults.embedding "${name}" must be a \`provider:model_id\` identity ` +
        "(transport lives on [providers.<provider>]); Shore ships only a hosted " +
        "OpenAI-compatible embedder, so bundled local ids are not served",
    );
  }
  const [providerKey, modelId] = split;
  if (providerKey === "" || modelId === "") {
    throw validationError(
      `defaults.embedding "${name}" is not a valid \`provider:model_id\` identity`,
    );
  }
  validateAuxProvider(providers, "defaults.embedding", providerKey, onWarn);
}

/** `defaults.image_generation`, same shape, no bundled fallback to explain. */
function validateDefaultImageGeneration(
  providers: ProviderRegistry,
  name: string | undefined,
  onWarn: ConfigWarn,
): void {
  if (name === undefined) return;
  const split = splitOnce(name, ":");
  if (split === undefined) {
    throw validationError(
      `defaults.image_generation "${name}" must be a \`provider:model_id\` identity ` +
        "(transport lives on [providers.<provider>])",
    );
  }
  const [providerKey, modelId] = split;
  if (providerKey === "" || modelId === "") {
    throw validationError(
      `defaults.image_generation "${name}" is not a valid \`provider:model_id\` identity`,
    );
  }
  validateAuxProvider(providers, "defaults.image_generation", providerKey, onWarn);
}

/** Rust's `str::split_once`: split at the FIRST separator, or not at all. */
function splitOnce(s: string, sep: string): [string, string] | undefined {
  const at = s.indexOf(sep);
  if (at < 0) return undefined;
  return [s.slice(0, at), s.slice(at + sep.length)];
}

/** Whether the catalog knows `name`. A miss is expected here, not exceptional. */
function catalogHas(catalog: ModelCatalog, name: string): boolean {
  try {
    findModel(catalog, name);
    return true;
  } catch (e) {
    if (e instanceof CatalogError) return false;
    throw e;
  }
}

/**
 * Whether a model reference resolves against the static catalog or an enabled
 * provider's trusted path — the non-warning cases of
 * {@link warnOnUnresolvableModelRef}.
 *
 * An enabled provider resolves a fully-qualified `provider:model_id` ref even
 * with discovery **off**: the trusted path does not go through the discovery
 * cache (#136). Checking `discovery.enabled` here would reject working configs.
 */
function modelRefResolves(
  catalog: ModelCatalog,
  providers: ProviderRegistry,
  name: string,
): boolean {
  if (catalogHas(catalog, name)) return true;
  const split = splitOnce(name, ":");
  if (split === undefined) return false;
  const [providerKey, modelId] = split;
  if (providerKey === "" || modelId === "") return false;
  return providers.get(providerKey)?.enabled ?? false;
}

/**
 * Warn when an optional default-model reference cannot be reconciled with the
 * catalog or the registry. Never throws — every caller is advisory.
 *
 * A name with an empty half is not `provider:model_id` form at all, so it falls
 * through to the generic message rather than reporting an empty provider. The
 * aux validators above make the opposite choice on the same input, which is
 * why they do not share this code.
 */
function warnOnUnresolvableModelRef(
  catalog: ModelCatalog,
  providers: ProviderRegistry,
  field: string,
  name: string | undefined,
  onWarn: ConfigWarn,
): void {
  if (name === undefined) return;
  if (catalogHas(catalog, name)) return;

  const split = splitOnce(name, ":");
  if (split !== undefined) {
    const [providerKey, modelId] = split;
    if (providerKey !== "" && modelId !== "") {
      const entry = providers.get(providerKey);
      if (entry?.enabled === true) return;
      if (entry !== undefined) {
        onWarn(
          "configured default model references a disabled provider; " +
            "a disabled provider is unreferenceable, but per-character " +
            "preferences can override at runtime",
          [
            ["field", field],
            ["name", name],
            ["provider", providerKey],
          ],
        );
        return;
      }
      onWarn(
        `configured default model references provider "${providerKey}" which ` +
          `is not configured under [providers.${providerKey}]`,
        [
          ["field", field],
          ["name", name],
          ["provider", providerKey],
        ],
      );
      return;
    }
  }

  onWarn(
    `configured default model "${name}" was not found in the static ` +
      "catalog and is not in provider:model_id form; the daemon will " +
      "attempt runtime resolution and per-character preferences can " +
      "override this without editing config",
    [
      ["field", field],
      ["name", name],
    ],
  );
}
