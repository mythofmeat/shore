import { useEffect, useSyncExternalStore } from "react";
import type { PresenceArgs } from "../../protocol/PresenceArgs.ts";
import type { PresenceResult } from "../../protocol/PresenceResult.ts";
import { Menu, type MenuItem } from "../ui/controls.tsx";
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

export function StatusPicker({ ready, store }: { ready: boolean; store: PresenceStore }) {
  const presence = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (!ready) return;
    const refresh = () => { store.load({}); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); };
  }, [ready, store]);
  if (presence === null) return null;
  const current = presence.status;
  if (current === undefined && presence.choices.length === 0) return null;
  const choices = presence.choices.map((choice): MenuItem => ({ label: choice, ...(choice === current ? { detail: "Set" } : {}), onSelect: () => { store.load({ status: choice }); } }));
  const clear: MenuItem[] = current === undefined ? [] : ["separator", { label: "Clear status", onSelect: () => { store.load({ status: "" }); } }];
  const shown = current === undefined ? <span className="sidebar-name unset">Set status</span> : <span className="sidebar-name">{current}</span>;
  return <div className="sidebar-status">
    <Menu label="Your status" items={[...choices, ...clear]} trigger={<><Icon name="person" />{shown}<Icon name="chevronUp" /></>} triggerLabel={current === undefined ? "Your status" : `Your status: ${current}`} triggerClassName="sidebar-item" align="start" placement="above" />
  </div>;
}
