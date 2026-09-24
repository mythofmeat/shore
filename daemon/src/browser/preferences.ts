import { VIEW_PREFERENCES } from "./preferences.generated.ts";

export type ViewKey = keyof typeof VIEW_PREFERENCES;
export type ViewValues = Record<ViewKey, string>;
export const VIEW_CONTROLS = {
  timestamps: { label: "Timestamps", initial: "on" },
  thinking: { label: "Reasoning", initial: "on" },
  tools: { label: "Tool calls and results", initial: "on" },
  subagent: { label: "Subagent activity", initial: "on" },
  compaction: { label: "Compaction activity", initial: "on" },
  images: { label: "Inline images", initial: "on" },
  metadata: { label: "Message metadata", initial: "off" },
  usage: { label: "Usage display", initial: "off" },
  budget: { label: "Budget focus", initial: "auto" },
} satisfies Record<ViewKey, { label: string; initial: string }>;
export const VIEW_KEYS = Object.keys(VIEW_PREFERENCES) as ViewKey[];
export const PREFERENCE_STORAGE_KEY = "shore.view.v1";
export type BudgetScope = "auto" | "cap" | "pace";

export function budgetFocus(value: string): { name: string | null; scope: BudgetScope } {
  switch (value.trim().toLowerCase()) {
    case "auto": return { name: null, scope: "auto" };
    case "cap": case "budget": return { name: null, scope: "cap" };
    case "pace": return { name: null, scope: "pace" };
    default: {
      const [rawName, rawScope, extra] = value.trim().split(":");
      const name = rawScope === undefined ? value : rawName?.trim();
      const scope = rawScope?.trim().toLowerCase();
      if (!name?.trim() || extra !== undefined || (scope !== undefined && !["cap", "budget", "pace"].includes(scope))) throw new Error("Choose a budget and a valid budget scope");
      return { name, scope: scope === undefined ? "auto" : budgetFocus(scope).scope };
    }
  }
}

export function viewValue(key: ViewKey, value: string): boolean {
  if (value === "toggle") return false;
  if ((VIEW_PREFERENCES[key] as readonly string[]).includes(value)) return true;
  if (key !== "budget") return false;
  try { budgetFocus(value); return true; } catch { return false; }
}

export function defaultViews(): ViewValues {
  return Object.fromEntries(VIEW_KEYS.map((key) => [key, VIEW_CONTROLS[key].initial])) as ViewValues;
}

export function readViews(storage: Pick<Storage, "getItem">): ViewValues {
  const values = defaultViews();
  if (storage.getItem("shore.reasoning") === "false") values.thinking = "off";
  if (storage.getItem("shore.tools") === "false") values.tools = "off";
  for (const key of VIEW_KEYS) {
    const value = storage.getItem(`${PREFERENCE_STORAGE_KEY}.${key}`);
    if (value !== null) {
      if (!viewValue(key, value)) throw new Error(`Saved display preference is invalid: ${key}`);
      values[key] = value;
    }
  }
  return values;
}

export function cycleView(key: ViewKey, current: string, budgets: readonly string[] = []): string {
  const choices: string[] = VIEW_PREFERENCES[key].filter((value) => value !== "toggle");
  if (key === "budget" && budgets.length > 1) choices.push(...budgets);
  return choices[(choices.indexOf(current) + 1) % choices.length] ?? VIEW_CONTROLS[key].initial;
}

export class DisplayPreferences {
  #state: { values: ViewValues; error: string };
  #dirty = new Set<ViewKey>();
  #listeners = new Set<() => void>();
  constructor(readonly storage: Pick<Storage, "getItem" | "setItem">) {
    try { this.#state = { values: readViews(storage), error: "" }; }
    catch { this.#state = { values: defaultViews(), error: "Could not read saved display preferences. Changes will stay in this tab until they can be saved." }; }
  }
  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  option = (key: ViewKey): string => this.#state.values[key];
  #emit(): void { for (const listener of this.#listeners) listener(); }
  change(key: ViewKey, value: string, budgets: readonly string[] = []): void {
    const chosen = value === "toggle" ? cycleView(key, this.option(key), budgets) : value;
    if (!viewValue(key, chosen)) throw new Error(`Invalid display preference: ${key}`);
    this.#state = { ...this.#state, values: { ...this.#state.values, [key]: chosen } };
    this.#dirty.add(key);
    this.save();
  }
  save(): void {
    try {
      for (const key of this.#dirty) {
        this.storage.setItem(`${PREFERENCE_STORAGE_KEY}.${key}`, this.#state.values[key]);
        this.#dirty.delete(key);
      }
      const values = readViews(this.storage);
      this.#state = { values, error: "" };
    } catch { this.#state = { ...this.#state, error: "Display preferences are not saved. Keep this tab open and retry saving." }; }
    this.#emit();
  }
  reload(): void {
    try {
      const values = readViews(this.storage);
      for (const key of this.#dirty) values[key] = this.#state.values[key];
      this.#state = { values, error: this.#dirty.size === 0 ? "" : this.#state.error };
      this.#emit();
    } catch { this.#state = { ...this.#state, error: "Could not read changed display preferences. Current choices are retained in this tab." }; this.#emit(); }
  }
  reset(): void { this.#state = { values: defaultViews(), error: "" }; this.#dirty = new Set(VIEW_KEYS); this.save(); }
}
