import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  appendFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  characterConfigDir,
  characterMemoryDir,
  characterWorkspaceDir,
  characterWorkspaceFile,
} from "../config/dirs.ts";

import {
  activePromptDir,
  activePromptFile,
  normalizePromptVisiblePath,
} from "../tools/workspace_path";
import { localRfc3339 } from "../util/time.ts";

const PROTECTED_PATHS = ["SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md"] as const;

export const MEMORY_INDEX_FILE = "MEMORY.md";

const QUEUE_FILE = "deferred_edits.jsonl";

const LEGACY_SNAPSHOTS = ["RECENT_MEMORY.md", "HEARTBEAT.md"];

const DEFAULT_TOOLS_GUIDANCE = `# TOOLS

Use tools when they materially help.

- Read files before editing them.
- Search memory files before guessing facts about the user or past events.
- Prefer concise, direct tool use over busywork.
`;

export const memoryIndexPath = (
  configDir: string,
  charName: string,
  workspaceRoot?: string | undefined,
) => join(characterWorkspaceDir(configDir, charName, workspaceRoot), MEMORY_INDEX_FILE);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function effectiveContent(p: string): Promise<string | undefined> {
  try {
    const content = await readFile(p, "utf8");
    return content.trim() === "" ? undefined : content;
  } catch {
    return undefined;
  }
}

const canonicalFile = (
  configDir: string,
  charName: string,
  path: string,
  workspaceRoot: string | undefined,
) => characterWorkspaceFile(configDir, charName, path, workspaceRoot);

export const loadActivePromptFile = (characterDataDir: string, name: string) =>
  effectiveContent(activePromptFile(characterDataDir, name));

export const loadCanonicalMemoryIndex = (
  configDir: string,
  charName: string,
  workspaceRoot?: string | undefined,
) => effectiveContent(memoryIndexPath(configDir, charName, workspaceRoot));

export async function loadMemoryIndex(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string | undefined,
): Promise<string | undefined> {
  const active = activePromptFile(characterDataDir, MEMORY_INDEX_FILE);
  if (await exists(active)) return effectiveContent(active);
  return effectiveContent(memoryIndexPath(configDir, charName, workspaceRoot));
}

export async function pendingDeferredEditPaths(
  characterDataDir: string,
): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(join(characterDataDir, QUEUE_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const paths = new Set<string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const raw = (entry as Record<string, unknown>).path;
    if (typeof raw !== "string") continue;
    const normalized = normalizePromptVisiblePath(raw);
    if (normalized !== undefined) paths.add(normalized);
  }
  return [...paths].sort();
}

export async function queueDeferredEdit(
  characterDataDir: string,
  requestedPath: string,
): Promise<void> {
  const path = normalizePromptVisiblePath(requestedPath);
  if (path === undefined) return;

  await mkdir(characterDataDir, { recursive: true });

  if (path === MEMORY_INDEX_FILE) {
    const sentinel = activePromptFile(characterDataDir, MEMORY_INDEX_FILE);
    if (!(await exists(sentinel))) {
      await mkdir(activePromptDir(characterDataDir), { recursive: true });
      await writeFile(sentinel, "", "utf8");
    }
  }

  const line = JSON.stringify({ path, timestamp: localRfc3339(new Date()) });
  await appendFile(join(characterDataDir, QUEUE_FILE), `${line}\n`, "utf8");
}

export const noteMemoryIndexDeferred = (characterDataDir: string) =>
  queueDeferredEdit(characterDataDir, MEMORY_INDEX_FILE);

export async function changedPromptFiles(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string | undefined,
): Promise<string[]> {
  const changed: string[] = [];
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    const canonical = await effectiveContent(
      canonicalFile(configDir, charName, path, workspaceRoot),
    );
    const active = await effectiveContent(
      activePromptFile(characterDataDir, path),
    );
    if (canonical !== active) changed.push(path);
  }
  return changed;
}

async function copyPromptVisibleFile(
  characterDataDir: string,
  configDir: string,
  charName: string,
  path: string,
  seedOnly: boolean,
  workspaceRoot: string | undefined,
): Promise<void> {
  const activeDir = activePromptDir(characterDataDir);
  await mkdir(activeDir, { recursive: true });

  const src = canonicalFile(configDir, charName, path, workspaceRoot);
  const dst = join(activeDir, path);

  if (seedOnly && (await exists(dst))) return;

  if (await exists(src)) {
    await copyFile(src, dst);
  } else if (await exists(dst)) {
    await rm(dst);
  }
}

export async function ensureCharacterWorkspace(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string | undefined,
): Promise<void> {
  const charConfigDir = characterConfigDir(configDir, charName);
  const workspaceDir = characterWorkspaceDir(configDir, charName, workspaceRoot);
  const memoryDir = characterMemoryDir(configDir, charName, workspaceRoot);

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  await migrateLegacyFile(
    join(charConfigDir, "character.md"),
    join(workspaceDir, "SOUL.md"),
  );
  await migrateLegacyFile(
    join(charConfigDir, "user.md"),
    join(workspaceDir, "USER.md"),
  );
  await migrateLegacyFile(
    join(charConfigDir, "prompts", "system.md"),
    join(workspaceDir, "AGENTS.md"),
  );

  const globalUser = join(configDir, "user.md");
  const workspaceUser = join(workspaceDir, "USER.md");
  if ((await exists(globalUser)) && !(await exists(workspaceUser))) {
    await copyFile(globalUser, workspaceUser);
  }

  if (!(await exists(join(workspaceDir, "TOOLS.md")))) {
    await writeFile(join(workspaceDir, "TOOLS.md"), DEFAULT_TOOLS_GUIDANCE, "utf8");
  }

  const legacyMemories = join(characterDataDir, "memories");
  if (await exists(legacyMemories)) {
    await copyTreeIfMissing(legacyMemories, memoryDir);
  }
}

export async function ensureActivePromptSnapshot(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string | undefined,
): Promise<void> {
  await ensureCharacterWorkspace(characterDataDir, configDir, charName, workspaceRoot);

  const activeDir = activePromptDir(characterDataDir);
  await mkdir(activeDir, { recursive: true });

  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    await copyPromptVisibleFile(characterDataDir, configDir, charName, path, true, workspaceRoot);
  }

  for (const legacy of LEGACY_SNAPSHOTS) {
    const p = join(activeDir, legacy);
    if (await exists(p)) await rm(p);
  }
}

export async function refreshActivePromptSnapshot(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string | undefined,
): Promise<void> {
  await ensureCharacterWorkspace(characterDataDir, configDir, charName, workspaceRoot);
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    await copyPromptVisibleFile(characterDataDir, configDir, charName, path, false, workspaceRoot);
  }
}

export async function applyDeferredEdits(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string | undefined,
): Promise<void> {
  await refreshActivePromptSnapshot(characterDataDir, configDir, charName, workspaceRoot);
  await rm(join(characterDataDir, QUEUE_FILE), { force: true });
}

async function migrateLegacyFile(src: string, dst: string): Promise<void> {
  if ((await exists(src)) && !(await exists(dst))) {
    await copyFile(src, dst);
  }
}

async function copyTreeIfMissing(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyTreeIfMissing(srcPath, dstPath);
    } else if (!(await exists(dstPath))) {
      await copyFile(srcPath, dstPath);
    }
  }
}
