import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { compareByCodePoint } from "../util/sort.ts";

export const CHARACTER_WORKSPACE_DIR = "workspace";
export const SOUL_FILE = "SOUL.md";
export const USER_FILE = "USER.md";
export const AGENTS_FILE = "AGENTS.md";
export const TOOLS_FILE = "TOOLS.md";
const MEMORY_DIR = "memory";

const ACTIVE_JSONL_FILE = "active.jsonl";
const SEGMENTS_DIR = "segments";
const COMPACTION_MANIFEST_FILE = "compaction.json";
const THREADS_DIR = "threads";
const THREADS_INDEX_FILE = "threads.json";
const PLUGINS_DIR = "plugins";

const LEGACY_CHARACTER_FILE = "character.md";
const LEGACY_USER_FILE = "user.md";

export interface ShoreDirs {
  config: string;
  data: string;
  runtime: string;
  cache: string;
  workspace?: string | undefined;
}

export type Env = Readonly<Record<string, string | undefined>>;

const PLATFORM: Record<
  "config" | "data" | "runtime" | "cache",
  (env: Env, home: HomeLookup) => string | undefined
> = {
  config: (env, home) => xdgOrHome(env, home, ".config"),
  data: (env, home) => xdgOrHome(env, home, ".local/share"),
  runtime: () => undefined,
  cache: (env, home) => xdgOrHome(env, home, ".cache"),
};

export type HomeLookup = () => string | undefined;

const passwdHome: HomeLookup = () => {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
};

function xdgOrHome(env: Env, home: HomeLookup, rel: string): string | undefined {
  const base = env.HOME !== undefined && env.HOME !== "" ? env.HOME : home();
  if (base === undefined || base === "") return undefined;
  return rustJoin(base, rel);
}

type LastResort =
  | "temp_dir"
  | "refuse";

export class NoHomeDirectoryError extends Error {
  override readonly name = "NoHomeDirectoryError";
}

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

export function workspaceRoot(env: Env = process.env): string | undefined {
  const root = env.SHORE_WORKSPACE_DIR;
  return root === undefined || root === "" ? undefined : root;
}

export const configDir = (env?: Env): string => resolveShoreDirs(env).config;
export const runtimeDir = (env?: Env): string => resolveShoreDirs(env).runtime;

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

export const pluginsDir = (data: string): string => rustJoin(data, PLUGINS_DIR);

export function isUsableCharacterName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  return !/[/\\\0]/.test(name);
}

export const characterConfigDir = (config: string, name: string): string =>
  rustJoin(config, "characters", name);

export const characterWorkspaceDir = (
  config: string,
  name: string,
  workspaceDir?: string,
): string =>
  workspaceDir === undefined
    ? rustJoin(characterConfigDir(config, name), CHARACTER_WORKSPACE_DIR)
    : rustJoin(workspaceDir, name);

export const characterWorkspaceFile = (
  config: string,
  name: string,
  file: string,
  workspaceDir?: string,
): string => rustJoin(characterWorkspaceDir(config, name, workspaceDir), file);

export const characterMemoryDir = (
  config: string,
  name: string,
  workspaceDir?: string,
): string => rustJoin(characterWorkspaceDir(config, name, workspaceDir), MEMORY_DIR);

export const characterDataDir = (data: string, name: string): string => rustJoin(data, name);

export const MAIN_THREAD = "main";

export const characterThreadsDir = (data: string, name: string): string =>
  rustJoin(characterDataDir(data, name), THREADS_DIR);

export const threadsIndexIn = (characterDir: string): string =>
  rustJoin(characterDir, THREADS_INDEX_FILE);

export const characterThreadsIndex = (data: string, name: string): string =>
  threadsIndexIn(characterDataDir(data, name));

export const archiveKey = (character: string, thread: string): string =>
  thread === MAIN_THREAD ? character : `${character}/${thread}`;

export const threadDataDir = (data: string, name: string, thread: string): string =>
  rustJoin(characterThreadsDir(data, name), thread);

export const threadDirIn = (characterDir: string, thread: string): string =>
  rustJoin(characterDir, THREADS_DIR, thread);

export const activeJsonlIn = (conversationDir: string): string =>
  rustJoin(conversationDir, ACTIVE_JSONL_FILE);

export const segmentsDirIn = (conversationDir: string): string =>
  rustJoin(conversationDir, SEGMENTS_DIR);

export const compactionManifestIn = (conversationDir: string): string =>
  rustJoin(conversationDir, COMPACTION_MANIFEST_FILE);

export const characterActiveJsonl = (data: string, name: string, thread: string): string =>
  activeJsonlIn(threadDataDir(data, name, thread));

export const characterSegmentsDir = (data: string, name: string, thread: string): string =>
  segmentsDirIn(threadDataDir(data, name, thread));

export const characterCompactionManifest = (
  data: string,
  name: string,
  thread: string,
): string => compactionManifestIn(threadDataDir(data, name, thread));

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function discoverCharacters(config: string, workspaceDir?: string): string[] {
  const names = new Set<string>();

  const charsDir = rustJoin(config, "characters");
  for (const name of readdirOrEmpty(charsDir)) {
    if (!isUsableCharacterName(name)) continue;
    const dir = join(charsDir, name);
    if (
      (workspaceDir === undefined &&
        pathExists(join(dir, CHARACTER_WORKSPACE_DIR, SOUL_FILE))) ||
      pathExists(join(dir, LEGACY_CHARACTER_FILE))
    ) {
      names.add(name);
    }
  }

  if (workspaceDir !== undefined) {
    for (const name of readdirOrEmpty(workspaceDir)) {
      if (!isUsableCharacterName(name)) continue;
      const dir = join(workspaceDir, name);
      if (pathExists(join(dir, SOUL_FILE))) names.add(name);
    }
  }

  return [...names].sort(compareByCodePoint);
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function loadCharacterDefinition(
  config: string,
  name: string,
  workspaceDir?: string,
): string | undefined {
  return (
    readOrUndefined(characterWorkspaceFile(config, name, SOUL_FILE, workspaceDir)) ??
    readOrUndefined(rustJoin(characterConfigDir(config, name), LEGACY_CHARACTER_FILE))
  );
}

export function resolveUserDefinition(
  config: string,
  name: string,
  workspaceDir?: string,
): string | undefined {
  return (
    readOrUndefined(characterWorkspaceFile(config, name, USER_FILE, workspaceDir)) ??
    readOrUndefined(rustJoin(characterConfigDir(config, name), LEGACY_USER_FILE))
  );
}

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
