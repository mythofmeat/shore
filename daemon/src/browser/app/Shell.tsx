import { useCallback, useEffect, useState } from "react";
import type { ChromeSnapshot } from "../workspace.ts";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import { sortThreads, threadsOnScreen } from "../sidebar/order.ts";
import { Chat } from "../chat/Chat.tsx";
import { Settings } from "../settings/Settings.tsx";
import { NewCharacterDialog, NewThreadDialog } from "../sidebar/dialogs.tsx";
import { Toasts, toasts } from "../ui/toast.tsx";
import { useEscape, useMediaQuery, useStoredFlag } from "../ui/hooks.ts";
import { CompactionDialog } from "../chat/CompactionView.tsx";
import { FolderDialogs, ThreadDialogs } from "../chat/thread_dialogs.tsx";
import { COMPACTION_VIEW_EVENT, FOLDER_DIALOG_EVENT, THREAD_DIALOG_EVENT, type FolderDialogRequest, type ThreadDialogRequest } from "./intents.ts";
import { Palette } from "./Palette.tsx";
import { navigate, openSettings, useRoute } from "./route.ts";
import { adjacent, globalAction, nextUnread } from "./shortcuts.ts";
import { perform, SIDEBAR_KEY, useCollapsedFolders, useNotifications, workspace } from "./state.ts";

export function Shell({ state }: { state: ChromeSnapshot }) {
  const route = useRoute();
  const mobile = useMediaQuery("(max-width: 860px)");
  const [expanded, setExpanded] = useStoredFlag(SIDEBAR_KEY, true);
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<"character" | "thread" | "palette" | null>(null);
  const [threadDialog, setThreadDialog] = useState<ThreadDialogRequest | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogRequest | null>(null);
  const [compactionView, setCompactionView] = useState(false);
  const collapsed = useCollapsedFolders(state.character);
  const { unread } = useNotifications();
  useEffect(() => {
    const open = (event: Event) => { setThreadDialog((event as CustomEvent<ThreadDialogRequest>).detail); };
    const openFolder = (event: Event) => { setFolderDialog((event as CustomEvent<FolderDialogRequest>).detail); };
    addEventListener(THREAD_DIALOG_EVENT, open);
    const openCompaction = () => { setCompactionView(true); };
    addEventListener(FOLDER_DIALOG_EVENT, openFolder);
    addEventListener(COMPACTION_VIEW_EVENT, openCompaction);
    return () => { removeEventListener(THREAD_DIALOG_EVENT, open); removeEventListener(FOLDER_DIALOG_EVENT, openFolder); removeEventListener(COMPACTION_VIEW_EVENT, openCompaction); };
  }, []);
  const open = mobile ? drawer : expanded;
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useEscape(mobile && drawer, closeDrawer);
  useEffect(() => { if (!mobile) setDrawer(false); }, [mobile]);
  useEffect(() => { setDrawer(false); }, [state.character, state.thread]);
  useEffect(() => {
    if (state.error === "") return;
    toasts.show(state.error, "error");
    workspace.dismissError();
  }, [state.error]);
  useEffect(() => {
    if (state.character === null) return;
    const path = `/workspace/${encodeURIComponent(state.character)}/${encodeURIComponent(state.thread ?? "main")}`;
    if (location.pathname !== path) history.replaceState(history.state, "", path + location.hash);
  }, [state.character, state.thread]);
  useEffect(() => {
    const title = route.view === "settings" ? "Settings · Shore" : state.character === null ? "Shore" : `${state.character} · Shore`;
    document.title = unread > 0 ? `(${String(unread)}) ${title}` : title;
    return () => { document.title = "Shore"; };
  }, [route.view, state.character, unread]);
  const toggle = () => { if (mobile) setDrawer(!drawer); else setExpanded(!expanded); };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]") !== null) return;
      const target = event.composedPath()[0];
      const typing = target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null;
      const action = globalAction(event, typing);
      if (action === undefined) return;
      event.preventDefault();
      switch (action) {
        case "palette": setDialog("palette"); break;
        case "focus": navigate({ view: "chat" }); requestAnimationFrame(() => document.getElementById("message-composer")?.focus()); break;
        case "new-thread": if (state.character !== null && state.status === "ready") setDialog("thread"); break;
        case "sidebar": toggle(); break;
        case "settings": openSettings(); break;
        case "help": navigate({ view: "settings", page: "keyboard" }); break;
        case "previous-thread": case "next-thread": {
          const from = state.opening?.thread ?? state.thread;
          const ids = threadsOnScreen(state.threads, state.folders, collapsed, from).map((thread) => thread.id);
          const next = adjacent(ids, from ?? undefined, action === "next-thread" ? 1 : -1);
          if (next !== undefined && next !== from && state.status === "ready") perform(() => workspace.openThread(next));
          break;
        }
        case "next-unread-thread": {
          const next = nextUnread(sortThreads(state.threads, state.folders), state.opening?.thread ?? state.thread);
          if (next === undefined) toasts.show("No unread messages in other threads");
          else if (state.status === "ready") perform(() => workspace.openThread(next));
          break;
        }
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  });
  return <div className="shell" data-sidebar={open ? "open" : "closed"} data-layout={mobile ? "mobile" : "desktop"}>
    {mobile && drawer ? <button type="button" className="scrim" aria-label="Close sidebar" tabIndex={-1} onClick={closeDrawer} /> : null}
    {open ? <Sidebar state={state} mobile={mobile} close={closeDrawer} collapse={() => setExpanded(false)} newCharacter={() => setDialog("character")} newThread={() => setDialog("thread")} /> : null}
    <div className="main">
      {route.view === "settings" ? <Settings state={state} page={route.page} sidebarOpen={open} toggleSidebar={toggle} /> : <Chat state={state} sidebarOpen={open} toggleSidebar={toggle} mobile={mobile} />}
    </div>
    {dialog === "character" ? <NewCharacterDialog close={() => setDialog(null)} /> : null}
    {dialog === "thread" && state.character !== null ? <NewThreadDialog character={state.character} close={() => setDialog(null)} /> : null}
    {dialog === "palette" ? <Palette state={state} close={() => setDialog(null)} newThread={() => setDialog("thread")} newCharacter={() => setDialog("character")} /> : null}
    {threadDialog === null ? null : <ThreadDialogs state={state} request={threadDialog} close={() => setThreadDialog(null)} />}
    {folderDialog === null ? null : <FolderDialogs request={folderDialog} close={() => setFolderDialog(null)} />}
    {compactionView && state.character !== null ? <CompactionDialog state={state} close={() => setCompactionView(false)} /> : null}
    <Toasts />
  </div>;
}
