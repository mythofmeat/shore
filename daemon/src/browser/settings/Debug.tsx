import { useState, type ReactNode } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { workspace } from "../app/state.ts";
import { SettingRow, SettingsSection } from "./layout.tsx";
import { NeedsCharacter, useAction } from "./shared.tsx";
import { Tree } from "./tree.tsx";

export function DebugPage({ state }: { state: WorkspaceSnapshot }) {
  const { busy, run } = useAction();
  const [result, setResult] = useState<{ title: string; value: unknown }>();
  if (state.character === null) return <NeedsCharacter />;
  const action = <T,>(title: string, work: () => Promise<T>, done: (value: T) => string) => <button type="button" className="button" disabled={busy} onClick={() => void run(async () => {
    const value = await work(); setResult({ title, value }); return done(value);
  })}>{title}</button>;
  const rows: [string, string, ReactNode][] = [
    ["Run a heartbeat now", "Fires the next autonomous check-in immediately instead of waiting for the schedule.",
      action("Run heartbeat", () => workspace.actions.run("heartbeat_tick_now", {}), (value) => value.warning ?? `Heartbeat ${value.status}`)],
    ["Make dormant", "Stops autonomous check-ins until the character wakes up.",
      action("Make dormant", () => workspace.actions.run("heartbeat_set_dormant", {}), (value) => `Heartbeat is ${value.status}`)],
    ["Make active", "Resumes autonomous check-ins on the normal schedule.",
      action("Make active", () => workspace.actions.run("heartbeat_set_active", {}), (value) => `Heartbeat is ${value.status}`)],
    ["Send a cache keepalive", "Pings the provider now to keep the prompt cache warm.",
      action("Ping", () => workspace.actions.run("keepalive_ping_now", {}), (value) => `Keepalive ${value.status}`)],
    ["Activate the session", "Registers the session and starts keepalive and heartbeat as a client connection would.",
      action("Activate", () => workspace.actions.run("session_activate", {}), () => "Session activated")],
  ];
  return <>
    <p className="settings-description">Manual controls for {state.character}’s background activity. These act immediately.</p>
    <SettingsSection title="Controls">
      <div className="rows">{rows.map(([label, description, control]) => <SettingRow key={label} label={label} description={description}>{control}</SettingRow>)}</div>
    </SettingsSection>
    {result === undefined ? null : <SettingsSection title={`Last result: ${result.title}`}><div className="rows padded"><Tree value={result.value} /></div></SettingsSection>}
  </>;
}
