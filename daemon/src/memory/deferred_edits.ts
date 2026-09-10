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
  MAIN_THREAD,
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
const stateFile = (thread: string, file: string): string => thread === MAIN_THREAD ? file : `threads/${thread}/${file}`;
const snapshotDir = (characterDir: string, thread: string): string => activePromptDir(thread === MAIN_THREAD ? characterDir : threadDirIn(characterDir, thread));


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

export const loadActivePromptFile = async (characterDataDir: string, name: string, thread = MAIN_THREAD) =>
  activeContent(characterDataDir, name, thread);

export async function loadPromptFile(
  characterDataDir: string,
  configDir: string,
  charName: string,
  name: string,
  workspaceRoot?: string,
  thread = MAIN_THREAD,
): Promise<string | undefined> {
  if (await activePromptSnapshotExists(characterDataDir, thread)) {
    return activeContent(characterDataDir, name, thread);
  }
  return effectiveContent(canonicalFile(configDir, charName, name, workspaceRoot));
}

function activeContent(characterDir: string, name: string, thread: string): string | undefined {
  const content = readCharacterState(characterDir, stateFile(thread, `active_prompt/${name}`));
  return content?.trim() === "" ? undefined : content;
}

async function activePromptSnapshotExists(characterDir: string, thread: string): Promise<boolean> {
  const legacy = snapshotDir(characterDir, thread);
  if (await exists(legacy)) {
    if (!(await stat(legacy)).isDirectory()) return false;
    for (const name of await readdir(legacy)) readCharacterState(characterDir, stateFile(thread, `active_prompt/${name}`));
    writeCharacterState(characterDir, stateFile(thread, "active_prompt/.snapshot"), "1");
    await rm(legacy, { recursive: true });
  }
  return readCharacterState(characterDir, stateFile(thread, "active_prompt/.snapshot")) !== undefined;
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
  thread = MAIN_THREAD,
): Promise<string | undefined> {
  if (await activePromptSnapshotExists(characterDataDir, thread)) {
    return activeContent(characterDataDir, MEMORY_INDEX_FILE, thread);
  }
  return effectiveContent(memoryIndexPath(configDir, charName, workspaceRoot));
}

export async function pendingDeferredEditPaths(
  characterDataDir: string,
  thread = MAIN_THREAD,
): Promise<string[]> {
  let content: string;
  try {
    content = readCharacterState(characterDataDir, stateFile(thread, QUEUE_FILE)) ?? "";
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
  thread = MAIN_THREAD,
): Promise<void> {
  const path = normalizePromptVisiblePath(requestedPath);
  if (path === undefined) return;

  await mkdir(characterDataDir, { recursive: true });

  const line = JSON.stringify({ path, timestamp: localRfc3339(new Date()) });
  writeCharacterState(characterDataDir, stateFile(thread, QUEUE_FILE), (readCharacterState(characterDataDir, stateFile(thread, QUEUE_FILE)) ?? "") + `${line}\n`);
}

export const noteMemoryIndexDeferred = (characterDataDir: string, thread = MAIN_THREAD) =>
  queueDeferredEdit(characterDataDir, MEMORY_INDEX_FILE, thread);

export async function changedPromptFiles(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string,
  thread = MAIN_THREAD,
): Promise<string[]> {
  if (!(await activePromptSnapshotExists(characterDataDir, thread))) return [];
  const changed: string[] = [];
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    const canonical = await effectiveContent(
      canonicalFile(configDir, charName, path, workspaceRoot),
    );
    const active = activeContent(characterDataDir, path, thread);
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
  thread: string,
): Promise<void> {
  const key = stateFile(thread, `active_prompt/${path}`);
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
  thread = MAIN_THREAD,
): Promise<void> {
  await ensureCharacterWorkspace(characterDataDir, configDir, charName, workspaceRoot);

  const legacyPrompt = snapshotDir(characterDataDir, thread);
  if (await exists(legacyPrompt) && !(await stat(legacyPrompt)).isDirectory()) throw new Error(`Blocked prompt snapshot: ${legacyPrompt}`);
  await activePromptSnapshotExists(characterDataDir, thread);

  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    await copyPromptVisibleFile(characterDataDir, configDir, charName, path, true, workspaceRoot, thread);
  }

  for (const legacy of LEGACY_SNAPSHOTS) {
    deleteCharacterState(characterDataDir, stateFile(thread, `active_prompt/${legacy}`));
  }
  writeCharacterState(characterDataDir, stateFile(thread, "active_prompt/.snapshot"), "1");
}

export async function refreshActivePromptSnapshot(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string,
  thread = MAIN_THREAD,
): Promise<void> {
  await ensureCharacterWorkspace(characterDataDir, configDir, charName, workspaceRoot);
  writeCharacterState(characterDataDir, stateFile(thread, "active_prompt/.snapshot"), "1");
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    await copyPromptVisibleFile(characterDataDir, configDir, charName, path, false, workspaceRoot, thread);
  }
}

export async function forkPromptState(
  characterDir: string,
  source: string,
  child: string,
): Promise<void> {
  const hasSnapshot = await activePromptSnapshotExists(characterDir, source);
  const files = hasSnapshot
    ? [...PROTECTED_PATHS, MEMORY_INDEX_FILE].map(path => `active_prompt/${path}`)
    : [];
  await rm(snapshotDir(characterDir, child), { recursive: true, force: true });
  const { data, character } = characterScope(characterDir);
  withStorage(data, db => db.transaction(() => {
    const childPromptPrefix = `${character}/${stateFile(child, "active_prompt/")}`;
    db.query(
      "DELETE FROM state_files WHERE character = ?1 AND substr(path, 1, length(?2)) = ?2",
    ).run(character, childPromptPrefix);
    deleteCharacterState(characterDir, stateFile(child, QUEUE_FILE));
    for (const file of files) {
      const content = readCharacterState(characterDir, stateFile(source, file)) ?? "";
      writeCharacterState(characterDir, stateFile(child, file), content);
    }
    if (hasSnapshot) writeCharacterState(characterDir, stateFile(child, "active_prompt/.snapshot"), "1");
    const queue = readCharacterState(characterDir, stateFile(source, QUEUE_FILE));
    if (queue !== undefined) writeCharacterState(characterDir, stateFile(child, QUEUE_FILE), queue);
  })());
}

export async function resetActivePromptSnapshot(characterDataDir: string, thread = MAIN_THREAD): Promise<void> {
  await rm(snapshotDir(characterDataDir, thread), { recursive: true, force: true });
  const { data, character } = characterScope(characterDataDir);
  withStorage(data, (db) => db.query("DELETE FROM state_files WHERE character = ?1 AND substr(path, 1, length(?2)) = ?2").run(character, `${character}/${stateFile(thread, "active_prompt/")}`));
  deleteCharacterState(characterDataDir, stateFile(thread, QUEUE_FILE));
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
  thread = MAIN_THREAD,
): Promise<boolean> {
  if (await conversationHasMessages(conversationDir)) return false;
  await resetActivePromptSnapshot(characterDataDir, thread);
  return true;
}

export async function applyDeferredEdits(
  characterDataDir: string,
  configDir: string,
  charName: string,
  workspaceRoot?: string,
  thread?: string,
): Promise<void> {
  const selected = thread ?? await homeThreadIn(characterDataDir);
  if (await resetActivePromptSnapshotIfEmpty(characterDataDir, threadDirIn(characterDataDir, selected), selected)) return;
  await refreshActivePromptSnapshot(characterDataDir, configDir, charName, workspaceRoot, selected);
  deleteCharacterState(characterDataDir, stateFile(selected, QUEUE_FILE));
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
