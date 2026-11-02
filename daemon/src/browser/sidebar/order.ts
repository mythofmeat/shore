import type { ThreadFolderView } from "../../protocol/ThreadFolderView.ts";
import type { ThreadView } from "../../protocol/ThreadView.ts";

export interface FolderSection { name: string; byActivity: boolean; threads: ThreadView[] }
export interface ThreadSections { pinned: ThreadView[]; loose: ThreadView[]; folders: FolderSection[] }

function rank(thread: ThreadView): number {
  return thread.home ? 2 : thread.heartbeat === true ? 1 : 0;
}

function recency(thread: ThreadView): string {
  return thread.last_active ?? thread.created_at;
}

function sectionOrder(a: ThreadView, b: ThreadView): number {
  if (a.position !== undefined && b.position !== undefined) return a.position - b.position;
  if (a.position !== undefined) return 1;
  if (b.position !== undefined) return -1;
  return recency(b).localeCompare(recency(a));
}

export function threadSections(threads: readonly ThreadView[], folders: readonly ThreadFolderView[] = []): ThreadSections {
  const named = new Set(folders.map((folder) => folder.name));
  const free = threads.filter((thread) => rank(thread) === 0);
  return {
    pinned: threads.filter((thread) => rank(thread) > 0).sort((a, b) => rank(b) - rank(a)),
    loose: free.filter((thread) => thread.folder === undefined || !named.has(thread.folder)).sort(sectionOrder),
    folders: folders.map((folder) => ({ name: folder.name, byActivity: folder.by_activity === true, threads: free.filter((thread) => thread.folder === folder.name).sort(sectionOrder) })),
  };
}

export function sortThreads(threads: readonly ThreadView[], folders: readonly ThreadFolderView[] = []): ThreadView[] {
  const sections = threadSections(threads, folders);
  return [...sections.pinned, ...sections.loose, ...sections.folders.flatMap((folder) => folder.threads)];
}

export function threadsOnScreen(threads: readonly ThreadView[], folders: readonly ThreadFolderView[], collapsed: ReadonlySet<string>, current: string | null): ThreadView[] {
  const sections = threadSections(threads, folders);
  return [...sections.pinned, ...sections.loose, ...sections.folders.flatMap((folder) => collapsed.has(folder.name) ? folder.threads.filter((thread) => thread.id === current) : folder.threads)];
}

export function moveInThreads(threads: readonly ThreadView[], folders: readonly ThreadFolderView[], id: string, move: { folder?: string; before?: string }): ThreadView[] {
  const moving = threads.find((thread) => thread.id === id);
  if (moving === undefined) return [...threads];
  const target = move.folder === undefined ? moving.folder : move.folder === "" ? undefined : move.folder;
  const sections = threadSections(threads, folders);
  const section = target === undefined ? sections.loose : sections.folders.find((folder) => folder.name === target)?.threads ?? [];
  const others = section.filter((thread) => thread.id !== id);
  const at = move.before === undefined ? -1 : others.findIndex((thread) => thread.id === move.before);
  const placed = at < 0 ? [...others, moving] : [...others.slice(0, at), moving, ...others.slice(at)];
  const positions = new Map(placed.map((thread, position) => [thread.id, position]));
  return threads.map((thread) => {
    const position = positions.get(thread.id);
    if (thread.id !== id && position === undefined) return thread;
    const { folder: _folder, ...rest } = thread;
    return { ...rest, ...(target === undefined ? {} : { folder: target }), ...(position === undefined ? {} : { position }) };
  });
}
