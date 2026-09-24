import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { CHARACTER_WORKSPACE_DIR, SOUL_FILE } from "../config/dirs.ts";

const DEBOUNCE_MS = 500;

export interface DebounceClock {
  readonly set: (fire: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export type DirectoryWatch = (
  dir: string,
  onChange: (name: string) => void,
  onError: (error: unknown) => void,
) => { close: () => void };

const REAL_CLOCK: DebounceClock = {
  set: (fire, ms) => {
    const handle = setTimeout(fire, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const REAL_WATCH: DirectoryWatch = (dir, onChange, onError) => {
  const watcher: FSWatcher = watch(dir, { recursive: true }, (_event, name) => {
    if (name === null || name === undefined) return;
    onChange(name);
  });
  watcher.on("error", onError);
  return watcher;
};

export interface ConfigWatcherOptions {
  readonly configPath: string;
  readonly configDir: string;
  readonly reload: (changedPaths: readonly string[]) => Promise<void>;
  readonly knownCharacter?: ((name: string) => boolean) | undefined;
  readonly workspaceDir?: string | undefined;
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    warn?: (msg: string, fields?: Record<string, unknown>) => void;
  };
  readonly debounceMs?: number | undefined;
  readonly clock?: DebounceClock | undefined;
  readonly watchDirectory?: DirectoryWatch | undefined;
}

export function startConfigWatcher(
  options: ConfigWatcherOptions,
): { stop: () => Promise<void> } | undefined {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const clock = options.clock ?? REAL_CLOCK;
  const watchDirectory = options.watchDirectory ?? REAL_WATCH;
  const pending = new Set<string>();
  let timer: unknown;
  let stopped = false;
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
    if (timer !== undefined) clock.clear(timer);
    timer = clock.set(fire, debounceMs);
  };

  const start = (
    dir: string,
    triggers: (path: string) => boolean,
  ): { close: () => void } | undefined => {
    try {
      return watchDirectory(
        dir,
        (name) => {
          const path = resolve(dir, name);
          if (triggers(path)) note(path);
        },
        (e) => {
          options.log?.warn?.("Config hot reload watcher error", { error: String(e) });
        },
      );
    } catch (e) {
      options.log?.warn?.("Config hot reload watcher could not start", {
        config_dir: dir,
        error: String(e),
      });
      return undefined;
    }
  };

  const watcher = start(options.configDir, (path) =>
    pathTriggersReload(options.configDir, options.configPath, path, options.knownCharacter),
  );
  if (watcher === undefined) return undefined;

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
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clock.clear(timer);
      watcher.close();
      workspaceWatcher?.close();
      await inFlight;
      options.log?.info?.("Config hot reload watcher stopped");
    },
  };
}

export function workspacePathTriggersReload(
  workspaceDirIn: string,
  pathIn: string,
  knownCharacter?: ((name: string) => boolean),
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

export function pathTriggersReload(
  configDirIn: string,
  configPathIn: string,
  pathIn: string,
  knownCharacter?: ((name: string) => boolean),
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

  if (first === "characters" && parts[2] === CHARACTER_WORKSPACE_DIR) {
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

function stripPrefix(prefix: string, path: string): string | undefined {
  if (path === prefix) return "";
  const base = prefix.endsWith(sep) ? prefix : prefix + sep;
  return path.startsWith(base) ? path.slice(base.length) : undefined;
}

function hasTomlExtension(path: string): boolean {
  return path.endsWith(".toml");
}
