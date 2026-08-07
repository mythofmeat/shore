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
  /**
   * `SHORE_WORKSPACE_DIR`, when set: the root every character's workspace
   * lives under, as `<root>/<character>/`. Undefined means the default
   * layout, where a workspace sits inside the character's config directory.
   *
   * Unlike the other four this has no XDG equivalent and gets no `/shore`
   * suffix, and an empty value counts as unset — see {@link workspaceRoot}.
   */
  workspace?: string | undefined;
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
const PLATFORM: Record<
  // The four XDG directories, which is not every field of `ShoreDirs`:
  // `workspace` has no XDG variable and no platform default to look up.
  "config" | "data" | "runtime" | "cache",
  (env: Env, home: HomeLookup) => string | undefined
> = {
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
 * That fallback is why {@link resolveXdgDir}'s last resort is very nearly
 * unreachable: clearing `HOME` does not get there, because `getpwuid` still
 * answers. The fixture pins it — with the whole environment cleared, the daemon
 * resolves to the passwd home's `.config`.
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

/** What {@link resolveXdgDir} does when nothing above has answered. */
type LastResort =
  /**
   * `os.tmpdir()`. Correct for `runtime`, and only for `runtime`: the `dirs`
   * crate offers no platform default for `XDG_RUNTIME_DIR`, so this arm is
   * taken routinely, and a directory that means "ephemeral" is the one place
   * ephemeral storage is the right answer. Every fixture case without
   * `XDG_RUNTIME_DIR` shows it.
   */
  | "temp_dir"
  /**
   * Nothing is correct, so refuse — see {@link resolveXdgDir}.
   */
  | "refuse";

/** Raised when no source can name a home directory. */
export class NoHomeDirectoryError extends Error {
  override readonly name = "NoHomeDirectoryError";
}

/**
 * Resolve one directory.
 *
 * Precedence: `overrideVar` -> `xdgVar` + `/shore` -> platform + `/shore` ->
 * `lastResort`.
 *
 * The `xdgVar` read looks like a mistake and is the Rust's, faithfully:
 * `std::env::var` yields `Ok("")` for a variable that is set but empty, and
 * `Ok` short-circuits the `or_else` that would have consulted the platform
 * lookup. So `XDG_CONFIG_HOME=""` resolves to the *relative* path `shore`, and
 * a relative `XDG_CONFIG_HOME=cfg` resolves to `cfg/shore` — both of which the
 * platform lookup would have rejected in favour of `$HOME/.config`.
 *
 * # The last resort used to be a tilde, and that was the bug (#45)
 *
 * `config`, `data` and `cache` each carried a shell-notation string literal —
 * `"~/.config"` and friends. Nothing expands a tilde, on either side of the
 * port, so reaching one produced a *relative* path whose first component was a
 * directory literally named `~`, created wherever the process happened to
 * start. They read as though they did something and never had.
 *
 * It is very nearly unreachable, which is why it never bit: clearing `HOME`
 * does not get there, because the passwd entry still answers. It needs no
 * `HOME` **and** no passwd entry for the uid — a container run as
 * `--user 1001:1001` against an image whose passwd only knows uid 1000. The
 * supported configuration sets `SHORE_CONFIG_DIR` and never arrives here.
 *
 * Refusing is the honest answer. A process that can find no home has nowhere
 * right to write, and failing at startup beats writing to `./~/.config/shore`
 * and looking fine.
 */
function resolveXdgDir(
  env: Env,
  home: HomeLookup,
  overrideVar: string,
  xdgVar: string,
  platform: (env: Env, home: HomeLookup) => string | undefined,
  lastResort: LastResort,
): string {
  const override = env[overrideVar];
  if (override !== undefined) return override;

  const xdg = env[xdgVar];
  let base = xdg ?? platform(env, home);
  if (base === undefined) {
    if (lastResort === "temp_dir") {
      base = tmpdir();
    } else {
      throw new NoHomeDirectoryError(
        `shore cannot determine a home directory: $${xdgVar} is unset and this user has no ` +
          `home (no $HOME and no passwd entry for the uid). Set $${overrideVar} to an explicit ` +
          `path, or $${xdgVar}, or run as a user the passwd database knows.`,
      );
    }
  }
  return rustJoin(base, "shore");
}

/**
 * Resolve all four Shore directories.
 *
 * Priority, highest first:
 * 1. `SHORE_{CONFIG,DATA,RUNTIME,CACHE}_DIR` — used as-is, no `/shore` suffix
 * 2. `XDG_{CONFIG_HOME,DATA_HOME,RUNTIME_DIR,CACHE_HOME}` + `/shore`
 * 3. Platform defaults + `/shore`
 *
 * `workspace` is the odd one out and has no default: it is `SHORE_WORKSPACE_DIR`
 * or nothing, and nothing means workspaces stay inside the config directory.
 */
export function resolveShoreDirs(env: Env = process.env, home: HomeLookup = passwdHome): ShoreDirs {
  const one = (
    overrideVar: string,
    xdgVar: string,
    platform: (env: Env, home: HomeLookup) => string | undefined,
    lastResort: LastResort,
  ) => resolveXdgDir(env, home, overrideVar, xdgVar, platform, lastResort);

  return {
    config: one("SHORE_CONFIG_DIR", "XDG_CONFIG_HOME", PLATFORM.config, "refuse"),
    data: one("SHORE_DATA_DIR", "XDG_DATA_HOME", PLATFORM.data, "refuse"),
    runtime: one("SHORE_RUNTIME_DIR", "XDG_RUNTIME_DIR", PLATFORM.runtime, "temp_dir"),
    cache: one("SHORE_CACHE_DIR", "XDG_CACHE_HOME", PLATFORM.cache, "refuse"),
    workspace: workspaceRoot(env),
  };
}

/**
 * `SHORE_WORKSPACE_DIR`, or undefined for the default layout.
 *
 * Used as-is, like the other `SHORE_*_DIR` overrides: no `/shore` suffix and
 * no XDG variable behind it. **An empty value is unset here**, which is the one
 * place this deliberately differs from the other four. Those have no default
 * but the one they compute, so `SHORE_CONFIG_DIR=""` meaning "the current
 * directory" is at least a coherent answer; this has a perfectly good default,
 * and an empty root would silently scatter every character's workspace into
 * whatever directory the daemon happened to start in.
 */
export function workspaceRoot(env: Env = process.env): string | undefined {
  const root = env.SHORE_WORKSPACE_DIR;
  return root === undefined || root === "" ? undefined : root;
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

/**
 * `characters/{name}/workspace/`, or `{workspaceRoot}/{name}/` when a
 * workspace root is given.
 *
 * The root is passed rather than read, because every other path helper here is
 * a pure function of its base and the parity fixture drives them that way. A
 * caller that has `ShoreDirs` passes `dirs.workspace`; one that has neither
 * passes nothing and gets the default layout.
 */
export const characterWorkspaceDir = (
  config: string,
  name: string,
  workspaceRoot?: string | undefined,
): string =>
  workspaceRoot === undefined
    ? rustJoin(characterConfigDir(config, name), CHARACTER_WORKSPACE_DIR)
    : rustJoin(workspaceRoot, name);

/** `characters/{name}/workspace/{file}`, or `{workspaceRoot}/{name}/{file}`. */
export const characterWorkspaceFile = (
  config: string,
  name: string,
  file: string,
  workspaceRoot?: string | undefined,
): string => rustJoin(characterWorkspaceDir(config, name, workspaceRoot), file);

/** `characters/{name}/workspace/memory/`, or `{workspaceRoot}/{name}/memory/`. */
export const characterMemoryDir = (
  config: string,
  name: string,
  workspaceRoot?: string | undefined,
): string => rustJoin(characterWorkspaceDir(config, name, workspaceRoot), MEMORY_DIR);

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
export function discoverCharacters(config: string, workspaceRoot?: string | undefined): string[] {
  const names = new Set<string>();

  const charsDir = rustJoin(config, "characters");
  for (const name of readdirOrEmpty(charsDir)) {
    const dir = join(charsDir, name);
    // Redundant, and knowingly kept: a marker file can only exist *under* a
    // directory, so the two `pathExists` calls below already imply this. Deleting
    // it is an unkillable mutant. It stays because it is the Rust's own guard and
    // because it says what a character is — a directory — at the point that is
    // decided, rather than leaving it implied by two path probes.
    if (!isDir(dir)) continue;
    // `workspace/SOUL.md` only counts where a workspace is: with a root set,
    // that file is no longer the one the daemon would read, and discovering a
    // character by a definition nothing goes on to load is worse than not
    // discovering it. The legacy marker is checked either way, because
    // `loadCharacterDefinition` still falls back to it either way.
    if (
      (workspaceRoot === undefined &&
        pathExists(join(dir, CHARACTER_WORKSPACE_DIR, SOUL_FILE))) ||
      pathExists(join(dir, LEGACY_CHARACTER_FILE))
    ) {
      names.add(name);
    }
  }

  if (workspaceRoot !== undefined) {
    for (const name of readdirOrEmpty(workspaceRoot)) {
      const dir = join(workspaceRoot, name);
      if (!isDir(dir)) continue;
      if (pathExists(join(dir, SOUL_FILE))) names.add(name);
    }
  }

  return [...names].sort(compareByCodePoint);
}

/** Directory entries, or none — an unreadable directory is not an error here. */
function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * A character's definition: `workspace/SOUL.md`, else the legacy
 * `characters/{name}/character.md`, else nothing.
 *
 * Unlike most readers in this codebase the content is *not* blank-filtered: an
 * empty `SOUL.md` is a definition of the empty string and stops the legacy
 * fallback, because the Rust branches on `read_to_string(..)` being `Ok`.
 */
export function loadCharacterDefinition(
  config: string,
  name: string,
  workspaceRoot?: string | undefined,
): string | undefined {
  return (
    readOrUndefined(characterWorkspaceFile(config, name, SOUL_FILE, workspaceRoot)) ??
    readOrUndefined(rustJoin(characterConfigDir(config, name), LEGACY_CHARACTER_FILE))
  );
}

/**
 * A character's user definition: `workspace/USER.md`, else the legacy
 * `characters/{name}/user.md`, else nothing.
 */
export function resolveUserDefinition(
  config: string,
  name: string,
  workspaceRoot?: string | undefined,
): string | undefined {
  return (
    readOrUndefined(characterWorkspaceFile(config, name, USER_FILE, workspaceRoot)) ??
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
