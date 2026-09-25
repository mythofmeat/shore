import { useSyncExternalStore } from "react";
import { BrowserConnection } from "../connection.ts";
import { ConversationRequests } from "../chat/requests.ts";
import { DisplayPreferences, type ViewValues } from "../preferences.ts";
import { ThemeStore, type ThemeId } from "../theme.ts";
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
}));
export const conversation = new ConversationRequests(workspace.connection);
export const themes = new ThemeStore();
export const display = new DisplayPreferences(browserStorage());
addEventListener("storage", () => { themes.reload(); display.reload(); });

export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(themes.subscribe, themes.getSnapshot);
}

export function useDisplay(): ViewValues {
  return useSyncExternalStore(display.subscribe, display.getSnapshot).values;
}

export function useActiveRequests(): ReadonlySet<string> {
  return useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
}

export function useConversationActive(): boolean {
  return useActiveRequests().size > 0;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function perform(work: () => Promise<unknown>): void {
  void work().catch((error: unknown) => { workspace.report(error); });
}
