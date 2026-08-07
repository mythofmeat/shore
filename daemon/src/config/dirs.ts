/**
 * Shore's directory layout: where config, data, runtime and cache live, and
 * every path derived from them.
 *
 * Ports the directory and path half of `crates/common/src/config/mod.rs`.
 * These were the dozen symbols #12 measured as the *only* part of the 10,286-line
 * config module the Rust clients touch, so they are also the part that has to
 * agree byte-for-byte across the two languages for as long as both exist.
 *
 * Three of the helpers here already existed privately in
 * `memory/deferred_edits.ts`, which grew its own copies when it landed ahead of
 * this module. They now come from here, so there is one layout and not two.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { compareByCodePoint } from "../sort.ts";

// --- names on disk ---------------------------------------------------------

export const CHARACTER_WORKSPACE_DIR = "workspace";
export const SOUL_FILE = "SOUL.md";
export const USER_FILE = "USER.md";
export const AGENTS_FILE = "AGENTS.md";
export const TOOLS_FILE = "TOOLS.md";
export const MEMORY_DIR = "memory";

/** Per-character conversation log under `<data>/<character>/`. */
export const ACTIVE_JSONL_FILE = "active.jsonl";
/** Per-character archived-history directory, written by compaction. */
export const SEGMENTS_DIR = "segments";
/** Per-character compaction manifest: segment order, counts, timestamps. */
export const COMPACTION_MANIFEST_FILE = "compaction.json";
/** Root under `<data>/` for locally installed MCP servers. */
export const PLUGINS_DIR = "plugins";

/** The legacy pre-`workspace/` character definition filename. */
const LEGACY_CHARACTER_FILE = "character.md";
/** The legacy pre-`workspace/` user definition filename. */
const LEGACY_USER_FILE = "user.md";

// --- XDG resolution --------------------------------------------------------

/** Resolved Shore directories. */
export interface ShoreDirs {
  /** `$XDG_CONFIG_HOME/shore/` */
  config: string;
  /** `$XDG_DATA_HOME/shore/` */
  data: string;
  /** `$XDG_RUNTIME_DIR/shore/` */
  runtime: string;
  /** `$XDG_CACHE_HOME/shore/` */
  cache: string;
}

/** The environment a resolution reads. Injectable so the replay can drive it. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The `dirs` crate's platform lookups, for the four directories Shore asks for.
 *
 * Only the Linux/XDG behaviour is reproduced, which is the only behaviour the
 * Rust has ever run under here. Each returns `undefined` where the crate
 * returns `None`.
 *
 * `runtimeDir` is the odd one: the crate has no fallback for it at all, so an
 * unset `XDG_RUNTIME_DIR` yields `None` and the caller drops to its own
 * fallback — which for runtime is the empty string, meaning the temp dir.
 */
const PLATFORM: Record<keyof ShoreDirs, (env: Env, home: HomeLookup) => string | undefined> = {
  config: (env, home) => xdgOrHome(env, home, ".config"),
  data: (env, home) => xdgOrHome(env, home, ".local/share"),
  // No fallback at all, matching the crate: an absent XDG_RUNTIME_DIR yields
  // nothing and the caller drops to the temp directory. Restoring the crate's
  // `XDG_RUNTIME_DIR` read here is an unkillable mutant, for the same reason
  // the relative-XDG guard was dropped from `xdgOrHome` — this runs only when
  // that variable is already known to be absent.
  runtime: () => undefined,
  cache: (env, home) => xdgOrHome(env, home, ".cache"),
};

/** How the home directory is found when `HOME` is absent. */
export type HomeLookup = () => string | undefined;

/**
 * The passwd-database home, which is what the `dirs` crate falls back to.
 *
 * `os.homedir()` is the wrong primitive here: it consults `HOME` first, and
 * this is specifically the branch taken when `HOME` is unset.
 * `os.userInfo().homedir` reads the passwd entry directly, as `dirs` does.
 */
const passwdHome: HomeLookup = () => {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
};

/**
 * `<home>/<rel>`, where `<home>` is `$HOME` when set and non-empty and the
 * **passwd entry** otherwise — not nothing. The `home` crate treats an empty
 * `HOME` as unset, so this does too.
 *
 * That fallback is why the `"~/.config"` literal in `resolveXdgDir` is very
 * nearly dead code: clearing `HOME` does not reach it, because `getpwuid`
 * still answers. The fixture pins it — with the whole environment cleared, the
 * daemon resolves to the passwd home's `.config`, not to a directory named `~`.
 *
 * **The crate's own relative-XDG guard is not reproduced, because it cannot
 * run.** `dirs::config_dir()` re-reads `XDG_CONFIG_HOME` and ignores it unless
 * absolute — but `resolveXdgDir` only consults the platform lookup when that
 * same variable is *absent*, so the guard would always be handed `None`. The
 * Rust carries the check; here it was a branch no input could take, and
 * mutation testing found it by leaving two mutants unkillable. Dropped, with
 * the consequence recorded: a relative `XDG_CONFIG_HOME` is used as-is by both
 * halves, which is the `cfg/shore` fixture case.
 */
function xdgOrHome(env: Env, home: HomeLookup, rel: string): string | undefined {
  const base = env.HOME !== undefined && env.HOME !== "" ? env.HOME : home();
  if (base === undefined || base === "") return undefined;
  return rustJoin(base, rel);
}

/**
 * Resolve one directory.
 *
 * Precedence: `overrideVar` -> `xdgVar` + `/shore` -> platform + `/shore` ->
 * `fallback` + `/shore`, with an empty `fallback` meaning the temp directory.
 *
 * Two properties here look like mistakes and are the Rust's, faithfully:
 *
 * - **The `xdgVar` read is unguarded.** `std::env::var` yields `Ok("")` for a
 *   variable that is set but empty, and `Ok` short-circuits the `or_else` that
 *   would have consulted the platform lookup. So `XDG_CONFIG_HOME=""` resolves
 *   to the *relative* path `shore`, and a relative `XDG_CONFIG_HOME=cfg`
 *   resolves to `cfg/shore` — both of which the platform lookup would have
 *   rejected in favour of `$HOME/.config`.
 * - **`fallback` is a literal, and `~` is not a path.** `PathBuf::from("~/.config")`
 *   does not expand, so reaching it would yield a *relative* directory named
 *   `~`. It is very nearly unreachable: clearing `HOME` does not get there,
 *   because the `dirs` crate falls through to the passwd entry — the fixture
 *   case with the whole environment cleared resolves to the passwd home's
 *   `.config`, not to `~/.config`. Only a user with no passwd entry at all
 *   reaches the literal, so this is kept faithful rather than fixed, and the
 *   fixture pins the passwd path that actually runs.
 *
 * `runtime` is the one directory whose fallback *is* routinely taken: the crate
 * offers no platform default for `XDG_RUNTIME_DIR`, so an unset variable lands
 * in the temp directory. Every fixture case without `XDG_RUNTIME_DIR` shows it.
 */
function resolveXdgDir(
  env: Env,
  home: HomeLookup,
  overrideVar: string,
  xdgVar: string,
  platform: (env: Env, home: HomeLookup) => string | undefined,
  fallback: string,
): string {
  const override = env[overrideVar];
  if (override !== undefined) return override;

  const xdg = env[xdgVar];
  const base = xdg ?? platform(env, home) ?? (fallback === "" ? tmpdir() : fallback);
  return rustJoin(base, "shore");
}

/**
 * Resolve all four Shore directories.
 *
 * Priority, highest first:
 * 1. `SHORE_{CONFIG,DATA,RUNTIME,CACHE}_DIR` — used as-is, no `/shore` suffix
 * 2. `XDG_{CONFIG_HOME,DATA_HOME,RUNTIME_DIR,CACHE_HOME}` + `/shore`
 * 3. Platform defaults + `/shore`
 */
export function resolveShoreDirs(env: Env = process.env, home: HomeLookup = passwdHome): ShoreDirs {
  const one = (
    overrideVar: string,
    xdgVar: string,
    platform: (env: Env, home: HomeLookup) => string | undefined,
    fallback: string,
  ) => resolveXdgDir(env, home, overrideVar, xdgVar, platform, fallback);

  return {
    config: one("SHORE_CONFIG_DIR", "XDG_CONFIG_HOME", PLATFORM.config, "~/.config"),
    data: one("SHORE_DATA_DIR", "XDG_DATA_HOME", PLATFORM.data, "~/.local/share"),
    runtime: one("SHORE_RUNTIME_DIR", "XDG_RUNTIME_DIR", PLATFORM.runtime, ""),
    cache: one("SHORE_CACHE_DIR", "XDG_CACHE_HOME", PLATFORM.cache, "~/.cache"),
  };
}

/** `ShoreDirs::resolve().config`, for callers that want only the one. */
export const configDir = (env?: Env): string => resolveShoreDirs(env).config;
/** `ShoreDirs::resolve().data`. */
export const dataDir = (env?: Env): string => resolveShoreDirs(env).data;
/** `ShoreDirs::resolve().runtime`. */
export const runtimeDir = (env?: Env): string => resolveShoreDirs(env).runtime;

// --- derived paths ---------------------------------------------------------

/**
 * Join path segments the way `PathBuf::push` does, which is not the way
 * `node:path`'s `join` does. Two differences, both reachable here:
 *
 * - **An absolute component replaces the whole path.** `Path::new("/data").join("/etc")`
 *   is `/etc`; `join("/data", "/etc")` is `/data/etc`. This matters because
 *   character names reach these helpers and a name is not always a directory
 *   entry — `resolve_character` accepts one off the wire. The Rust's rule is
 *   the more dangerous of the two and is reproduced rather than improved: a
 *   port that quietly confined a name the daemon does not confine would put
 *   the two halves in different places for the same input, which is worse than
 *   either rule alone. Confinement belongs where the name is admitted.
 * - **Nothing is normalized.** `PathBuf` keeps `a//b` and `a/../b` as written,
 *   where `join` collapses both. An `XDG_CONFIG_HOME` of `a/..` therefore
 *   resolves to `a/../shore` in the daemon and would resolve to `shore` under
 *   `join` — a different directory, silently.
 */
export function rustJoin(base: string, ...parts: string[]): string {
  let out = base;
  for (const part of parts) {
    if (part.startsWith("/")) {
      out = part;
    } else if (out === "" || out.endsWith("/")) {
      out += part;
    } else {
      out += `/${part}`;
    }
  }
  return out;
}

/** `<data_dir>/plugins/` — the root for relative `[mcp.*]` paths. */
export const pluginsDir = (data: string): string => rustJoin(data, PLUGINS_DIR);

/** `characters/{name}/` */
export const characterConfigDir = (config: string, name: string): string =>
  rustJoin(config, "characters", name);

/** `characters/{name}/workspace/` */
export const characterWorkspaceDir = (config: string, name: string): string =>
  rustJoin(characterConfigDir(config, name), CHARACTER_WORKSPACE_DIR);

/** `characters/{name}/workspace/{file}` */
export const characterWorkspaceFile = (config: string, name: string, file: string): string =>
  rustJoin(characterWorkspaceDir(config, name), file);

/** `characters/{name}/workspace/memory/` */
export const characterMemoryDir = (config: string, name: string): string =>
  rustJoin(characterWorkspaceDir(config, name), MEMORY_DIR);

/** `<data_dir>/{character}/` — the per-character runtime storage root. */
export const characterDataDir = (data: string, name: string): string => rustJoin(data, name);

/** `<data_dir>/{character}/active.jsonl` */
export const characterActiveJsonl = (data: string, name: string): string =>
  rustJoin(characterDataDir(data, name), ACTIVE_JSONL_FILE);

/** `<data_dir>/{character}/segments/` */
export const characterSegmentsDir = (data: string, name: string): string =>
  rustJoin(characterDataDir(data, name), SEGMENTS_DIR);

/** `<data_dir>/{character}/compaction.json` */
export const characterCompactionManifest = (data: string, name: string): string =>
  rustJoin(characterDataDir(data, name), COMPACTION_MANIFEST_FILE);

// --- discovery -------------------------------------------------------------

function isDir(path: string): boolean {
  try {
    // `Path::is_dir` follows symlinks and reports false on any error.
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `Path::is_file`: follows symlinks, false on any error — including a directory. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `Path::exists`: whether anything is there at all, false on any error. */
export function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** File content, or `undefined` for any read error. Mirrors `read_to_string(..).ok()`. */
export function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Character names discovered under `{config_dir}/characters/`.
 *
 * A subdirectory counts if it holds `workspace/SOUL.md` or the legacy
 * `character.md`. An unreadable `characters/` directory yields none, matching
 * the Rust's `let Ok(entries) = read_dir(..) else { return vec![] }` — note
 * that a permissions error is therefore indistinguishable from an absent
 * directory, and neither is an error.
 *
 * The result is sorted by code point, because the Rust sorts `Vec<String>` and
 * `String: Ord` compares bytes. `readdir` order is not sorted on either side,
 * so the sort is what makes this deterministic.
 */
export function discoverCharacters(config: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(rustJoin(config, "characters"));
  } catch {
    return [];
  }

  const charsDir = rustJoin(config, "characters");
  const names: string[] = [];
  for (const name of entries) {
    const dir = join(charsDir, name);
    // Redundant, and knowingly kept: a marker file can only exist *under* a
    // directory, so the two `pathExists` calls below already imply this. Deleting
    // it is an unkillable mutant. It stays because it is the Rust's own guard and
    // because it says what a character is — a directory — at the point that is
    // decided, rather than leaving it implied by two path probes.
    if (!isDir(dir)) continue;
    if (pathExists(join(dir, CHARACTER_WORKSPACE_DIR, SOUL_FILE)) ||
      pathExists(join(dir, LEGACY_CHARACTER_FILE))) {
      names.push(name);
    }
  }
  return names.sort(compareByCodePoint);
}

/**
 * A character's definition: `workspace/SOUL.md`, else the legacy
 * `characters/{name}/character.md`, else nothing.
 *
 * Unlike most readers in this codebase the content is *not* blank-filtered: an
 * empty `SOUL.md` is a definition of the empty string and stops the legacy
 * fallback, because the Rust branches on `read_to_string(..)` being `Ok`.
 */
export function loadCharacterDefinition(config: string, name: string): string | undefined {
  return (
    readOrUndefined(characterWorkspaceFile(config, name, SOUL_FILE)) ??
    readOrUndefined(rustJoin(characterConfigDir(config, name), LEGACY_CHARACTER_FILE))
  );
}

/**
 * A character's user definition: `workspace/USER.md`, else the legacy
 * `characters/{name}/user.md`, else nothing.
 */
export function resolveUserDefinition(config: string, name: string): string | undefined {
  return (
    readOrUndefined(characterWorkspaceFile(config, name, USER_FILE)) ??
    readOrUndefined(rustJoin(characterConfigDir(config, name), LEGACY_USER_FILE))
  );
}

/**
 * A prompt template override: character-specific, else global, else nothing.
 *
 * `undefined` means the caller supplies the built-in default; it is not an
 * error. Both lookups are plain reads, so an unreadable override falls through
 * to the next level rather than failing.
 */
export function resolvePromptTemplate(
  config: string,
  characterName: string,
  templateName: string,
): string | undefined {
  return (
    readOrUndefined(
      rustJoin(characterConfigDir(config, characterName), "prompts", templateName),
    ) ?? readOrUndefined(rustJoin(config, "prompts", templateName))
  );
}
