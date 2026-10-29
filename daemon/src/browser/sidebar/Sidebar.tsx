import { useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { Avatar } from "../ui/avatar.tsx";
import { IconButton } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { navigate } from "../app/route.ts";
import { conversation, perform, useActiveRequests, workspace } from "../app/state.ts";
import { sortThreads } from "./order.ts";

export function threadLabel(thread: Pick<ThreadView, "id" | "label">): string {
  return thread.label !== undefined && thread.label !== "" ? thread.label : thread.id;
}

function UnreadBadge({ count }: { count: number }) {
  return <span className="sidebar-unread">
    <span aria-hidden="true">{count > 99 ? "99+" : String(count)}</span>
    <span className="sr-only">{count === 1 ? "(1 unread message)" : `(${String(count)} unread messages)`}</span>
  </span>;
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
  const selectCharacter = (name: string) => perform(async () => {
    if (name !== state.character) await workspace.actions.run("switch_character", { name });
    navigate({ view: "chat" });
    if (mobile) close();
  });
  const selectThread = (name: string) => perform(async () => {
    if (name !== state.thread) await workspace.actions.run("switch_thread", { name, resync: true });
    navigate({ view: "chat" });
    if (mobile) close();
  });
  return <aside className="sidebar" aria-label="Characters and conversations">
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
        const selected = character.name === state.character;
        return <div key={character.name} className="sidebar-group">
          <button type="button" className={`sidebar-item character ${selected ? "on" : ""}`} aria-current={selected ? "true" : undefined} disabled={!ready} onClick={() => selectCharacter(character.name)}>
            <Avatar name={character.name} avatar={character.avatar} size={30} selected={selected} /><span className="sidebar-name">{character.name}</span>
          </button>
          {selected ? <div className="sidebar-threads" role="group" aria-label={`${character.name} conversations`}>
            {sortThreads(state.threads).map((thread) => {
              const current = thread.id === state.thread;
              const unread = current ? 0 : thread.unread ?? 0;
              const replying = !current && conversation.activeIn({ character: state.character, thread: thread.id });
              return <button key={thread.id} type="button" className={`sidebar-item thread ${current ? "on" : ""} ${unread > 0 ? "unread" : ""}`} aria-current={current ? "page" : undefined} disabled={!ready} onClick={() => selectThread(thread.id)}>
                <Icon name={thread.home ? "home" : "chat"} size={14} /><span className="sidebar-name">{threadLabel(thread)}</span>
                {thread.locked === true ? <span className="sidebar-locked" title="Locked: only you change its label, purpose and files"><Icon name="lock" size={12} /><span className="sr-only">(locked)</span></span> : null}
                {replying ? <span className="sidebar-replying"><span className="spinner" aria-hidden="true" /><span className="sr-only">(replying)</span></span> : null}
                {unread > 0 ? <UnreadBadge count={unread} /> : null}
              </button>;
            })}
            <button type="button" className="sidebar-item thread muted" disabled={!ready} onClick={newThread}><Icon name="plus" size={14} /><span className="sidebar-name">New conversation</span></button>
          </div> : null}
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
