import type { ThreadFolderView } from "../../protocol/ThreadFolderView.ts";
import type { ThreadView } from "../../protocol/ThreadView.ts";

export interface FolderSection { name: string; byActivity: boolean; threads: ThreadView[] }
export interface ThreadSections { pinned: ThreadView[]; loose: ThreadView[]; folders: FolderSection[]; held: ThreadView[] }

export const HELD_GROUP = "\u0000on hold";

export function shownUnread(thread: ThreadView, open: string | null, focused: boolean): number {
  return thread.id === open && focused ? 0 : thread.unread ?? 0;
}

export function unreadIn(threads: readonly ThreadView[], open: string | null, focused: boolean): number {
  return threads.reduce((total, thread) => total + shownUnread(thread, open, focused), 0);
}

function pinned(thread: ThreadView): boolean {
  return thread.home;
}

function recency(thread: ThreadView): string {
  return thread.last_active ?? thread.created_at;
}

function sectionOrder(a: ThreadView, b: ThreadView): number {
  if (a.position !== undefined && b.position !== undefined) return a.position - b.position;
  if (a.position !== undefined || b.position !== undefined) return Number(a.position !== undefined) - Number(b.position !== undefined);
  return recency(b).localeCompare(recency(a));
}

export function threadSections(threads: readonly ThreadView[], folders: readonly ThreadFolderView[] = []): ThreadSections {
  const named = new Set(folders.map((folder) => folder.name));
  const held = threads.filter((thread) => thread.on_hold === true);
  const free = threads.filter((thread) => !pinned(thread) && thread.on_hold !== true);
  return {
    pinned: threads.filter(pinned),
    loose: free.filter((thread) => thread.folder === undefined || !named.has(thread.folder)).sort(sectionOrder),
    folders: folders.map((folder) => ({ name: folder.name, byActivity: folder.by_activity === true, threads: free.filter((thread) => thread.folder === folder.name).sort(sectionOrder) })),
    held: held.sort((a, b) => recency(b).localeCompare(recency(a))),
  };
}

export function sortThreads(threads: readonly ThreadView[], folders: readonly ThreadFolderView[] = []): ThreadView[] {
  const sections = threadSections(threads, folders);
  return [...sections.pinned, ...sections.loose, ...sections.folders.flatMap((folder) => folder.threads), ...sections.held];
}

export function threadsOnScreen(threads: readonly ThreadView[], folders: readonly ThreadFolderView[], collapsed: ReadonlySet<string>, current: string | null): ThreadView[] {
  const sections = threadSections(threads, folders);
  const shown = (name: string, group: readonly ThreadView[]) => collapsed.has(name) ? group.filter((thread) => thread.id === current) : group;
  return [...sections.pinned, ...sections.loose, ...sections.folders.flatMap((folder) => shown(folder.name, folder.threads)), ...shown(HELD_GROUP, sections.held)];
}

export function moveInThreads(threads: readonly ThreadView[], folders: readonly ThreadFolderView[], id: string, move: { folder?: string; before?: string }): ThreadView[] {
  const moving = threads.find((thread) => thread.id === id);
  if (moving === undefined) return [...threads];
  const target = move.folder === undefined ? moving.folder : move.folder === "" ? undefined : move.folder;
  const sections = threadSections(threads, folders);
  const section = target === undefined ? sections.loose : sections.folders.find((folder) => folder.name === target)?.threads ?? [];
  const others = section.filter((thread) => thread.id !== id);
  const at = move.before === undefined ? others.length : others.findIndex((thread) => thread.id === move.before);
  const placed = at < 0 ? [...others, moving] : [...others.slice(0, at), moving, ...others.slice(at)];
  const positions = new Map(placed.map((thread, position) => [thread.id, position]));
  return threads.map((thread) => {
    const position = positions.get(thread.id);
    if (thread.id !== id && position === undefined) return thread;
    const { folder: _folder, ...rest } = thread;
    return { ...rest, ...(target === undefined ? {} : { folder: target }), ...(position === undefined ? {} : { position }) };
  });
}
