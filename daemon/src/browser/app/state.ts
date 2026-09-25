import { useSyncExternalStore } from "react";
import { BrowserConnection } from "../connection.ts";
import { ThemeStore, type ThemeId } from "../theme.ts";
import { Workspace, type WorkspaceSnapshot } from "../workspace.ts";

declare const SHORE_WEB_CONTRACT: string;
declare const SHORE_WEB_PROTOCOL: number;

const route = location.pathname.startsWith("/workspace/") ? location.pathname.slice("/workspace/".length).split("/").map(decodeURIComponent) : [];

export const workspace = new Workspace(new BrowserConnection({
  origin: location.origin, contract: SHORE_WEB_CONTRACT, protocol: SHORE_WEB_PROTOCOL, character: route[0] || null, thread: route[1] || null,
}));
export const themes = new ThemeStore();
addEventListener("storage", () => { themes.reload(); });

export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(themes.subscribe, themes.getSnapshot);
}

export function perform(work: () => Promise<unknown>): void {
  void work().catch((error: unknown) => { workspace.report(error); });
}
