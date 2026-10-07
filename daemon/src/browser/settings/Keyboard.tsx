import type { WorkspaceSnapshot } from "../workspace.ts";
import { keyLabel, shortcutsFor } from "../app/shortcuts.ts";
import { ENTER_SENDS_KEY } from "../app/state.ts";
import { Switch } from "../ui/controls.tsx";
import { useStoredFlag } from "../ui/hooks.ts";
import { SettingRow, SettingsSection } from "./layout.tsx";

export function KeyboardPage(_: { state: WorkspaceSnapshot }) {
  const groups = ["Anywhere", "Message box", "Conversation"] as const;
  const [enterSends, setEnterSends] = useStoredFlag(ENTER_SENDS_KEY, true);
  const shortcuts = shortcutsFor(enterSends);
  return <>
    <p className="settings-description">Shortcuts work everywhere in the chat. They can’t be rebound yet.</p>
    <SettingsSection title="Sending" description="Saved in this browser.">
      <div className="rows">
        <SettingRow label="Enter sends" description={`When off, Enter adds a new line and ${keyLabel("Mod")}+Enter sends. On phones Enter always adds a new line.`}>
          <Switch label="Enter sends" checked={enterSends} change={setEnterSends} />
        </SettingRow>
      </div>
    </SettingsSection>
    {groups.map((group) => <SettingsSection key={group} title={group}>
      <div className="rows">
        {shortcuts.filter((item) => item.where === group).map((item) => <div key={item.description} className="setting-row">
          <div className="setting-text"><div className="setting-label">{item.description}</div></div>
          <div className="setting-control keys">{item.keys.map((key, index) => <kbd key={index}>{keyLabel(key)}</kbd>)}</div>
        </div>)}
      </div>
    </SettingsSection>)}
  </>;
}
