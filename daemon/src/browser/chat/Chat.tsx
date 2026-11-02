import { useEffect, useLayoutEffect, useState } from "react";
import { CONVERSATION_DIALOG_EVENT, openCompactionView, openThreadDialog } from "../app/intents.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import { Avatar } from "../ui/avatar.tsx";
import { IconButton, Menu, type MenuItem } from "../ui/controls.tsx";
import { ConnectionBanner } from "../app/banner.tsx";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { readMarks, useConversationActive, useWorkspaceValue, workspace } from "../app/state.ts";
import { makeHome } from "./actions.ts";
import { BudgetChip } from "./budget.tsx";
import { CompactionChip } from "./CompactionView.tsx";
import { GalleryDialog } from "./gallery.tsx";
import { Composer } from "./Composer.tsx";
import { ConversationDialogs, type ConversationDialog } from "./dialogs.tsx";
import { QuoteButton } from "./QuoteButton.tsx";
import { Transcript } from "./Transcript.tsx";

export function unreadElsewhere(state: Pick<ChromeSnapshot, "threads" | "thread">): boolean {
  return state.threads.some((thread) => thread.id !== state.thread && (thread.unread ?? 0) > 0);
}

function SidebarToggle({ open, mobile, toggle, unread }: { open: boolean; mobile: boolean; toggle: () => void; unread: boolean }) {
  if (open) return null;
  const label = mobile ? "Open sidebar" : "Expand sidebar";
  return <span className="sidebar-toggle">
    <IconButton icon={mobile ? "menu" : "panel"} label={unread ? `${label} (unread messages in another thread)` : label} onClick={toggle} />
    {unread ? <span className="unread-dot" aria-hidden="true" /> : null}
  </span>;
}

function ChatTopbar({ state, sidebarOpen, toggleSidebar, mobile }: { state: ChromeSnapshot; sidebarOpen: boolean; toggleSidebar: () => void; mobile: boolean }) {
  const [dialog, setDialog] = useState<ConversationDialog | "gallery" | null>(null);
  useEffect(() => {
    const open = (event: Event) => { const name = (event as CustomEvent<string>).detail; if (["guidance", "system", "compact", "clear", "gallery"].includes(name)) setDialog(name as ConversationDialog | "gallery"); };
    addEventListener(CONVERSATION_DIALOG_EVENT, open);
    return () => removeEventListener(CONVERSATION_DIALOG_EVENT, open);
  }, []);
  useLayoutEffect(() => { setDialog(null); }, [state.character, state.thread]);
  const busy = useConversationActive({ character: state.character, thread: state.thread });
  const hasTurns = useWorkspaceValue((live) => live.messages.some((message) => message.role !== "system"));
  const character = state.characters.find((item) => item.name === state.character);
  const thread = state.threads.find((item) => item.id === state.thread);
  const openingThread = state.opening?.thread === null || state.opening === null ? undefined : state.threads.find((item) => item.id === state.opening?.thread);
  const shownThread = openingThread ?? thread;
  const ready = state.status === "ready";
  const threadId = thread?.id ?? state.thread ?? "";
  const items: MenuItem[] = [
    { label: "Thread settings…", icon: "settings", onSelect: () => openThreadDialog("settings", threadId), disabled: !ready },
    { label: "Images…", icon: "image", onSelect: () => setDialog("gallery") },
    state.compaction === null
      ? { label: "Compact context…", icon: "compact", onSelect: () => setDialog("compact"), disabled: !ready || busy }
      : { label: "Show the compaction…", icon: "compact", onSelect: openCompactionView },
    { label: "Fork…", icon: "branch", onSelect: () => openThreadDialog("fork", threadId), disabled: !ready },
    "separator",
    { label: "Regenerate with guidance…", icon: "regenerate", onSelect: () => setDialog("guidance"), disabled: !ready || busy || !hasTurns },
    { label: "Clear context…", icon: "refresh", onSelect: () => setDialog("clear"), disabled: !ready || busy },
    "separator",
    ...(thread === undefined || thread.home || thread.heartbeat === true ? [] : [{ label: "Make home", icon: "home" as const, onSelect: () => { void makeHome(thread); }, disabled: !ready }]),
    { label: "Archive…", icon: "archive", onSelect: () => openThreadDialog("archive", threadId), disabled: !ready || thread?.home === true, danger: true },
  ];
  return <header className="topbar">
    <SidebarToggle open={sidebarOpen} mobile={mobile} toggle={toggleSidebar} unread={unreadElsewhere(state)} />
    {state.character === null ? <div className="topbar-title"><span className="topbar-name">Shore</span></div> : <>
      <Avatar name={state.character} avatar={character?.avatar} size={30} />
      <div className="topbar-title">
        <span className="topbar-name">{state.opening?.character ?? state.character}</span>
        {state.thread === null || (state.opening !== null && state.opening.thread === null) ? null : <><span className="topbar-separator">/</span><button type="button" className="topbar-thread" title="Thread settings" aria-label={`${shownThread === undefined ? state.thread : threadLabel(shownThread)}. Thread settings`} disabled={!ready || state.opening !== null} onClick={() => openThreadDialog("settings", threadId)}>{shownThread === undefined ? state.thread : threadLabel(shownThread)}</button></>}
      </div>
      <CompactionChip state={state} open={openCompactionView} />
      {mobile ? null : <BudgetChip state={state} />}
      <Menu label="Thread options" items={items} />
    </>}
    {dialog === "gallery" ? <GalleryDialog close={() => setDialog(null)} /> : dialog === null ? null : <ConversationDialogs dialog={dialog} state={state} close={() => setDialog(null)} />}
  </header>;
}

function NoCharacter({ state }: { state: ChromeSnapshot }) {
  return <div className="empty">
    <p className="empty-title">{state.characters.length === 0 ? "No characters yet" : "Choose a character"}</p>
    <p className="empty-text">{state.characters.length === 0 ? "Create a character with the + button in the sidebar." : "Pick a character in the sidebar to open their threads."}</p>
  </div>;
}

export function Chat({ state, sidebarOpen, toggleSidebar, mobile }: { state: ChromeSnapshot; sidebarOpen: boolean; toggleSidebar: () => void; mobile: boolean }) {
  useEffect(() => {
    readMarks.check();
    const unsubscribe = workspace.subscribe(readMarks.check);
    addEventListener("focus", readMarks.check);
    document.addEventListener("visibilitychange", readMarks.check);
    return () => {
      unsubscribe();
      removeEventListener("focus", readMarks.check);
      document.removeEventListener("visibilitychange", readMarks.check);
    };
  }, []);
  return <>
    <ChatTopbar state={state} sidebarOpen={sidebarOpen} toggleSidebar={toggleSidebar} mobile={mobile} />
    <ConnectionBanner state={state} />
    {state.character === null ? <NoCharacter state={state} /> : <>
      <Transcript key={`${state.character}/${state.thread ?? ""}/${String(state.segmentView?.segment.index ?? "current")}`} character={state.character} mobile={mobile} />
      {state.threads.find((thread) => thread.id === state.thread)?.heartbeat === true
        ? <div className="composer-wrap"><p className="composer composer-note" role="note">{`${state.character}'s heartbeats run here. You can read along, and write to ${state.character} in another thread.`}</p></div>
        : <Composer key={JSON.stringify([state.character, state.thread])} state={state} character={state.character} mobile={mobile} />}
      <QuoteButton />
    </>}
  </>;
}
