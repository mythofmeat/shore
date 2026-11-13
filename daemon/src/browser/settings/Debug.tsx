import { useState, type ReactNode } from "react";
import type { ChromeSnapshot } from "../workspace.ts";
import { workspace } from "../app/state.ts";
import { SettingRow, SettingsSection } from "./layout.tsx";
import { NeedsCharacter, useAction } from "./shared.tsx";
import { Tree } from "./tree.tsx";

export function DebugPage({ state }: { state: ChromeSnapshot }) {
  const { busy, run } = useAction();
  const [result, setResult] = useState<{ title: string; value: unknown }>();
  if (state.character === null) return <NeedsCharacter />;
  const action = <T,>(title: string, work: () => Promise<T>, done: (value: T) => string) => <button type="button" className="button" disabled={busy} onClick={() => void run(async () => {
    const value = await work(); setResult({ title, value }); return done(value);
  })}>{title}</button>;
  const rows: [string, string, ReactNode][] = [
    ["Start a wake now", "Wakes the character in its home thread at the next autonomy tick, without waiting for one of its triggers.",
      action("Start a wake", () => workspace.actions.run("heartbeat_tick_now", {}), (value) => value.warning ?? `Wake ${value.status}`)],
    ["Make dormant", "Stops every wake until you write to the character again.",
      action("Make dormant", () => workspace.actions.run("heartbeat_set_dormant", {}), (value) => `${value.character} is ${value.status}`)],
    ["Make active", "Ends dormancy, so the character's triggers wake it again.",
      action("Make active", () => workspace.actions.run("heartbeat_set_active", {}), (value) => `${value.character} is ${value.status}`)],
    ["Dream now", "Starts a dream at the next autonomy tick instead of waiting for its schedule.",
      action("Dream", () => workspace.actions.run("dream", { now: true }), (value) => value.running ? "Already dreaming" : "Dream queued")],
    ["Send a cache keepalive", "Pings the provider now to keep the prompt cache warm.",
      action("Ping", () => workspace.actions.run("keepalive_ping_now", {}), (value) => `Keepalive ${value.status}`)],
    ["Activate the session", "Registers the session and starts keepalive and the character's own time as a client connection would.",
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
