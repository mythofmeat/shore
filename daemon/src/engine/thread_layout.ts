import type { ThreadFolder, ThreadRecord, ThreadsIndex } from "./threads.ts";
import { ownThread, homeThread, ThreadError } from "./threads.ts";

export const MAX_FOLDER_NAME_LENGTH = 64;

export interface PlacedThread {
  record: ThreadRecord;
  folder?: string;
  position?: number;
}

export interface ThreadMove {
  folder?: string;
  before?: string;
}

function folderList(index: ThreadsIndex): ThreadFolder[] {
  return Array.isArray(index.folders) ? index.folders : [];
}

function newestFirst(activity: (id: string) => string | undefined): (a: ThreadRecord, b: ThreadRecord) => number {
  return (a, b) => (activity(b.id) ?? b.created_at).localeCompare(activity(a.id) ?? a.created_at);
}

function pinnedThreads(index: ThreadsIndex): string[] {
  const heartbeat = ownThread(index);
  return [homeThread(index), ...(heartbeat === undefined ? [] : [heartbeat])];
}

function placed(records: readonly ThreadRecord[], folder: string | undefined, manual: boolean): PlacedThread[] {
  return records.map((record, position) => ({ record, ...(folder === undefined ? {} : { folder }), ...(manual ? { position } : {}) }));
}

export function placedThreads(index: ThreadsIndex, activity: (id: string) => string | undefined): PlacedThread[] {
  const byId = new Map(index.threads.map((record) => [record.id, record]));
  const pinned = pinnedThreads(index);
  const taken = new Set(pinned);
  const folders = folderList(index).map((folder) => {
    const records = folder.threads.flatMap((id) => {
      const record = byId.get(id);
      if (record === undefined || taken.has(id)) return [];
      taken.add(id);
      return [record];
    });
    return { name: folder.name, byActivity: folder.by_activity === true, records };
  });
  const loose = index.threads.filter((record) => !taken.has(record.id));
  const recent = newestFirst(activity);
  const order = Array.isArray(index.order) ? index.order : undefined;
  const looseRecords = order === undefined
    ? [...loose].sort(recent)
    : [
        ...loose.filter((record) => !order.includes(record.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)),
        ...order.flatMap((id) => { const record = loose.find((item) => item.id === id); return record === undefined ? [] : [record]; }),
      ];
  return [
    ...pinned.flatMap((id) => { const record = byId.get(id); return record === undefined ? [] : [{ record }]; }),
    ...placed(looseRecords, undefined, order !== undefined),
    ...folders.flatMap((folder) => folder.byActivity
      ? placed([...folder.records].sort(recent), folder.name, false)
      : placed(folder.records, folder.name, true)),
  ];
}

function requireFolder(index: ThreadsIndex, character: string, name: string): ThreadFolder {
  const folder = folderList(index).find((item) => item.name === name);
  if (folder === undefined) throw new ThreadError("not_found", `no thread folder ${JSON.stringify(name)} for ${character}`);
  return folder;
}

function withFolders(index: ThreadsIndex, folders: ThreadFolder[]): ThreadsIndex {
  const { folders: _replaced, ...rest } = index;
  return folders.length === 0 ? rest : { ...rest, folders };
}

function placedBefore<T>(items: readonly T[], item: T, before: T | undefined): T[] {
  const rest = items.filter((other) => other !== item);
  const at = before === undefined ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)];
}

function looseOnScreen(index: ThreadsIndex, activity: (id: string) => string | undefined): string[] {
  return placedThreads(index, activity).filter((item) => item.folder === undefined && !pinnedThreads(index).includes(item.record.id)).map((item) => item.record.id);
}

export function moveThread(index: ThreadsIndex, character: string, id: string, move: ThreadMove, activity: (id: string) => string | undefined): ThreadsIndex {
  if (!index.threads.some((record) => record.id === id)) throw new ThreadError("not_found", `no thread ${JSON.stringify(id)} for ${character}`);
  if (pinnedThreads(index).includes(id)) throw new ThreadError("is_pinned", `thread ${JSON.stringify(id)} is the home or own-time thread, and those stay at the top of the list`);
  const current = folderList(index).find((folder) => folder.threads.includes(id))?.name;
  const target = move.folder === undefined ? current : move.folder === "" ? undefined : requireFolder(index, character, move.folder).name;
  const onScreen = looseOnScreen(index, activity);
  const folders = folderList(index).map((folder) => {
    if (folder.name === target) return { ...folder, threads: placedBefore(folder.threads, id, move.before) };
    return folder.threads.includes(id) ? { ...folder, threads: folder.threads.filter((other) => other !== id) } : folder;
  });
  const next = withFolders(index, folders);
  if (target !== undefined) {
    return index.order === undefined ? next : { ...next, order: onScreen.filter((other) => other !== id) };
  }
  const handPlaced = index.order !== undefined || move.before !== undefined || current === undefined;
  return handPlaced ? { ...next, order: placedBefore(onScreen, id, move.before) } : next;
}

export function setThreadsSort(index: ThreadsIndex, byActivity: boolean, activity: (id: string) => string | undefined): ThreadsIndex {
  if (byActivity) {
    const { order: _dropped, ...rest } = index;
    return rest;
  }
  return { ...index, order: looseOnScreen(index, activity) };
}

export function cleanFolderName(raw: string): string {
  const name = raw.trim();
  if (name === "") throw new ThreadError("invalid_folder", "a folder needs a name");
  if (name.length > MAX_FOLDER_NAME_LENGTH) throw new ThreadError("invalid_folder", `a folder name can be at most ${String(MAX_FOLDER_NAME_LENGTH)} characters`);
  if (/\p{Cc}/u.test(name)) throw new ThreadError("invalid_folder", "a folder name can't contain control characters");
  return name;
}

function requireFreeName(index: ThreadsIndex, name: string, except?: string): void {
  if (folderList(index).some((folder) => folder.name !== except && folder.name.toLowerCase() === name.toLowerCase())) {
    throw new ThreadError("exists", `there is already a thread folder called ${JSON.stringify(name)}`);
  }
}

export function folderOf(index: ThreadsIndex, id: string): string | undefined {
  return folderList(index).find((folder) => folder.threads.includes(id))?.name;
}

export function placeInFolder(index: ThreadsIndex, character: string, id: string, raw: string): ThreadsIndex {
  const name = cleanFolderName(raw);
  const there = folderList(index).find((folder) => folder.name.toLowerCase() === name.toLowerCase());
  return moveThread(there === undefined ? createFolder(index, name) : index, character, id, { folder: there?.name ?? name }, () => undefined);
}

export function createFolder(index: ThreadsIndex, raw: string): ThreadsIndex {
  const name = cleanFolderName(raw);
  requireFreeName(index, name);
  return withFolders(index, [...folderList(index), { name, threads: [] }]);
}

export function renameFolder(index: ThreadsIndex, character: string, name: string, raw: string): ThreadsIndex {
  requireFolder(index, character, name);
  const to = cleanFolderName(raw);
  requireFreeName(index, to, name);
  return withFolders(index, folderList(index).map((folder) => folder.name === name ? { ...folder, name: to } : folder));
}

export function deleteFolder(index: ThreadsIndex, character: string, name: string): ThreadsIndex {
  const folder = requireFolder(index, character, name);
  const next = withFolders(index, folderList(index).filter((item) => item.name !== name));
  return index.order === undefined ? next : { ...next, order: [...folder.threads, ...index.order.filter((id) => !folder.threads.includes(id))] };
}

export function moveFolder(index: ThreadsIndex, character: string, name: string, before: string | undefined): ThreadsIndex {
  const folder = requireFolder(index, character, name);
  if (before !== undefined) requireFolder(index, character, before);
  const others = folderList(index);
  const target = before === undefined ? undefined : others.find((item) => item.name === before);
  return withFolders(index, placedBefore(others, folder, target));
}

export function setFolderSort(index: ThreadsIndex, character: string, name: string, byActivity: boolean): ThreadsIndex {
  requireFolder(index, character, name);
  return withFolders(index, folderList(index).map((folder) => {
    if (folder.name !== name) return folder;
    const { by_activity: _dropped, ...rest } = folder;
    return byActivity ? { ...rest, by_activity: true as const } : rest;
  }));
}
