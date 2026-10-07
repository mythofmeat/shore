import type { ThemeRoot } from "./theme.ts";

export const FONT_SIZES = [
  { id: "small", label: "Small" },
  { id: "default", label: "Default" },
  { id: "large", label: "Large" },
  { id: "larger", label: "Larger" },
] as const;
export type FontSizeId = (typeof FONT_SIZES)[number]["id"];
export const FONT_SIZE_STORAGE_KEY = "shore.font-size";
export const DEFAULT_FONT_SIZE: FontSizeId = "default";

type FontSizeStorage = Pick<Storage, "getItem" | "setItem">;

export function isFontSizeId(value: unknown): value is FontSizeId {
  return FONT_SIZES.some((size) => size.id === value);
}

export function storedFontSize(storage: Pick<Storage, "getItem"> | undefined): FontSizeId {
  try {
    const value = storage?.getItem(FONT_SIZE_STORAGE_KEY);
    return isFontSizeId(value) ? value : DEFAULT_FONT_SIZE;
  } catch { return DEFAULT_FONT_SIZE; }
}

export function applyFontSize(size: FontSizeId, root: ThemeRoot): void {
  root.dataset["fontSize"] = size;
}

function browserStorage(): FontSizeStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export class FontSizeStore {
  #size: FontSizeId;
  #error = "";
  readonly #listeners = new Set<() => void>();
  constructor(readonly storage: FontSizeStorage | undefined = browserStorage(), readonly root: ThemeRoot | undefined = (globalThis as { document?: { documentElement: ThemeRoot } }).document?.documentElement) {
    this.#size = storedFontSize(storage);
    if (root !== undefined) applyFontSize(this.#size, root);
  }
  get size(): FontSizeId { return this.#size; }
  get error(): string { return this.#error; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): FontSizeId => this.#size;
  #set(size: FontSizeId, error: string): void {
    this.#size = size;
    this.#error = error;
    if (this.root !== undefined) applyFontSize(size, this.root);
    for (const listener of this.#listeners) listener();
  }
  select(size: FontSizeId): void {
    let error = "";
    try { this.storage?.setItem(FONT_SIZE_STORAGE_KEY, size); } catch { error = "This browser couldn't save the text size, so it will reset on reload."; }
    this.#set(size, error);
  }
  reload(): void {
    const size = storedFontSize(this.storage);
    if (size !== this.#size) this.#set(size, "");
  }
}
