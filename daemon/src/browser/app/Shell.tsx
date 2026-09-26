import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import { Chat } from "../chat/Chat.tsx";
import { Settings } from "../settings/Settings.tsx";
import { NewCharacterDialog, NewThreadDialog } from "../sidebar/dialogs.tsx";
import { Toasts, toasts } from "../ui/toast.tsx";
import { useEscape, useMediaQuery, useStoredFlag } from "../ui/hooks.ts";
import { Palette } from "./Palette.tsx";
import { navigate, useRoute } from "./route.ts";
import { adjacent, globalAction } from "./shortcuts.ts";
import { perform, useNotifications, workspace } from "./state.ts";

export function Shell({ state }: { state: WorkspaceSnapshot }) {
  const route = useRoute();
  const mobile = useMediaQuery("(max-width: 860px)");
  const [expanded, setExpanded] = useStoredFlag("shore.sidebar", true);
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<"character" | "thread" | "palette" | null>(null);
  const { unread } = useNotifications();
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
  }, [route.view, state.character, unread]);
  const toggle = () => { if (mobile) setDrawer(!drawer); else setExpanded(!expanded); };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]") !== null) return;
      const typing = event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']") !== null;
      const action = globalAction(event, typing);
      if (action === undefined) return;
      event.preventDefault();
      switch (action) {
        case "palette": setDialog("palette"); break;
        case "focus": navigate({ view: "chat" }); requestAnimationFrame(() => document.getElementById("message-composer")?.focus()); break;
        case "new-thread": if (state.character !== null && state.status === "ready") setDialog("thread"); break;
        case "sidebar": toggle(); break;
        case "settings": navigate({ view: "settings", page: "models" }); break;
        case "help": navigate({ view: "settings", page: "keyboard" }); break;
        case "previous-thread": case "next-thread": {
          const ids = state.threads.map((thread) => thread.id);
          const next = adjacent(ids, state.thread ?? undefined, action === "next-thread" ? 1 : -1);
          if (next !== undefined && next !== state.thread && state.status === "ready") perform(() => workspace.actions.run("switch_thread", { name: next, resync: true }));
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
    <Toasts />
  </div>;
}
