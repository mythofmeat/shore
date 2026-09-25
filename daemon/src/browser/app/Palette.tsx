import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Dialog } from "../ui/controls.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { openConversationDialog, requestConfigSearch } from "./intents.ts";
import { navigate, SETTINGS_PAGES } from "./route.ts";
import { keyLabel, paletteMatches, SHORTCUTS } from "./shortcuts.ts";
import { perform, workspace } from "./state.ts";

export type PaletteScope = "full" | "shortcuts" | "config";
interface Command { id: string; label: string; detail?: string; icon: IconName; group: string; run: () => void }


export function Palette({ state, close, newThread, newCharacter, initialScope = "full" }: { state: WorkspaceSnapshot; close: () => void; newThread: () => void; newCharacter: () => void; initialScope?: PaletteScope }) {
  const [scope, setScope] = useState<PaletteScope>(initialScope);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [keys, setKeys] = useState<string[]>([]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scope !== "config" || keys.length > 0 || state.status !== "ready") return;
    workspace.actions.run("config_schema", {}, { remember: false }).then((result) => setKeys(result.schema.filter((entry) => entry.settable && !entry.key.includes("<")).map((entry) => entry.key))).catch(() => setKeys([]));
  }, [scope, keys.length, state.status]);
  const commands = useMemo<Command[]>(() => {
    const run = (work: () => void) => () => { close(); work(); };
    if (scope === "shortcuts") return SHORTCUTS.map((item, index) => ({ id: `shortcut:${String(index)}`, label: item.description, detail: item.keys.map(keyLabel).join(" "), icon: "info", group: item.where, run: run(() => navigate({ view: "settings", page: "keyboard" })) }));
    if (scope === "config") return keys.map((key) => ({ id: `config:${key}`, label: key, icon: "settings", group: "Settings keys", run: run(() => { requestConfigSearch(key); navigate({ view: "settings", page: "configuration" }); }) }));
    const conversation = state.character === null ? [] : [
      { id: "new-thread", label: "New conversation", icon: "plus" as const, group: "Conversation", run: run(newThread) },
      ...(["rename", "fork", "guidance", "system", "compact", "clear", "gallery", "model"] as const).map((name) => ({
        id: `dialog:${name}`, icon: "chat" as const, group: "Conversation", run: run(() => { navigate({ view: "chat" }); requestAnimationFrame(() => openConversationDialog(name)); }),
        label: { rename: "Rename conversation", fork: "Fork conversation", guidance: "Regenerate with guidance", system: "Add a system message", compact: "Compact context", clear: "Clear context", gallery: "Show images", model: "Choose a model" }[name],
      })),
      ...state.threads.map((thread) => ({ id: `thread:${thread.id}`, label: `Open ${threadLabel(thread)}`, detail: state.character ?? "", icon: "chat" as const, group: "Conversations", run: run(() => { navigate({ view: "chat" }); perform(() => workspace.actions.run("switch_thread", { name: thread.id, resync: true })); }) })),
    ];
    return [
      ...conversation,
      ...state.characters.map((character) => ({ id: `character:${character.name}`, label: `Go to ${character.name}`, icon: "person" as const, group: "Characters", run: run(() => { navigate({ view: "chat" }); perform(() => workspace.actions.run("switch_character", { name: character.name })); }) })),
      { id: "new-character", label: "New character", icon: "plus", group: "Characters", run: run(newCharacter) },
      ...SETTINGS_PAGES.map((page) => ({ id: `settings:${page.id}`, label: page.label, detail: `Settings · ${page.group}`, icon: "settings" as const, group: "Settings", run: run(() => navigate({ view: "settings", page: page.id })) })),
    ];
  }, [scope, keys, state.characters, state.threads, state.character, close, newThread, newCharacter]);
  const visible = paletteMatches(commands, query).map((index) => commands[index]).filter((item): item is Command => item !== undefined).slice(0, 60);
  const current = Math.min(active, Math.max(visible.length - 1, 0));
  useEffect(() => { list.current?.querySelector(`[data-index="${String(current)}"]`)?.scrollIntoView({ block: "nearest" }); }, [current]);
  return <Dialog title="Command palette" close={close} wide>
    <div className="segmented" role="radiogroup" aria-label="Search">
      {([["full", "Everything"], ["shortcuts", "Shortcuts"], ["config", "Settings keys"]] as const).map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={scope === id} onClick={() => { setScope(id); setActive(0); }}>{label}</button>)}
    </div>
    <label className="sidebar-search picker-search"><Icon name="search" size={16} /><input type="search" autoFocus aria-label="Search commands" placeholder="Type a command, character or setting" value={query}
      onChange={(event) => { setQuery(event.target.value); setActive(0); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setActive(Math.min(current + 1, visible.length - 1)); }
        if (event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(current - 1, 0)); }
        if (event.key === "Enter") { event.preventDefault(); visible[current]?.run(); }
      }} /></label>
    <div className="palette-list" role="listbox" aria-label="Commands" ref={list}>
      {visible.length === 0 ? <p className="picker-empty">{scope === "config" && keys.length === 0 ? "Loading settings…" : "Nothing matches."}</p> : visible.map((command, index) => <button key={command.id} type="button" role="option" data-index={index} aria-selected={index === current} className={`palette-item ${index === current ? "on" : ""}`} onMouseMove={() => setActive(index)} onClick={command.run}>
        <Icon name={command.icon} size={16} /><span className="palette-label">{command.label}</span><span className="palette-detail">{command.detail ?? command.group}</span>
      </button>)}
    </div>
  </Dialog>;
}
