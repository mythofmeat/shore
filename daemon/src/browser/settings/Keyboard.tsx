import type { WorkspaceSnapshot } from "../workspace.ts";
import { SHORTCUTS, keyLabel } from "../app/shortcuts.ts";
import { SettingsSection } from "./layout.tsx";

export function KeyboardPage(_: { state: WorkspaceSnapshot }) {
  const groups = ["Anywhere", "Message box", "Conversation"] as const;
  return <>
    <p className="settings-description">Shortcuts work everywhere in the chat. They can’t be rebound yet.</p>
    {groups.map((group) => <SettingsSection key={group} title={group}>
      <div className="rows">
        {SHORTCUTS.filter((item) => item.where === group).map((item) => <div key={item.description} className="setting-row">
          <div className="setting-text"><div className="setting-label">{item.description}</div></div>
          <div className="setting-control keys">{item.keys.map((key, index) => <kbd key={index}>{keyLabel(key)}</kbd>)}</div>
        </div>)}
      </div>
    </SettingsSection>)}
  </>;
}
