import type { WorkspaceSnapshot } from "../workspace.ts";
import { VIEW_CONTROLS, type ViewKey } from "../preferences.ts";
import type { NotifyPermission } from "../notifications.ts";
import { FONT_SIZES } from "../font_size.ts";
import { THEMES } from "../theme.ts";
import { Switch } from "../ui/controls.tsx";
import { display, fontSizes, notifier, perform, STREAM_KEY, themes, useDisplay, useFontSize, useNotifications, useTheme } from "../app/state.ts";
import { useStoredFlag } from "../ui/hooks.ts";
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

const NOTIFY_DESCRIPTION = "When this tab isn’t focused, show a desktop notification and a count in the tab title for new replies, heartbeat messages and errors.";
const NOTIFY_NOTES: Partial<Record<NotifyPermission, string>> = {
  unavailable: "This browser only allows desktop notifications over HTTPS or localhost, so only the tab title count is shown.",
  denied: "Notifications are blocked for this site in the browser’s settings, so only the tab title count is shown.",
};
const NOTIFY_UNDECIDED = "The browser hasn’t allowed desktop notifications for this site yet, so only the tab title count is shown. Turn this off and on again to be asked.";

export function AppearancePage(_: { state: WorkspaceSnapshot }) {
  const theme = useTheme();
  const fontSize = useFontSize();
  const values = useDisplay();
  const store = themes;
  const [stream, setStream] = useStoredFlag(STREAM_KEY, true);
  const notify = useNotifications();
  const note = notify.permission === "default" ? notify.enabled ? NOTIFY_UNDECIDED : undefined : NOTIFY_NOTES[notify.permission];
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
    <SettingsSection title="Text size" description="Saved in this browser.">
      <div className="segmented" role="radiogroup" aria-label="Text size">
        {FONT_SIZES.map((item) => <button key={item.id} type="button" role="radio" aria-checked={fontSize === item.id} onClick={() => fontSizes.select(item.id)}>{item.label}</button>)}
      </div>
      {fontSizes.error === "" ? null : <p className="form-error" role="alert">{fontSizes.error}</p>}
    </SettingsSection>
    <SettingsSection title="Conversation display" description="Saved in this browser.">
      <div className="rows">
        <SettingRow label="Stream replies" description="Show replies as they’re written instead of all at once.">
          <Switch label="Stream replies" checked={stream} change={setStream} />
        </SettingRow>
        {TOGGLES.map((item) => <SettingRow key={item.key} label={VIEW_CONTROLS[item.key].label} description={item.description}>
          <Switch label={VIEW_CONTROLS[item.key].label} checked={values[item.key] === "on"} change={(checked) => display.change(item.key, checked ? "on" : "off")} />
        </SettingRow>)}
      </div>
      {display.getSnapshot().error === "" ? null : <p className="form-error" role="alert">{display.getSnapshot().error}</p>}
    </SettingsSection>
    <SettingsSection title="Notifications" description="Saved in this browser.">
      <div className="rows">
        <SettingRow label="Notify when unfocused" description={note === undefined ? NOTIFY_DESCRIPTION : `${NOTIFY_DESCRIPTION} ${note}`}>
          <Switch label="Notify when unfocused" checked={notify.enabled} change={(checked) => { perform(async () => { if (checked) await notifier.enable(); else notifier.disable(); }); }} />
        </SettingRow>
      </div>
    </SettingsSection>
  </>;
}
