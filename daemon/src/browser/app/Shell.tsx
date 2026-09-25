import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import { Chat } from "../chat/Chat.tsx";
import { Settings } from "../settings/Settings.tsx";
import { NewCharacterDialog, NewThreadDialog } from "../sidebar/dialogs.tsx";
import { Toasts, toasts } from "../ui/toast.tsx";
import { useEscape, useMediaQuery, useStoredFlag } from "../ui/hooks.ts";
import { useRoute } from "./route.ts";
import { workspace } from "./state.ts";

export function Shell({ state }: { state: WorkspaceSnapshot }) {
  const route = useRoute();
  const mobile = useMediaQuery("(max-width: 860px)");
  const [expanded, setExpanded] = useStoredFlag("shore.sidebar", true);
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<"character" | "thread" | null>(null);
  const open = mobile ? drawer : expanded;
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useEscape(mobile && drawer, closeDrawer);
  useEffect(() => { if (!mobile) setDrawer(false); }, [mobile]);
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
    document.title = route.view === "settings" ? "Settings · Shore" : state.character === null ? "Shore" : `${state.character} · Shore`;
  }, [route.view, state.character]);
  const toggle = () => { if (mobile) setDrawer(!drawer); else setExpanded(!expanded); };
  return <div className="shell" data-sidebar={open ? "open" : "closed"} data-layout={mobile ? "mobile" : "desktop"}>
    {mobile && drawer ? <button type="button" className="scrim" aria-label="Close sidebar" tabIndex={-1} onClick={closeDrawer} /> : null}
    {open ? <Sidebar state={state} mobile={mobile} close={closeDrawer} collapse={() => setExpanded(false)} newCharacter={() => setDialog("character")} newThread={() => setDialog("thread")} /> : null}
    <div className="main">
      {route.view === "settings" ? <Settings state={state} page={route.page} sidebarOpen={open} toggleSidebar={toggle} /> : <Chat state={state} sidebarOpen={open} toggleSidebar={toggle} mobile={mobile} />}
    </div>
    {dialog === "character" ? <NewCharacterDialog close={() => setDialog(null)} /> : null}
    {dialog === "thread" && state.character !== null ? <NewThreadDialog character={state.character} close={() => setDialog(null)} /> : null}
    <Toasts />
  </div>;
}
