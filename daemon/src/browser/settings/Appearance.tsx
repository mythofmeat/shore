import type { WorkspaceSnapshot } from "../workspace.ts";
import { VIEW_CONTROLS, type ViewKey } from "../preferences.ts";
import { THEMES } from "../theme.ts";
import { Switch } from "../ui/controls.tsx";
import { display, themes, useDisplay, useTheme } from "../app/state.ts";
import { SettingRow, SettingsSection } from "./layout.tsx";

const TOGGLES: readonly { key: ViewKey; description: string }[] = [
  { key: "timestamps", description: "Show the time next to each message." },
  { key: "thinking", description: "Show a collapsed Reasoning note above replies that include it." },
  { key: "tools", description: "Show tool calls and their results as expandable lines." },
  { key: "subagent", description: "Show subagents working while a reply streams." },
  { key: "images", description: "Show images attached to messages and returned by tools." },
  { key: "metadata", description: "Show the model, token counts and timing under replies." },
  { key: "compaction", description: "Show a notice while the conversation is being compacted." },
];

export function AppearancePage(_: { state: WorkspaceSnapshot }) {
  const theme = useTheme();
  const values = useDisplay();
  const store = themes;
  return <>
    <SettingsSection title="Theme" description="Saved in this browser.">
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {THEMES.map((item) => <button key={item.id} type="button" role="radio" aria-checked={theme === item.id} className={`theme-card ${theme === item.id ? "on" : ""}`} onClick={() => store.select(item.id)}>
          <span className="theme-swatch" data-theme={item.id}><span className="theme-swatch-bar" /><span className="theme-swatch-line" /><span className="theme-swatch-line short" /><span className="theme-swatch-dot" /></span>
          <span className="theme-name">{item.label}</span>
          <span className="theme-description">{item.description}</span>
        </button>)}
      </div>
      {store.error === "" ? null : <p className="form-error" role="alert">{store.error}</p>}
    </SettingsSection>
    <SettingsSection title="Conversation display" description="Saved in this browser.">
      <div className="rows">
        {TOGGLES.map((item) => <SettingRow key={item.key} label={VIEW_CONTROLS[item.key].label} description={item.description}>
          <Switch label={VIEW_CONTROLS[item.key].label} checked={values[item.key] === "on"} change={(checked) => display.change(item.key, checked ? "on" : "off")} />
        </SettingRow>)}
      </div>
      {display.getSnapshot().error === "" ? null : <p className="form-error" role="alert">{display.getSnapshot().error}</p>}
    </SettingsSection>
  </>;
}
