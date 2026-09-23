import { VIEW_CONTROLS, VIEW_KEYS, budgetFocus } from "./preferences.ts";
import { VIEW_PREFERENCES } from "./preferences.generated.ts";
import { Modal } from "./components.tsx";
import { useDisplay } from "./display_state.tsx";

export function DisplayControls({ budgets, close }: { budgets: readonly string[]; close: () => void }) {
  const display = useDisplay();
  const { values, error } = display.getSnapshot();
  const focused = budgetFocus(values.budget);
  return <Modal title="Display preferences" close={close}><p>Saved for this browser and shared across its tabs.</p>
    {VIEW_KEYS.map((key) => {
      const choices: readonly string[] = VIEW_PREFERENCES[key];
      const control = VIEW_CONTROLS[key];
      return <div className="preference-control" key={key}>
        {choices.includes("on") ? <label className="check"><input type="checkbox" checked={values[key] === "on"} onChange={(event) => display.change(key, event.target.checked ? "on" : "off")} />{control.label}</label>
          : <label className="field">{control.label}<select aria-label={control.label} value={key === "budget" ? focused.name ?? focused.scope : values[key]} onChange={(event) => display.change(key, event.target.value)}>{choices.filter((value) => value !== "toggle").map((value) => <option key={value} value={value}>{value === "warn" ? "Warnings only" : value === "auto" ? "Automatic" : value === "cap" ? "Budget cap" : value === "pace" ? "Budget pace" : value === "always" ? "Always" : "Off"}</option>)}{key === "budget" ? [...new Set([...budgets, ...(focused.name === null ? [] : [focused.name])])].map((name) => <option key={name} value={name}>{name}{budgets.includes(name) ? "" : " (unavailable)"}</option>) : null}</select></label>}
        {choices.includes("on") ? null : <button onClick={() => display.change(key, "toggle", budgets)}>Cycle {control.label.toLowerCase()}</button>}
      </div>;
    })}
    {focused.name === null ? null : <label className="field">Named budget scope<select aria-label="Named budget scope" value={focused.scope} onChange={(event) => display.change("budget", event.target.value === "auto" ? focused.name ?? "auto" : `${focused.name ?? ""}:${event.target.value}`)}><option value="auto">Automatic</option><option value="cap">Budget cap</option><option value="pace">Budget pace</option></select></label>}
    {error === "" ? null : <p role="alert">{error}<button onClick={() => display.save()}>Retry saving preferences</button></p>}
    <button onClick={() => display.reset()}>Reset display preferences</button>
  </Modal>;
}
