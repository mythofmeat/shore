import { useSyncExternalStore } from "react";
import { BrowserConnection } from "../connection.ts";
import { CompactionWatch, type PassRecord } from "../chat/compaction_watch.ts";
import { ConversationRequests, type ConversationScope } from "../chat/requests.ts";
import { ReadMarks } from "../chat/read_marks.ts";
import { conversationCharacter, droppedNotice } from "../chat/sending.ts";
import { UnsentMessages } from "../chat/unsent.ts";
import { Notifier, type NotifySnapshot } from "../notifications.ts";
import { DisplayPreferences, type ViewValues } from "../preferences.ts";
import { listRequests } from "../request_history.ts";
import { FontSizeStore, type FontSizeId } from "../font_size.ts";
import { ThemeStore, type ThemeId } from "../theme.ts";
import { toasts } from "../ui/toast.tsx";
import { Workspace, type WorkspaceSnapshot } from "../workspace.ts";

declare const SHORE_WEB_CONTRACT: string;
declare const SHORE_WEB_PROTOCOL: number;

const route = location.pathname.startsWith("/workspace/") ? location.pathname.slice("/workspace/".length).split("/").map(decodeURIComponent) : [];

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> {
  try { const storage = localStorage; storage.getItem("shore.probe"); return storage; } catch { return memoryStorage(); }
}

export const workspace = new Workspace(new BrowserConnection({
  origin: location.origin, contract: SHORE_WEB_CONTRACT, protocol: SHORE_WEB_PROTOCOL, character: route[0] || null, thread: route[1] || null,
}), (callback) => { requestAnimationFrame(callback); });
export const conversation = new ConversationRequests(workspace.connection);
export const readMarks = new ReadMarks(workspace, () => document.hasFocus());
export const unsent = new UnsentMessages(workspace.connection, listRequests, (message, dropped) => {
  const character = conversationCharacter(message.conversation);
  toasts.show(`Your earlier message${character === undefined ? "" : ` to ${character}`} wasn’t saved, so it’s back in its message box.${droppedNotice(dropped)}`, "error");
});
export const themes = new ThemeStore();
export const fontSizes = new FontSizeStore();
export const display = new DisplayPreferences(browserStorage());
export const notifier = new Notifier({ storage: browserStorage() });
workspace.connection.subscribe((update) => { notifier.observe(update, workspace.getSnapshot()); });
addEventListener("storage", () => { themes.reload(); fontSizes.reload(); display.reload(); notifier.reload(); });
addEventListener("focus", () => { notifier.markRead(); });

export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(themes.subscribe, themes.getSnapshot);
}

export function useFontSize(): FontSizeId {
  return useSyncExternalStore(fontSizes.subscribe, fontSizes.getSnapshot);
}

export function useNotifications(): NotifySnapshot {
  return useSyncExternalStore(notifier.subscribe, notifier.getSnapshot);
}

export function useDisplay(): ViewValues {
  return useSyncExternalStore(display.subscribe, display.getSnapshot).values;
}

export function useActiveRequests(): ReadonlySet<string> {
  return useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
}

export function useConversationActive(scope: ConversationScope): boolean {
  useActiveRequests();
  return conversation.activeIn(scope);
}

export const compactionWatch = new CompactionWatch({
  watch: async (observe) => await workspace.actions.run("compact_watch", {}, { observe }),
  stop: async () => await workspace.actions.run("compact_cancel", {}),
}, (callback) => { requestAnimationFrame(callback); });
workspace.connection.subscribe((update) => { if (update.kind === "status" && update.status === "ready") compactionWatch.reconnected(); });

export function useCompactionRecord(): PassRecord | null {
  return useSyncExternalStore(compactionWatch.subscribe, compactionWatch.getSnapshot);
}

export const STREAM_KEY = "shore.stream";

export function streamReplies(): boolean {
  try { return localStorage.getItem(STREAM_KEY) !== "false"; } catch { return true; }
}

export const ENTER_SENDS_KEY = "shore.enter-sends";

export function enterSends(): boolean {
  try { return localStorage.getItem(ENTER_SENDS_KEY) !== "false"; } catch { return true; }
}

export const VIM_MODE_KEY = "shore.vim-mode";

const COLLAPSED_FOLDERS_KEY = "shore.folders.collapsed";

class CollapsedFolders {
  readonly #listeners = new Set<() => void>();
  #raw: string | null = null;
  #all: Record<string, string[]> = {};
  #sets = new Map<string, ReadonlySet<string>>();
  constructor(readonly storage: Pick<Storage, "getItem" | "setItem">) { this.reload(); }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  reload(): void {
    const raw = this.storage.getItem(COLLAPSED_FOLDERS_KEY);
    if (raw === this.#raw) return;
    this.#raw = raw;
    try { const parsed: unknown = JSON.parse(raw ?? "{}"); this.#all = typeof parsed === "object" && parsed !== null ? parsed as Record<string, string[]> : {}; } catch { this.#all = {}; }
    this.#sets.clear();
    for (const listener of this.#listeners) listener();
  }
  of = (character: string | null): ReadonlySet<string> => {
    const key = character ?? "";
    const known = this.#sets.get(key);
    if (known !== undefined) return known;
    const set = new Set(Array.isArray(this.#all[key]) ? this.#all[key] : []);
    this.#sets.set(key, set);
    return set;
  };
  toggle(character: string, folder: string): void {
    const next = new Set(this.of(character));
    if (!next.delete(folder)) next.add(folder);
    this.#all = { ...this.#all, [character]: [...next] };
    this.#raw = JSON.stringify(this.#all);
    try { this.storage.setItem(COLLAPSED_FOLDERS_KEY, this.#raw); } catch { void 0; }
    this.#sets.set(character, next);
    for (const listener of this.#listeners) listener();
  }
}

export const collapsedFolders = new CollapsedFolders(browserStorage());
addEventListener("storage", () => { collapsedFolders.reload(); });

export function useCollapsedFolders(character: string | null): ReadonlySet<string> {
  return useSyncExternalStore(collapsedFolders.subscribe, () => collapsedFolders.of(character));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function perform(work: () => Promise<unknown>): void {
  void work().catch((error: unknown) => { workspace.report(error); });
}
