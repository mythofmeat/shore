import { useEffect, useLayoutEffect, useState } from "react";
import { CONVERSATION_DIALOG_EVENT, openCompactionView, openThreadDialog } from "../app/intents.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Avatar } from "../ui/avatar.tsx";
import { IconButton, Menu, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { ConnectionBanner } from "../app/banner.tsx";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { readMarks, useConversationActive, workspace } from "../app/state.ts";
import { makeHome } from "./actions.ts";
import { BudgetChip } from "./budget.tsx";
import { CompactionChip } from "./CompactionView.tsx";
import { GalleryDialog } from "./gallery.tsx";
import { Composer } from "./Composer.tsx";
import { ConversationDialogs, type ConversationDialog } from "./dialogs.tsx";
import { ModelPicker, shortModel, useModelListing, usePendingModel } from "./models.tsx";
import { QuoteButton } from "./QuoteButton.tsx";
import { Transcript } from "./Transcript.tsx";

export function unreadElsewhere(state: Pick<WorkspaceSnapshot, "threads" | "thread">): boolean {
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

function ChatTopbar({ state, sidebarOpen, toggleSidebar, mobile }: { state: WorkspaceSnapshot; sidebarOpen: boolean; toggleSidebar: () => void; mobile: boolean }) {
  const [dialog, setDialog] = useState<ConversationDialog | "model" | "gallery" | null>(null);
  const { listing, reload } = useModelListing(state);
  const pendingModel = usePendingModel(state);
  const shownModel = pendingModel === undefined ? listing?.active : pendingModel.model ?? listing?.active;
  const modelChanged = async () => { workspace.noteActiveModel((await reload()).active ?? null); };
  useEffect(() => {
    const open = (event: Event) => { const name = (event as CustomEvent<string>).detail; if (["guidance", "system", "compact", "clear", "model", "gallery"].includes(name)) setDialog(name as ConversationDialog | "model" | "gallery"); };
    addEventListener(CONVERSATION_DIALOG_EVENT, open);
    return () => removeEventListener(CONVERSATION_DIALOG_EVENT, open);
  }, []);
  useLayoutEffect(() => { setDialog(null); }, [state.character, state.thread]);
  const busy = useConversationActive({ character: state.character, thread: state.thread });
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
    { label: "Regenerate with guidance…", icon: "regenerate", onSelect: () => setDialog("guidance"), disabled: !ready || busy || !state.messages.some((message) => message.role !== "system") },
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
        {state.thread === null || (state.opening !== null && state.opening.thread === null) ? null : <><span className="topbar-separator">/</span><span className="topbar-thread">{shownThread === undefined ? state.thread : threadLabel(shownThread)}</span></>}
      </div>
      <CompactionChip state={state} open={openCompactionView} />
      {mobile ? null : <BudgetChip state={state} />}
      {mobile ? null : <button type="button" className={`model-chip ${pendingModel === undefined ? "" : "pending"}`} aria-label={`Chat model: ${shownModel ?? "unknown"}${pendingModel === undefined ? "" : ", saving"}. Change model`} title="Change model" disabled={!ready} onClick={() => setDialog("model")}>
        <span className="mono">{listing === undefined && pendingModel === undefined ? "…" : shortModel(shownModel)}</span>{pendingModel === undefined ? <Icon name="chevronDown" size={14} /> : <span className="spinner chip-spinner" aria-hidden="true" />}
      </button>}
      <Menu label="Thread options" items={mobile ? [{ label: `Model: ${shortModel(shownModel)}`, icon: "settings", onSelect: () => setDialog("model"), disabled: !ready }, "separator", ...items] : items} />
    </>}
    {dialog === "model" ? <ModelPicker state={state} close={() => setDialog(null)} changed={modelChanged} /> : dialog === "gallery" ? <GalleryDialog state={state} close={() => setDialog(null)} /> : dialog === null ? null : <ConversationDialogs dialog={dialog} state={state} close={() => setDialog(null)} />}
  </header>;
}

function NoCharacter({ state }: { state: WorkspaceSnapshot }) {
  return <div className="empty">
    <p className="empty-title">{state.characters.length === 0 ? "No characters yet" : "Choose a character"}</p>
    <p className="empty-text">{state.characters.length === 0 ? "Create a character with the + button in the sidebar." : "Pick a character in the sidebar to open their threads."}</p>
  </div>;
}

export function Chat({ state, sidebarOpen, toggleSidebar, mobile }: { state: WorkspaceSnapshot; sidebarOpen: boolean; toggleSidebar: () => void; mobile: boolean }) {
  useEffect(() => { readMarks.check(); });
  useEffect(() => {
    addEventListener("focus", readMarks.check);
    document.addEventListener("visibilitychange", readMarks.check);
    return () => {
      removeEventListener("focus", readMarks.check);
      document.removeEventListener("visibilitychange", readMarks.check);
    };
  }, []);
  return <>
    <ChatTopbar state={state} sidebarOpen={sidebarOpen} toggleSidebar={toggleSidebar} mobile={mobile} />
    <ConnectionBanner state={state} />
    {state.character === null ? <NoCharacter state={state} /> : <>
      <Transcript key={`${state.character}/${state.thread ?? ""}/${String(state.segmentView?.segment.index ?? "current")}`} state={state} character={state.character} mobile={mobile} />
      {state.threads.find((thread) => thread.id === state.thread)?.heartbeat === true
        ? <div className="composer-wrap"><p className="composer composer-note" role="note">{`${state.character}'s heartbeats run here. You can read along, and write to ${state.character} in another thread.`}</p></div>
        : <Composer key={JSON.stringify([state.character, state.thread])} state={state} character={state.character} mobile={mobile} />}
      <QuoteButton />
    </>}
  </>;
}
