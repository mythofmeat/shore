import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Icon } from "./icons.tsx";

export const APPEARANCE_KEY = "shore.appearance.v1";
const choices = { theme: ["dark", "light", "system"], accent: ["violet", "blue", "rose", "amber"], font: ["serif", "sans"], size: ["small", "medium", "large"], width: ["focused", "wide"] } as const;
type Appearance = { [K in keyof typeof choices]: (typeof choices)[K][number] };
const defaults: Appearance = { theme: "dark", accent: "violet", font: "serif", size: "medium", width: "focused" };
function readAppearance(): Appearance {
  const parsed: unknown = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "{}");
  const value = { ...defaults };
  if (typeof parsed !== "object" || parsed === null) return value;
  for (const key of Object.keys(choices) as (keyof Appearance)[]) {
    const saved: unknown = Reflect.get(parsed, key);
    if (typeof saved === "string" && (choices[key] as readonly string[]).includes(saved)) Object.assign(value, { [key]: saved });
  }
  return value;
}
type AppearanceState = { values: Appearance; error: string; change: <K extends keyof Appearance>(key: K, value: Appearance[K]) => void; reset: () => void; save: () => void };
const AppearanceContext = createContext<AppearanceState | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => {
    try { return { values: readAppearance(), error: "", dirty: false }; }
    catch { return { values: { ...defaults }, error: "Could not read appearance preferences. Your changes will stay in this tab until saved.", dirty: false }; }
  });
  const persist = (values: Appearance) => {
    try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(values)); setState({ values, error: "", dirty: false }); }
    catch { setState({ values, error: "Appearance preferences are not saved. Keep this tab open and retry saving.", dirty: true }); }
  };
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_KEY && event.key !== null) return;
      setState((previous) => {
        if (previous.dirty) return previous;
        try { return { values: readAppearance(), error: "", dirty: false }; }
        catch { return { ...previous, error: "Could not read changed appearance preferences. Your current choices are retained." }; }
      });
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const root = document.documentElement;
      for (const [key, value] of Object.entries(state.values)) root.dataset[key] = value;
      root.dataset["theme"] = state.values.theme === "system" ? media.matches ? "dark" : "light" : state.values.theme;
    };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.values]);
  return <AppearanceContext.Provider value={{ ...state, change: (key, value) => persist({ ...state.values, [key]: value }), reset: () => persist({ ...defaults }), save: () => persist(state.values) }}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceState {
  const value = useContext(AppearanceContext);
  if (value === null) throw new Error("Appearance preferences need a provider");
  return value;
}

export function AppearanceControls() {
  const { values, change, reset, error, save } = useAppearance();
  return <section className="appearance-controls" aria-label="Appearance">
    <h3>Make yourself at home</h3><p className="muted">Choose the atmosphere for your conversations.</p>
    <fieldset className="appearance-choice"><legend>Theme</legend><div className="theme-options">{choices.theme.map((theme) => <button type="button" key={theme} aria-pressed={values.theme === theme} onClick={() => change("theme", theme)}><Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"} />{theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}</button>)}</div></fieldset>
    <fieldset className="appearance-choice"><legend>Accent color</legend><div className="accent-options">{choices.accent.map((accent) => <button type="button" className={`accent-option accent-${accent}`} key={accent} aria-pressed={values.accent === accent} onClick={() => change("accent", accent)}><span aria-hidden="true" />{accent[0]?.toUpperCase()}{accent.slice(1)}</button>)}</div></fieldset>
    <div className="reading-options"><label className="field">Conversation font<select value={values.font} onChange={(event) => change("font", event.target.value as Appearance["font"])}><option value="serif">Literary · Serif</option><option value="sans">Modern · Sans serif</option></select></label><label className="field">Text size<select value={values.size} onChange={(event) => change("size", event.target.value as Appearance["size"])}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label><label className="field">Reading width<select value={values.width} onChange={(event) => change("width", event.target.value as Appearance["width"])}><option value="focused">Focused</option><option value="wide">Wide</option></select></label></div>
    <div className="appearance-preview"><span className="eyebrow">PREVIEW</span><p className="message-text">The room falls quiet as you step inside. “I was wondering when you’d arrive.”</p></div>
    {error === "" ? null : <p role="alert" className="error">{error}<button onClick={save}>Retry saving appearance</button></p>}
    <button className="quiet" onClick={reset}>Reset appearance</button>
  </section>;
}
