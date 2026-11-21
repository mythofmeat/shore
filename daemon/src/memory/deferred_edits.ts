import { readDurable } from "../storage/files.ts";
import { readCharacterState, writeCharacterState, deleteCharacterState, characterScope, withStorage } from "../storage/store.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  MAIN_THREAD,
  activeJsonlIn,
  threadDirIn,
  characterWorkspaceDir,
} from "../config/dirs.ts";
import { homeThreadIn, pinnedCommand, readThreadsIndexIn, threadRecord } from "../engine/threads.ts";

import { asCharacterWorkspace, type CharacterWorkspace } from "../tools/character_workspace.ts";
import {
  normalizePromptVisiblePath,
} from "../tools/workspace_path";
import { cutToBytes, MAX_THREAD_PINS_BYTES, byteSize, threadFilePromptText } from "../tools/thread_file_text.ts";
import { pinnedCommandText } from "../tools/pinned_command.ts";
import { localRfc3339 } from "../util/time.ts";
import defaultToolsGuidance from "../../prompts/engine/default_tools.md" with { type: "text" };

const PROTECTED_PATHS = ["SOUL.md", "USER.md", "TOOLS.md"] as const;

const MEMORY_INDEX_FILE = "MEMORY.md";

const MEMORY_DIR = "memory";

const QUEUE_FILE = "deferred_edits.jsonl";

const THREAD_PINS_DIR = "thread_pins";
const stateFile = (thread: string, file: string): string => thread === MAIN_THREAD ? file : `threads/${thread}/${file}`;
export const memoryIndexPath = (
  configDir: string,
  charName: string,
  workspaceRoot?: string,
) => join(characterWorkspaceDir(configDir, charName, workspaceRoot), MEMORY_INDEX_FILE);

async function workspaceBytes(workspace: CharacterWorkspace, name: string): Promise<Buffer | undefined> {
  const [read] = await workspace.call("readFiles", { paths: [join(workspace.dir, name)] });
  if (read === undefined) return undefined;
  if ("data" in read) return Buffer.from(read.data, "base64");
  if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(read.error.code ?? "")) return undefined;
  throw Object.assign(new Error(read.error.message), read.error.code === undefined ? {} : { code: read.error.code });
}

async function workspaceFile(workspace: CharacterWorkspace, name: string): Promise<string | undefined> {
  return (await workspaceBytes(workspace, name))?.toString("utf8");
}

async function threadFileContent(workspace: CharacterWorkspace, name: string): Promise<string | undefined> {
  const bytes = await workspaceBytes(workspace, name).catch(() => undefined);
  return bytes === undefined ? undefined : threadFilePromptText(name, bytes);
}

async function pinContent(characterDataDir: string, workspace: CharacterWorkspace, pin: string): Promise<string | undefined> {
  const command = pinnedCommand(pin);
  return command === undefined
    ? await threadFileContent(workspace, pin)
    : await pinnedCommandText(workspace, characterScope(characterDataDir).character, command);
}

async function effectiveContent(workspace: CharacterWorkspace, name: string): Promise<string | undefined> {
  const [read] = await workspace.call("readFiles", { paths: [join(workspace.dir, name)] });
  if (read === undefined || !("data" in read)) return undefined;
  const content = Buffer.from(read.data, "base64").toString("utf8");
  return content.trim() === "" ? undefined : content;
}

export const loadActivePromptFile = async (characterDataDir: string, name: string, thread = MAIN_THREAD) =>
  activeContent(characterDataDir, name, thread);

export async function loadPromptFile(
  characterDataDir: string,
  workspace: CharacterWorkspace,
  name: string,
  thread = MAIN_THREAD,
): Promise<string | undefined> {
  return await loadPromptFileFromWorkspace(characterDataDir, workspace, name, thread);
}

export async function loadPromptFileFromWorkspace(
  characterDataDir: string,
  target: string | CharacterWorkspace,
  name: string,
  thread = MAIN_THREAD,
): Promise<string | undefined> {
  if (await activePromptSnapshotExists(characterDataDir, thread)) {
    return activeContent(characterDataDir, name, thread);
  }
  return effectiveContent(asCharacterWorkspace(target), name);
}

function activeContent(characterDir: string, name: string, thread: string): string | undefined {
  const content = readCharacterState(characterDir, stateFile(thread, `active_prompt/${name}`));
  return content?.trim() === "" ? undefined : content;
}

async function activePromptSnapshotExists(characterDir: string, thread: string): Promise<boolean> {
  return readCharacterState(characterDir, stateFile(thread, "active_prompt/.snapshot")) !== undefined;
}

export async function loadMemoryIndex(
  characterDataDir: string,
  workspace: CharacterWorkspace,
  thread = MAIN_THREAD,
): Promise<string | undefined> {
  return await loadPromptFile(characterDataDir, workspace, MEMORY_INDEX_FILE, thread);
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
  workspace: CharacterWorkspace,
  thread = MAIN_THREAD,
): Promise<string[]> {
  if (!(await activePromptSnapshotExists(characterDataDir, thread))) return [];
  const changed: string[] = [];
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    const canonical = await effectiveContent(workspace, path);
    const active = activeContent(characterDataDir, path, thread);
    if (canonical !== active) changed.push(path);
  }
  return changed;
}

async function copyPromptVisibleFile(
  characterDataDir: string,
  workspace: CharacterWorkspace,
  path: string,
  seedOnly: boolean,
  thread: string,
): Promise<void> {
  const key = stateFile(thread, `active_prompt/${path}`);
  if (seedOnly && readCharacterState(characterDataDir, key) !== undefined) return;
  const pin = pinOf(path);
  const content = pin === undefined
    ? await workspaceFile(workspace, path)
    : await pinContent(characterDataDir, workspace, pin);
  if (content !== undefined) writeCharacterState(characterDataDir, key, content);
  else deleteCharacterState(characterDataDir, key);
}

export async function ensureCharacterWorkspace(workspace: CharacterWorkspace): Promise<void> {
  await workspace.call("mkdir", { path: workspace.dir });
  await workspace.call("mkdir", { path: join(workspace.dir, MEMORY_DIR) });
  await workspace.call("createFile", { path: join(workspace.dir, "TOOLS.md"), data: Buffer.from(defaultToolsGuidance, "utf8").toString("base64") });
}

async function snapshotFiles(characterDataDir: string, thread: string): Promise<string[]> {
  const index = await readThreadsIndexIn(characterDataDir);
  const pins = index === undefined ? [] : threadRecord(index, thread)?.pins ?? [];
  return [...PROTECTED_PATHS, MEMORY_INDEX_FILE, ...pins.map((pin) => `${THREAD_PINS_DIR}/${pin}`)];
}

function pinOf(snapshotPath: string): string | undefined {
  return snapshotPath.startsWith(`${THREAD_PINS_DIR}/`) ? snapshotPath.slice(THREAD_PINS_DIR.length + 1) : undefined;
}

export async function ensureActivePromptSnapshot(
  characterDataDir: string,
  workspace: CharacterWorkspace,
  thread = MAIN_THREAD,
): Promise<void> {
  await ensureCharacterWorkspace(workspace);
  const paths = await snapshotFiles(characterDataDir, thread);
  await Promise.all(paths.map(async (path) => { await copyPromptVisibleFile(characterDataDir, workspace, path, true, thread); }));
  writeCharacterState(characterDataDir, stateFile(thread, "active_prompt/.snapshot"), "1");
}

export async function refreshActivePromptSnapshot(
  characterDataDir: string,
  workspace: CharacterWorkspace,
  thread = MAIN_THREAD,
): Promise<void> {
  await ensureCharacterWorkspace(workspace);
  writeCharacterState(characterDataDir, stateFile(thread, "active_prompt/.snapshot"), "1");
  const paths = await snapshotFiles(characterDataDir, thread);
  await Promise.all(paths.map(async (path) => { await copyPromptVisibleFile(characterDataDir, workspace, path, false, thread); }));
}

export interface ThreadPin {
  pin: string;
  content: string | undefined;
}

export async function loadThreadPins(
  characterDataDir: string,
  workspace: CharacterWorkspace,
  thread: string,
  pins: readonly string[],
): Promise<ThreadPin[]> {
  const snapshot = await activePromptSnapshotExists(characterDataDir, thread);
  const contents = await Promise.all(pins.map(async (pin) => snapshot
    ? readCharacterState(characterDataDir, stateFile(thread, `active_prompt/${THREAD_PINS_DIR}/${pin}`))
    : await pinContent(characterDataDir, workspace, pin)));
  let room = MAX_THREAD_PINS_BYTES;
  return pins.map((pin, at) => {
    const content = contents[at];
    const fitted = content === undefined ? undefined : fitThreadPin(pin, content, room);
    room = fitted === content ? room - Buffer.byteLength(content ?? "", "utf8") : 0;
    return { pin, content: fitted };
  });
}

function fitThreadPin(pin: string, content: string, room: number): string {
  if (Buffer.byteLength(content, "utf8") <= room) return content;
  const together = `a thread's pins can be at most ${byteSize(MAX_THREAD_PINS_BYTES)} together`;
  const head = cutToBytes(content, room).trimEnd();
  const file = pinnedCommand(pin) === undefined;
  if (head === "") return file ? `(Left out: ${together}. \`read\` ${pin} to see it.)` : `(Left out: ${together}.)`;
  return file ? `${head}\n\n[Cut: ${together}; \`read\` ${pin} for the rest.]` : `${head}\n\n[Cut: ${together}.]`;
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
  workspace: CharacterWorkspace,
  thread?: string,
): Promise<void> {
  const selected = thread ?? await homeThreadIn(characterDataDir);
  if (await resetActivePromptSnapshotIfEmpty(characterDataDir, threadDirIn(characterDataDir, selected), selected)) return;
  await refreshActivePromptSnapshot(characterDataDir, workspace, selected);
  deleteCharacterState(characterDataDir, stateFile(selected, QUEUE_FILE));
}
