import { readDurable } from "../storage/files.ts";
import { readCharacterState, writeCharacterState, deleteCharacterState, characterScope, withStorage } from "../storage/store.ts";
import { constants } from "node:fs";
import {
  access,
  stat,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  activeJsonlIn,
  characterConfigDir,
  threadDirIn,
  characterMemoryDir,
  characterWorkspaceDir,
  characterWorkspaceFile,
} from "../config/dirs.ts";
import { homeThreadIn } from "../engine/threads.ts";

import {
  activePromptDir,
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
  workspaceRoot?: string,
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

export const loadActivePromptFile = async (characterDataDir: string, name: string) =>
  activeContent(characterDataDir, name);

export async function loadPromptFile(
  characterDataDir: string,
  configDir: string,
  charName: string,
  name: string,
  workspaceRoot?: string,
): Promise<string | undefined> {
  if (await activePromptSnapshotExists(characterDataDir)) {
    return activeContent(characterDataDir, name);
  }
  return effectiveContent(canonicalFile(configDir, charName, name, workspaceRoot));
}

function activeContent(characterDir: string, name: string): string | undefined {
  const content = readCharacterState(characterDir, `active_prompt/${name}`);
  return content?.trim() === "" ? undefined : content;
}

async function activePromptSnapshotExists(characterDir: string): Promise<boolean> {
  const legacy = activePromptDir(characterDir);
  if (await exists(legacy)) {
    if (!(await stat(legacy)).isDirectory()) return false;
    for (const name of await readdir(legacy)) readCharacterState(characterDir, `active_prompt/${name}`);
    writeCharacterState(characterDir, "active_prompt/.snapshot", "1");
    await rm(legacy, { recursive: true });
  }
  return readCharacterState(characterDir, "active_prompt/.snapshot") !== undefined;
}

export const loadCanonicalMemoryIndex = (
  configDir: string,
  charName: string,
  workspaceRoot?: string,
) => effectiveContent(memoryIndexPath(configDir, charName, workspaceRoot));

export async function loadMemoryIndex(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string,
): Promise<string | undefined> {
  if (await activePromptSnapshotExists(characterDataDir)) {
    return activeContent(characterDataDir, MEMORY_INDEX_FILE);
  }
  return effectiveContent(memoryIndexPath(configDir, charName, workspaceRoot));
}

export async function pendingDeferredEditPaths(
  characterDataDir: string,
): Promise<string[]> {
  let content: string;
  try {
    content = readCharacterState(characterDataDir, QUEUE_FILE) ?? "";
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

  const line = JSON.stringify({ path, timestamp: localRfc3339(new Date()) });
  writeCharacterState(characterDataDir, QUEUE_FILE, (readCharacterState(characterDataDir, QUEUE_FILE) ?? "") + `${line}\n`);
}

export const noteMemoryIndexDeferred = (characterDataDir: string) =>
  queueDeferredEdit(characterDataDir, MEMORY_INDEX_FILE);

export async function changedPromptFiles(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string,
): Promise<string[]> {
  if (!(await activePromptSnapshotExists(characterDataDir))) return [];
  const changed: string[] = [];
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    const canonical = await effectiveContent(
      canonicalFile(configDir, charName, path, workspaceRoot),
    );
    const active = activeContent(characterDataDir, path);
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
  const key = `active_prompt/${path}`;
  if (seedOnly && readCharacterState(characterDataDir, key) !== undefined) return;
  const src = canonicalFile(configDir, charName, path, workspaceRoot);
  if (await exists(src)) writeCharacterState(characterDataDir, key, await readFile(src, "utf8"));
  else deleteCharacterState(characterDataDir, key);
}

export async function ensureCharacterWorkspace(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string,
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
  workspaceRoot?: string,
): Promise<void> {
  await ensureCharacterWorkspace(characterDataDir, configDir, charName, workspaceRoot);

  const legacyPrompt = activePromptDir(characterDataDir);
  if (await exists(legacyPrompt) && !(await stat(legacyPrompt)).isDirectory()) throw new Error(`Blocked prompt snapshot: ${legacyPrompt}`);
  await activePromptSnapshotExists(characterDataDir);
  writeCharacterState(characterDataDir, "active_prompt/.snapshot", "1");

  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    await copyPromptVisibleFile(characterDataDir, configDir, charName, path, true, workspaceRoot);
  }

  for (const legacy of LEGACY_SNAPSHOTS) {
    deleteCharacterState(characterDataDir, `active_prompt/${legacy}`);
  }
}

export async function refreshActivePromptSnapshot(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string,
): Promise<void> {
  await ensureCharacterWorkspace(characterDataDir, configDir, charName, workspaceRoot);
  writeCharacterState(characterDataDir, "active_prompt/.snapshot", "1");
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    await copyPromptVisibleFile(characterDataDir, configDir, charName, path, false, workspaceRoot);
  }
}

export async function resetActivePromptSnapshot(characterDataDir: string): Promise<void> {
  await rm(activePromptDir(characterDataDir), { recursive: true, force: true });
  const { data, character } = characterScope(characterDataDir);
  withStorage(data, (db) => db.query("DELETE FROM state_files WHERE character = ?1 AND substr(path, 1, length(?2)) = ?2").run(character, `${character}/active_prompt/`));
  deleteCharacterState(characterDataDir, QUEUE_FILE);
}

async function conversationHasMessages(conversationDir: string): Promise<boolean> {
  try {
    return (readDurable(activeJsonlIn(conversationDir))).trim() !== "";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export async function resetActivePromptSnapshotIfEmpty(
  characterDataDir: string,
  conversationDir: string,
): Promise<boolean> {
  if (await conversationHasMessages(conversationDir)) return false;
  await resetActivePromptSnapshot(characterDataDir);
  return true;
}

export async function applyDeferredEdits(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string,
): Promise<void> {
  if (
    await resetActivePromptSnapshotIfEmpty(
      characterDataDir,
      threadDirIn(characterDataDir, await homeThreadIn(characterDataDir)),
    )
  ) return;
  await refreshActivePromptSnapshot(characterDataDir, configDir, charName, workspaceRoot);
  deleteCharacterState(characterDataDir, QUEUE_FILE);
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
