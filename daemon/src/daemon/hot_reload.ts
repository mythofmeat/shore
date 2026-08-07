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

/** How long the tree has to be quiet before a reload is worth doing. */
export const DEBOUNCE_MS = 500;

export interface ConfigWatcherOptions {
  /** The file the daemon was started with; always triggers, wherever it is. */
  readonly configPath: string;
  /** The tree to watch. Everything else is judged relative to this. */
  readonly configDir: string;
  /** Re-read and adopt. Never called concurrently with itself. */
  readonly reload: (changedPaths: readonly string[]) => Promise<void>;
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

  let watcher: FSWatcher;
  try {
    watcher = watch(options.configDir, { recursive: true }, (_event, name) => {
      if (name === null || name === undefined) return;
      const path = resolve(options.configDir, name.toString());
      if (!pathTriggersReload(options.configDir, options.configPath, path)) return;
      pending.add(path);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
      timer.unref?.();
    });
  } catch (e) {
    options.log?.warn?.("Config hot reload watcher could not start", {
      config_dir: options.configDir,
      error: String(e),
    });
    return undefined;
  }

  watcher.on("error", (e) => {
    options.log?.warn?.("Config hot reload watcher error", { error: String(e) });
  });

  options.log?.info?.("Config hot reload watcher started", {
    config_path: options.configPath,
    config_dir: options.configDir,
  });

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
      options.log?.info?.("Config hot reload watcher stopped");
    },
  };
}

/**
 * Whether a changed path is one the daemon reads its configuration from.
 *
 * The rules, in the order they are applied:
 *
 * | Path | Reloads | Why |
 * |---|---|---|
 * | the config file itself | yes | wherever it is, including outside the tree |
 * | `characters/<n>/workspace/**` | **no** | prompts and memory — see the module doc |
 * | `.env` at the root | yes | provider keys are read from it |
 * | `conf.d/` | yes | the directory itself, or any `.toml` under it |
 * | `characters/<n>` | yes | a character appearing or going |
 * | `characters/<n>/config.toml` | yes | the per-character overlay |
 * | `characters/<n>/character.md` | yes | the definition discovery reads |
 * | anything else `.toml` | yes | `models.toml`, and whatever else is added |
 * | anything else | no | |
 */
export function pathTriggersReload(
  configDirIn: string,
  configPathIn: string,
  pathIn: string,
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
  if (first === "characters" && parts[2] === "workspace") return false;

  if (parts.length === 1 && first === ".env") return true;

  if (first === "conf.d") return parts.length === 1 || hasTomlExtension(path);

  if (first === "characters") {
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
