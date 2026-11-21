import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PresenceArgs } from "../../protocol/PresenceArgs.ts";
import type { PresenceResult } from "../../protocol/PresenceResult.ts";
import { IconButton } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";

export class PresenceStore {
  #held: PresenceResult | null = null;
  readonly #listeners = new Set<() => void>();
  constructor(readonly ask: (args: PresenceArgs) => Promise<PresenceResult>, readonly failed: (error: unknown) => void) {}
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): PresenceResult | null => this.#held;
  load = (args: PresenceArgs): void => {
    this.ask(args).then((held) => { this.#held = held; for (const listener of this.#listeners) listener(); }).catch(this.failed);
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function onFor(setAt: string, now: number): string {
  const gap = now - Date.parse(setAt);
  if (gap < HOUR) return `${String(Math.max(1, Math.floor(gap / MINUTE)))}m`;
  return gap < DAY ? `${String(Math.floor(gap / HOUR))}h` : `${String(Math.floor(gap / DAY))}d`;
}

export function StatusPicker({ ready, store }: { ready: boolean; store: PresenceStore }) {
  const presence = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!ready) return;
    const refresh = () => { store.load({}); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); };
  }, [ready, store]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    field.current?.focus();
    return () => { document.removeEventListener("pointerdown", outside); };
  }, [open]);
  if (presence === null) return null;
  const on = presence.statuses.map((status) => status.status);
  const wanted = typed.trim();
  const offered = presence.history.filter((name) => !on.includes(name) && name.toLowerCase().includes(wanted.toLowerCase()));
  const named = on.length === 0 ? "Your status" : `Your status: ${on.join(", ")}`;
  const now = Date.now();
  const act = (args: PresenceArgs) => {
    store.load(args);
    field.current?.focus();
  };
  const add = () => {
    if (wanted === "") return;
    act({ on: [wanted] });
    setTyped("");
  };
  return <div className="sidebar-status" ref={root} onKeyDown={(event) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    root.current?.querySelector("button")?.focus();
  }}>
    <button type="button" className="sidebar-item" aria-haspopup="dialog" aria-expanded={open} aria-label={named} title={named} onClick={() => { setOpen(!open); }}>
      <Icon name="person" /><span className={on.length === 0 ? "sidebar-name unset" : "sidebar-name"}>{on.length === 0 ? "Set status" : on.join(", ")}</span><Icon name="chevronUp" />
    </button>
    {open ? <div className="menu-list align-start above status-panel" role="dialog" aria-label="Your status">
      {on.length === 0 ? null : <ul className="status-on" aria-label="On now">
        {presence.statuses.map((status) => <li key={status.status} className="status-chip">
          <span className="status-chip-name">{status.status}</span>
          <span className="status-chip-age">{onFor(status.set_at, now)}</span>
          <IconButton icon="close" label={`Turn off ${status.status}`} onClick={() => { act({ off: [status.status] }); }} />
        </li>)}
      </ul>}
      <form className="status-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <input ref={field} className="input" aria-label="Add a status" placeholder="Add a status" value={typed} onChange={(event) => { setTyped(event.target.value); }} />
      </form>
      {offered.length === 0 ? null : <ul className="status-history" aria-label="Used before">
        {offered.map((name) => <li key={name}>
          <button type="button" className="status-pick" onClick={() => { act({ on: [name] }); }}>{name}</button>
          <IconButton icon="trash" label={`Forget ${name}`} onClick={() => { act({ forget: [name] }); }} />
        </li>)}
      </ul>}
      {on.length === 0 ? null : <button type="button" className="status-clear" onClick={() => { act({ clear: true }); }}>Turn all off</button>}
    </div> : null}
  </div>;
}
