import { useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { Avatar } from "../ui/avatar.tsx";
import { IconButton } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { navigate } from "../app/route.ts";
import { perform, workspace } from "../app/state.ts";

export function threadLabel(thread: Pick<ThreadView, "id" | "label">): string {
  return thread.label !== undefined && thread.label !== "" ? thread.label : thread.id;
}

function sortThreads(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => Number(b.home) - Number(a.home) || (b.last_active ?? b.created_at).localeCompare(a.last_active ?? a.created_at));
}

export function ConnectionStatus({ status }: { status: WorkspaceSnapshot["status"] }) {
  const [text, tone] = status === "ready" ? ["Connected", "ok"] : status === "error" ? ["Offline", "bad"] : status === "reload_required" ? ["Update ready", "bad"] : ["Reconnecting…", "wait"];
  return <span className="connection" data-tone={tone} title={text}><span className="connection-dot" />{text}</span>;
}

export function Sidebar({ state, mobile, close, collapse, newCharacter, newThread }: {
  state: WorkspaceSnapshot; mobile: boolean; close: () => void; collapse: () => void; newCharacter: () => void; newThread: () => void;
}) {
  const [query, setQuery] = useState("");
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
              return <button key={thread.id} type="button" className={`sidebar-item thread ${current ? "on" : ""}`} aria-current={current ? "page" : undefined} disabled={!ready} onClick={() => selectThread(thread.id)}>
                <Icon name={thread.home ? "home" : "chat"} size={14} /><span className="sidebar-name">{threadLabel(thread)}</span>
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
