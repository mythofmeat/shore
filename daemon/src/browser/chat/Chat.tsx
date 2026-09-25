import { useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Avatar } from "../ui/avatar.tsx";
import { IconButton, Menu, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { ConnectionBanner } from "../app/banner.tsx";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { useConversationActive } from "../app/state.ts";
import { makeHome } from "./actions.ts";
import { Composer } from "./Composer.tsx";
import { ConversationDialogs, type ConversationDialog } from "./dialogs.tsx";
import { ModelPicker, shortModel, useModelListing } from "./models.tsx";
import { Transcript } from "./Transcript.tsx";

function SidebarToggle({ open, mobile, toggle }: { open: boolean; mobile: boolean; toggle: () => void }) {
  if (open) return null;
  return <IconButton icon={mobile ? "menu" : "panel"} label={mobile ? "Open sidebar" : "Expand sidebar"} onClick={toggle} />;
}

export function ChatTopbar({ state, sidebarOpen, toggleSidebar, mobile }: { state: WorkspaceSnapshot; sidebarOpen: boolean; toggleSidebar: () => void; mobile: boolean }) {
  const [dialog, setDialog] = useState<ConversationDialog | "model" | null>(null);
  const { listing, refresh } = useModelListing(state);
  const busy = useConversationActive();
  const character = state.characters.find((item) => item.name === state.character);
  const thread = state.threads.find((item) => item.id === state.thread);
  const ready = state.status === "ready";
  const items: MenuItem[] = [
    { label: "Rename…", icon: "label", onSelect: () => setDialog("rename"), disabled: !ready },
    { label: "Fork conversation…", icon: "branch", onSelect: () => setDialog("fork"), disabled: !ready },
    { label: "Regenerate with guidance…", icon: "regenerate", onSelect: () => setDialog("guidance"), disabled: !ready || busy || !state.messages.some((message) => message.role === "assistant") },
    { label: "Add system message…", icon: "info", onSelect: () => setDialog("system"), disabled: !ready },
    "separator",
    { label: "Compact context…", icon: "compact", onSelect: () => setDialog("compact"), disabled: !ready || busy },
    { label: "Clear context…", icon: "refresh", onSelect: () => setDialog("clear"), disabled: !ready || busy },
    "separator",
    ...(thread?.home === true ? [] : [{ label: "Make home conversation", icon: "home" as const, onSelect: () => { void makeHome(state); }, disabled: !ready }]),
    { label: "Archive conversation…", icon: "archive", onSelect: () => setDialog("archive"), disabled: !ready || thread?.home === true, danger: true },
  ];
  return <header className="topbar">
    <SidebarToggle open={sidebarOpen} mobile={mobile} toggle={toggleSidebar} />
    {state.character === null ? <div className="topbar-title"><span className="topbar-name">Shore</span></div> : <>
      <Avatar name={state.character} avatar={character?.avatar} size={30} />
      <div className="topbar-title">
        <span className="topbar-name">{state.character}</span>
        {state.thread === null ? null : <><span className="topbar-separator">/</span><span className="topbar-thread">{thread === undefined ? state.thread : threadLabel(thread)}</span></>}
      </div>
      {mobile ? null : <button type="button" className="model-chip" aria-label={`Chat model: ${listing?.active ?? "unknown"}. Change model`} title="Change model" disabled={!ready} onClick={() => setDialog("model")}>
        <span className="mono">{listing === undefined ? "…" : shortModel(listing.active)}</span><Icon name="chevronDown" size={14} />
      </button>}
      <Menu label="Conversation options" items={mobile ? [{ label: `Model: ${shortModel(listing?.active)}`, icon: "settings", onSelect: () => setDialog("model"), disabled: !ready }, "separator", ...items] : items} />
    </>}
    {dialog === "model" ? <ModelPicker state={state} close={() => setDialog(null)} changed={refresh} /> : dialog === null ? null : <ConversationDialogs dialog={dialog} state={state} close={() => setDialog(null)} />}
  </header>;
}

function NoCharacter({ state }: { state: WorkspaceSnapshot }) {
  return <div className="empty">
    <p className="empty-title">{state.characters.length === 0 ? "No characters yet" : "Choose a character"}</p>
    <p className="empty-text">{state.characters.length === 0 ? "Create a character with the + button in the sidebar." : "Pick a character in the sidebar to open their conversations."}</p>
  </div>;
}

export function Chat({ state, sidebarOpen, toggleSidebar, mobile }: { state: WorkspaceSnapshot; sidebarOpen: boolean; toggleSidebar: () => void; mobile: boolean }) {
  return <>
    <ChatTopbar state={state} sidebarOpen={sidebarOpen} toggleSidebar={toggleSidebar} mobile={mobile} />
    <ConnectionBanner state={state} />
    {state.character === null ? <NoCharacter state={state} /> : <>
      <Transcript key={`${state.character}/${state.thread ?? ""}`} state={state} character={state.character} mobile={mobile} />
      <Composer key={JSON.stringify([state.character, state.thread])} state={state} character={state.character} mobile={mobile} />
    </>}
  </>;
}
