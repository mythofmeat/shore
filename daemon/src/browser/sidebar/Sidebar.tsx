import { useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { Avatar } from "../ui/avatar.tsx";
import { IconButton, PointMenu, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { navigate } from "../app/route.ts";
import { conversation, errorText, perform, useActiveRequests, useCollapsedFolders, workspace } from "../app/state.ts";
import { openFolderDialog } from "../app/intents.ts";
import { moveThreadTo } from "../chat/actions.ts";
import { toasts } from "../ui/toast.tsx";
import { FolderRow } from "./FolderRow.tsx";
import { threadSections } from "./order.ts";
import { useRowMenu } from "./row_menu.ts";
import { THREAD_DRAG_TYPE, ThreadRow, type ThreadNeighbours } from "./ThreadRow.tsx";

export function threadLabel(thread: Pick<ThreadView, "id" | "label">): string {
  return thread.label !== undefined && thread.label !== "" ? thread.label : thread.id;
}

function neighboursIn(ids: readonly string[], id: string, byActivity: boolean): ThreadNeighbours {
  const at = ids.indexOf(id);
  return { up: ids[at - 1], down: ids[at + 2], atEnd: at === ids.length - 1, byActivity };
}

function ThreadList({ state, shownThread, ready, select, newThread }: { state: WorkspaceSnapshot; shownThread: string | null; ready: boolean; select: (name: string) => void; newThread: () => void }) {
  const character = state.character ?? "";
  const collapsed = useCollapsedFolders(character);
  const sections = threadSections(state.threads, state.folders);
  const looseIds = sections.loose.map((thread) => thread.id);
  const unreadOf = (thread: ThreadView) => thread.id === state.thread ? 0 : thread.unread ?? 0;
  const replyingIn = (thread: ThreadView) => thread.id !== state.thread && conversation.activeIn({ character: state.character, thread: thread.id });
  const row = (thread: ThreadView, ids: readonly string[], byActivity: boolean, folder?: string) => <ThreadRow key={thread.id} thread={thread} label={threadLabel(thread)} current={thread.id === shownThread} unread={unreadOf(thread)} replying={replyingIn(thread)}
    opening={state.opening?.thread === thread.id && thread.id !== state.thread} ready={ready} select={() => select(thread.id)} neighbours={neighboursIn(ids, thread.id, byActivity)}
    drop={(id, after) => { void moveThreadTo(id, { folder: folder ?? "", ...placeRelative(ids, thread.id, id, after) }); }} />;
  return <div className="sidebar-threads" role="group" aria-label={`${character} threads`}
    onDragOver={(event) => { if (event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) event.preventDefault(); }}
    onDrop={(event) => { const id = event.dataTransfer.getData(THREAD_DRAG_TYPE); if (id !== "") { event.preventDefault(); void moveThreadTo(id, { folder: "" }); } }}>
    {sections.pinned.map((thread) => row(thread, [], false))}
    {sections.loose.map((thread) => row(thread, looseIds, !state.manualOrder))}
    {sections.folders.map((folder, index) => {
      const ids = folder.threads.map((thread) => thread.id);
      const shut = collapsed.has(folder.name);
      const shown = shut ? folder.threads.filter((thread) => thread.id === state.thread) : folder.threads;
      return <div key={folder.name} className="thread-folder" role="group" aria-label={`Folder ${folder.name}`}>
        <FolderRow character={character} folder={folder} collapsed={shut} ready={ready} unread={folder.threads.reduce((total, thread) => total + unreadOf(thread), 0)} replying={folder.threads.some(replyingIn)}
          neighbours={{ up: sections.folders[index - 1]?.name, down: sections.folders[index + 2]?.name, atEnd: index === sections.folders.length - 1 }}
          drop={(id) => { void moveThreadTo(id, { folder: folder.name }); }} />
        {shown.map((thread) => row(thread, ids, folder.byActivity, folder.name))}
      </div>;
    })}
    <button type="button" className="sidebar-item thread muted" disabled={!ready} onClick={newThread}><Icon name="plus" size={14} /><span className="sidebar-name">New thread</span></button>
  </div>;
}

function placeRelative(ids: readonly string[], onto: string, dragged: string, after: boolean): { before?: string } {
  const rest = ids.filter((id) => id !== dragged);
  const at = rest.indexOf(onto);
  const before = rest[after ? at + 1 : at];
  return before === undefined ? {} : { before };
}

function CharacterRow({ state, character, selected, openingThis, ready, select }: { state: WorkspaceSnapshot; character: WorkspaceSnapshot["characters"][number]; selected: boolean; openingThis: boolean; ready: boolean; select: () => void }) {
  const menu = useRowMenu();
  const items: MenuItem[] = [
    { label: "New folder…", icon: "plus", onSelect: () => openFolderDialog({ kind: "new" }), disabled: !ready },
    { label: "Sort threads by activity", icon: "refresh", ...(state.manualOrder ? {} : { detail: "On" }), onSelect: () => { void workspace.actions.run("thread_sort", { by_activity: state.manualOrder }).then((listing) => workspace.applyThreadListing(listing)).catch((error: unknown) => toasts.show(errorText(error), "error")); }, disabled: !ready },
  ];
  const openable = character.name === state.character;
  return <div className={`thread-row character-row ${menu.at === null ? "" : "menu-open"}`} {...(openable ? menu.handlers : {})}>
    <button type="button" className={`sidebar-item character ${selected ? "on" : ""}`} aria-current={selected ? "true" : undefined} aria-busy={openingThis} disabled={!ready} onClick={() => { if (!menu.swallowClick()) select(); }}>
      <Avatar name={character.name} avatar={character.avatar} size={30} selected={selected} /><span className="sidebar-name">{character.name}</span>
      {openingThis ? <span className="sidebar-replying"><span className="spinner" aria-hidden="true" /><span className="sr-only">(opening)</span></span> : null}
    </button>
    {openable ? <IconButton icon="more" size={16} className="thread-more" label={`Options for ${character.name}’s threads`} aria-haspopup="menu" aria-expanded={menu.at !== null} onClick={menu.openFrom} /> : null}
    {menu.at === null ? null : <PointMenu label={`Options for ${character.name}’s threads`} items={items} at={menu.at} close={menu.close} />}
  </div>;
}

function ConnectionStatus({ status }: { status: WorkspaceSnapshot["status"] }) {
  const [text, tone] = status === "ready" ? ["Connected", "ok"] : status === "error" ? ["Offline", "bad"] : status === "reload_required" ? ["Update ready", "bad"] : ["Reconnecting…", "wait"];
  return <span className="connection" data-tone={tone} title={text}><span className="connection-dot" />{text}</span>;
}

export function Sidebar({ state, mobile, close, collapse, newCharacter, newThread }: {
  state: WorkspaceSnapshot; mobile: boolean; close: () => void; collapse: () => void; newCharacter: () => void; newThread: () => void;
}) {
  const [query, setQuery] = useState("");
  useActiveRequests();
  const ready = state.status === "ready";
  const needle = query.trim().toLowerCase();
  const characters = state.characters.filter((character) => character.name.toLowerCase().includes(needle));
  const opening = state.opening;
  const shownCharacter = opening?.character ?? state.character;
  const shownThread = opening === null ? state.thread : opening.thread;
  const selectCharacter = (name: string) => {
    navigate({ view: "chat" });
    if (mobile) close();
    if (name !== state.character) perform(() => workspace.openCharacter(name));
  };
  const selectThread = (name: string) => {
    navigate({ view: "chat" });
    if (mobile) close();
    if (name !== state.thread) perform(() => workspace.openThread(name));
  };
  return <aside className="sidebar" aria-label="Characters and threads">
    <div className="sidebar-header">
      <span className="wordmark">shore</span>
      <div className="sidebar-header-actions">
        <IconButton icon="plus" label="New character" disabled={!ready} onClick={newCharacter} />
        {mobile ? <IconButton icon="close" label="Close sidebar" onClick={close} /> : <IconButton icon="panel" label="Collapse sidebar" onClick={collapse} />}
      </div>
    </div>
    <label className="sidebar-search">
      <Icon name="search" size={16} />
      <input type="search" aria-label="Search characters" placeholder="Search characters" value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>
    <nav className="sidebar-list" aria-label="Characters">
      {characters.map((character) => {
        const selected = character.name === shownCharacter;
        const openingThis = opening !== null && opening.character === character.name && character.name !== state.character;
        return <div key={character.name} className="sidebar-group">
          <CharacterRow state={state} character={character} selected={selected} openingThis={openingThis} ready={ready} select={() => selectCharacter(character.name)} />
          {character.name === state.character ? <ThreadList state={state} shownThread={shownThread} ready={ready} select={selectThread} newThread={newThread} /> : null}
        </div>;
      })}
      {state.characters.length === 0 && ready ? <p className="sidebar-empty">No characters yet.</p> : null}
      {state.characters.length > 0 && characters.length === 0 ? <p className="sidebar-empty">No characters match “{query}”.</p> : null}
    </nav>
    <div className="sidebar-footer">
      <button type="button" className="sidebar-item" onClick={() => { navigate({ view: "settings", page: "models" }); if (mobile) close(); }}><Icon name="settings" /><span className="sidebar-name">Settings</span></button>
      <ConnectionStatus status={state.status} />
    </div>
  </aside>;
}
