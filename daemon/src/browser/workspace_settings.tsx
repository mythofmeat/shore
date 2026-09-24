import { Modal } from "./components.tsx";
import { LOCAL_SHORTCUTS, type LocalShortcut } from "./keyboard.ts";

const groups: { title: string; entries: { target: LocalShortcut; description: string; character?: boolean; offline?: boolean }[] }[] = [
  { title: "Your workspace", entries: [
    { target: "display", description: "Theme, colors and reading preferences", offline: true },
    { target: "models", description: "Choose the models behind your characters" },
    { target: "keyboard", description: "Make the controls your own", offline: true },
    { target: "help", description: "Navigation, drafting and shortcuts", offline: true },
  ] },
  { title: "Configuration & tools", entries: [
    { target: "settings", description: "Character and application configuration" },
    { target: "providers", description: "Model providers and connections" },
    { target: "memory", description: "Manage context and conversation memory", character: true },
    { target: "tools", description: "Run and inspect character tools", character: true },
  ] },
  { title: "Storage & diagnostics", entries: [
    { target: "archives", description: "Import and export character backups" },
    { target: "usage", description: "Token usage, costs and limits" },
    { target: "diagnostics", description: "Inspect prompts and troubleshoot", character: true },
    { target: "output", description: "Review your most recent action", offline: true },
  ] },
];

export function WorkspaceSettings({ ready, character, run, close }: { ready: boolean; character: string | null; run: (target: LocalShortcut) => void; close: () => void }) {
  return <Modal title="Workspace settings" close={close}><div className="workspace-settings">{groups.map((group) => <section key={group.title}><h3>{group.title}</h3><div className="settings-grid">{group.entries.map(({ target, description, offline, character: needsCharacter }) => <button key={target} aria-label={LOCAL_SHORTCUTS[target]} aria-describedby={`workspace-${target}-description`} disabled={!offline && (!ready || (needsCharacter === true && character === null))} onClick={() => run(target)}><strong>{LOCAL_SHORTCUTS[target]}</strong><span id={`workspace-${target}-description`}>{description}</span></button>)}</div></section>)}<section className="connection-settings"><div><h3>Connection</h3><p>This browser connects to your Shore daemon using its access token. Disconnecting clears the session; your saved drafts stay on this device.</p></div><button onClick={() => run("sign_out")}>Disconnect</button></section></div></Modal>;
}
