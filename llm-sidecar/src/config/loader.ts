/**
 * Shore's config *file* semantics: `config.toml`, `include = [...]`, `conf.d/`,
 * the config-local `.env`, and the deep merge that composes them.
 *
 * Ports the loader half of `crates/common/src/config/mod.rs` up to — but not
 * including — `parse_config_table`, which needs `AppConfig` and lands with it.
 * The split is not arbitrary: everything here operates on raw TOML tables, and
 * the per-character override that `CharacterRegistry` performs is a table-level
 * merge, so this layer is exactly the part that can move before `app.rs` does.
 *
 * `deepMerge` is the whole reason the raw table is retained on a loaded config
 * at all. A character override is applied to the *unparsed* global table and
 * the result re-parsed from scratch, rather than merged field-by-field over a
 * parsed struct — so a character can set `[tools] enabled_tools` without
 * inheriting the global list, and a table it does not mention keeps every
 * global key.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";

import { compareByCodePoint } from "../sort.ts";
import {
  rustJoin,
  resolveShoreDirs,
  type Env,
  type HomeLookup,
  type ShoreDirs,
} from "./dirs.ts";

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
 */
export function loadRawConfigTable(
  configPath: string | undefined,
  options: {
    env?: Env;
    homeLookup?: HomeLookup;
    createDefault?: (configDir: string) => void;
  } = {},
): RawConfigTable {
  const dirs = resolveShoreDirs(options.env, options.homeLookup);

  // A custom config path re-homes the whole config directory, so character
  // lookups resolve beside the file the daemon was pointed at.
  const configDirectory = configPath === undefined ? dirs.config : parentOf(configPath);
  if (configPath !== undefined) dirs.config = configDirectory;

  const configFile = configPath ?? rustJoin(configDirectory, "config.toml");

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
# allowed_hosts = []                  # IP allowlist only; not auth/TLS
`;
