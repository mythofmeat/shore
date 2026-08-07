/**
 * Watching the config directory, and deciding what is worth a reload.
 *
 * Ported from `crates/daemon/src/hot_reload.rs`.
 *
 * # Most of what changes under `<config>/` is not config
 *
 * The watcher is recursive because config is spread across several files — the
 * main `config.toml`, `conf.d/*.toml`, `.env`, and a `config.toml` per
 * character. But the same tree holds every character's *workspace*: `SOUL.md`,
 * `MEMORY.md`, the memory files a tool writes during a turn.
 *
 * Those are ignored, and not as an optimisation. A prompt file is part of the
 * cached prefix, and a reload is a natural place to rebuild one — so a
 * filesystem save would become a prompt activation boundary, and a character
 * editing its own memory mid-conversation would invalidate the cache it is
 * talking through. {@link pathTriggersReload} is where that line is drawn.
 *
 * # Debounce
 *
 * An editor writing a file produces several events — a temp file, a rename, a
 * chmod — and a `git checkout` produces hundreds. {@link DEBOUNCE_MS} after the
 * last one, whatever accumulated is reloaded once.
 */

import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { CHARACTER_WORKSPACE_DIR, SOUL_FILE } from "../config/dirs.ts";

/** How long the tree has to be quiet before a reload is worth doing. */
export const DEBOUNCE_MS = 500;

export interface ConfigWatcherOptions {
  /** The file the daemon was started with; always triggers, wherever it is. */
  readonly configPath: string;
  /** The tree to watch. Everything else is judged relative to this. */
  readonly configDir: string;
  /** Re-read and adopt. Never called concurrently with itself. */
  readonly reload: (changedPaths: readonly string[]) => Promise<void>;
  /**
   * Whether the registry already knows a character, which is the one thing
   * that makes a `workspace/` path worth reloading — see
   * {@link pathTriggersReload}. Omitted, every workspace path is ignored, which
   * is the behaviour without it.
   */
  readonly knownCharacter?: ((name: string) => boolean) | undefined;
  /**
   * `SHORE_WORKSPACE_DIR`, when workspaces live outside the config tree.
   *
   * Watched as a *second* tree, under {@link workspacePathTriggersReload} —
   * which lets through only the appearance of a character and nothing else, so
   * the rule the module doc describes is the same rule either way. Omitted,
   * only the config directory is watched, which is the default layout.
   */
  readonly workspaceDir?: string | undefined;
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    warn?: (msg: string, fields?: Record<string, unknown>) => void;
  };
  /** Injected by tests, which cannot wait half a second per assertion. */
  readonly debounceMs?: number | undefined;
}

/**
 * Start watching, or answer `undefined` and carry on without it.
 *
 * A watcher that will not start is a warning, not a failure — the config
 * directory may not exist yet, and a daemon that refused to run because it
 * could not watch for edits would be trading the service for a convenience.
 */
export function startConfigWatcher(
  options: ConfigWatcherOptions,
): { stop: () => void } | undefined {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // One reload at a time. A `git checkout` can land a second burst while the
  // first is still loading, and two overlapping reloads would race to be the
  // config the registry ends up holding.
  let inFlight: Promise<void> = Promise.resolve();

  const fire = () => {
    timer = undefined;
    if (stopped || pending.size === 0) return;
    const changedPaths = [...pending].sort();
    pending.clear();
    inFlight = inFlight.then(async () => {
      if (stopped) return;
      try {
        await options.reload(changedPaths);
      } catch (e) {
        options.log?.warn?.("Config hot reload threw", { error: String(e) });
      }
    });
  };

  const note = (path: string) => {
    pending.add(path);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
    timer.unref?.();
  };

  /** Start one recursive watch, or warn and answer nothing. */
  const start = (dir: string, triggers: (path: string) => boolean): FSWatcher | undefined => {
    let w: FSWatcher;
    try {
      w = watch(dir, { recursive: true }, (_event, name) => {
        if (name === null || name === undefined) return;
        const path = resolve(dir, name.toString());
        if (triggers(path)) note(path);
      });
    } catch (e) {
      options.log?.warn?.("Config hot reload watcher could not start", {
        config_dir: dir,
        error: String(e),
      });
      return undefined;
    }
    w.on("error", (e) => {
      options.log?.warn?.("Config hot reload watcher error", { error: String(e) });
    });
    return w;
  };

  const watcher = start(options.configDir, (path) =>
    pathTriggersReload(options.configDir, options.configPath, path, options.knownCharacter),
  );
  if (watcher === undefined) return undefined;

  // A second watch, and only when workspaces are somewhere else. The config
  // tree cannot see a character appear under `SHORE_WORKSPACE_DIR`, and a
  // character nothing notices is one that stays invisible until an unrelated
  // config edit happens to reload — the same failure the `SOUL.md` exemption
  // exists to prevent, in the layout that moved the file out of reach.
  const workspaceWatcher =
    options.workspaceDir === undefined
      ? undefined
      : start(options.workspaceDir, (path) =>
          workspacePathTriggersReload(
            options.workspaceDir as string,
            path,
            options.knownCharacter,
          ),
        );

  options.log?.info?.("Config hot reload watcher started", {
    config_path: options.configPath,
    config_dir: options.configDir,
    ...(options.workspaceDir === undefined ? {} : { workspace_dir: options.workspaceDir }),
  });

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
      workspaceWatcher?.close();
      options.log?.info?.("Config hot reload watcher stopped");
    },
  };
}

/**
 * Whether a path under `SHORE_WORKSPACE_DIR` is worth a reload.
 *
 * Almost nothing is. A workspace root holds *only* workspaces — prompts and
 * memory, written mid-turn — so the single case that reloads is the one that
 * changes what characters exist: `<root>/<name>/SOUL.md` appearing for a name
 * the registry does not hold yet. Everything else, including edits to a known
 * character's own `SOUL.md`, is ignored for the reason in the module doc: a
 * save must not become a prompt activation boundary.
 *
 * Without `knownCharacter` nothing here triggers, matching the config-tree
 * rule, where a caller that does not care gets no workspace reloads at all.
 */
export function workspacePathTriggersReload(
  workspaceDirIn: string,
  pathIn: string,
  knownCharacter?: ((name: string) => boolean) | undefined,
): boolean {
  const relative = stripPrefix(absolutize(workspaceDirIn), absolutize(pathIn));
  if (relative === undefined) return false;
  const parts = relative.split(sep).filter((part) => part !== "" && part !== ".");
  const name = parts[0];
  return (
    parts.length === 2 &&
    parts[1] === SOUL_FILE &&
    name !== undefined &&
    knownCharacter !== undefined &&
    !knownCharacter(name)
  );
}

/**
 * Whether a changed path is one the daemon reads its configuration from.
 *
 * The rules, in the order they are applied:
 *
 * | Path | Reloads | Why |
 * |---|---|---|
 * | the config file itself | yes | wherever it is, including outside the tree |
 * | `characters/<n>/workspace/SOUL.md`, `<n>` unknown | yes | the character is *appearing* |
 * | `characters/<n>/workspace/**` | **no** | prompts and memory — see the module doc |
 * | `.env` at the root | yes | provider keys are read from it |
 * | `conf.d/` | yes | the directory itself, or any `.toml` under it |
 * | `characters/<n>` | yes | a character appearing or going |
 * | `characters/<n>/config.toml` | yes | the per-character overlay |
 * | `characters/<n>/character.md` | yes | the definition discovery reads |
 * | anything else `.toml` | yes | `models.toml`, and whatever else is added |
 * | anything else | no | |
 *
 * # Why `SOUL.md` gets an exemption from the workspace rule
 *
 * `discoverCharacters` keys on `workspace/SOUL.md`, so that file is not only a
 * prompt — its *existence* is what makes a directory a character. Ignoring it
 * unconditionally means the sequence that creates one is invisible: the
 * `characters/<n>` event fires while the directory is still empty and finds
 * nothing, and the write that would have made it discoverable is swallowed. A
 * new character was therefore not picked up until some unrelated config edit
 * happened to trigger a reload.
 *
 * `knownCharacter` is what keeps this from reopening what the rule is for. An
 * edit to the `SOUL.md` of a character the registry already holds is still
 * ignored, so a save is still not a prompt activation boundary and a character
 * rewriting its own prompt still cannot invalidate the prefix it is talking
 * through. Only the first appearance reloads, and it can only happen once.
 *
 * Without the predicate every workspace path is ignored, which is the Rust's
 * behaviour and the behaviour of every caller that does not care.
 */
export function pathTriggersReload(
  configDirIn: string,
  configPathIn: string,
  pathIn: string,
  knownCharacter?: ((name: string) => boolean) | undefined,
): boolean {
  const configDir = absolutize(configDirIn);
  const configPath = absolutize(configPathIn);
  const path = absolutize(pathIn);

  if (path === configPath) return true;

  const relative = stripPrefix(configDir, path);
  if (relative === undefined) return false;
  const parts = relative.split(sep).filter((part) => part !== "" && part !== ".");
  const first = parts[0];
  if (first === undefined) return false;

  // Before every other rule, including the `.toml` catch-all: a character's
  // memory directory holds `.toml` files that a tool writes mid-turn.
  if (first === "characters" && parts[2] === CHARACTER_WORKSPACE_DIR) {
    // ...except the file whose appearance *is* the character. See above.
    const name = parts[1];
    return (
      parts.length === 4 &&
      parts[3] === SOUL_FILE &&
      name !== undefined &&
      knownCharacter !== undefined &&
      !knownCharacter(name)
    );
  }

  if (parts.length === 1 && first === ".env") return true;

  if (first === "conf.d") return parts.length === 1 || hasTomlExtension(path);

  if (first === "characters") {
    // The directory itself, which is the only event a first character produces.
    // `create_dir_all(characters/<n>/workspace)` makes three levels faster than
    // the recursive watcher can register a watch on each new one, so `<n>` and
    // everything under it are never reported — only `characters`. Ignoring it
    // meant the first character on a machine was invisible until some unrelated
    // edit happened to trigger a reload.
    //
    // Safe to reload on, because a deep write reports its own path: a character
    // editing its workspace mid-turn produces `characters/<n>/workspace/...`,
    // never a bare `characters`. Verified rather than assumed — it is the whole
    // reason this is not a hole in the rule below.
    if (parts.length === 1) return true;
    if (parts.length === 2) return true;
    if (parts.length === 3 && (parts[2] === "config.toml" || parts[2] === "character.md")) {
      return true;
    }
    return hasTomlExtension(path);
  }

  return hasTomlExtension(path);
}

function absolutize(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

/** The part of `path` under `prefix`, or `undefined` when it is not under it. */
function stripPrefix(prefix: string, path: string): string | undefined {
  if (path === prefix) return "";
  const base = prefix.endsWith(sep) ? prefix : prefix + sep;
  return path.startsWith(base) ? path.slice(base.length) : undefined;
}

function hasTomlExtension(path: string): boolean {
  return path.endsWith(".toml");
}
