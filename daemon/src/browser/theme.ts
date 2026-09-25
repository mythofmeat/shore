export const THEMES = [
  { id: "default", label: "Shore", description: "Dark with orange accents" },
  { id: "fog", label: "Sodium fog", description: "Grey-green haze, serif text, lamp-orange accents" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
export const THEME_STORAGE_KEY = "shore.theme";
export const DEFAULT_THEME: ThemeId = "default";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function storedTheme(storage: Pick<Storage, "getItem"> | undefined): ThemeId {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch { return DEFAULT_THEME; }
}

export function applyTheme(theme: ThemeId, root: { dataset: DOMStringMap }): void {
  root.dataset["theme"] = theme;
}

function browserStorage(): ThemeStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export class ThemeStore {
  #theme: ThemeId;
  #error = "";
  readonly #listeners = new Set<() => void>();
  constructor(readonly storage: ThemeStorage | undefined = browserStorage(), readonly root: { dataset: DOMStringMap } | undefined = globalThis.document?.documentElement) {
    this.#theme = storedTheme(storage);
    if (root !== undefined) applyTheme(this.#theme, root);
  }
  get theme(): ThemeId { return this.#theme; }
  get error(): string { return this.#error; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): ThemeId => this.#theme;
  #set(theme: ThemeId, error: string): void {
    this.#theme = theme;
    this.#error = error;
    if (this.root !== undefined) applyTheme(theme, this.root);
    for (const listener of this.#listeners) listener();
  }
  select(theme: ThemeId): void {
    let error = "";
    try { this.storage?.setItem(THEME_STORAGE_KEY, theme); } catch { error = "This browser couldn't save the theme, so it will reset on reload."; }
    this.#set(theme, error);
  }
  reload(): void {
    const theme = storedTheme(this.storage);
    if (theme !== this.#theme) this.#set(theme, "");
  }
}
