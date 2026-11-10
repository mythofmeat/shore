import type { WebPreferences } from "../protocol/WebPreferences.ts";
import { validWebPreferences } from "./validators.generated.js";

type Values = WebPreferences["values"];
type LocalStorage = Pick<Storage, "getItem" | "setItem">;
export interface KeptKeys { readonly everywhere: readonly string[]; readonly perBrowser: readonly string[] }
export interface SettingsKeeper { list(): Promise<Values>; save(values: Values): Promise<void> }

async function ask(path: string, body?: WebPreferences): Promise<Values> {
  const response = await fetch(`/api/preferences${path}`, {
    method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error("The daemon didn’t take or return this page’s settings.");
  const value: unknown = await response.json();
  if (!validWebPreferences(value)) throw new Error("The daemon sent settings this page can’t read. Reload the page.");
  return value.values;
}

export const daemonSettings: SettingsKeeper = {
  list: async () => await ask("/list"),
  save: async (values) => { await ask("", { values }); },
};

export class KeptSettings implements LocalStorage {
  readonly #unsent = new Map<string, string>();
  #work: Promise<void> = Promise.resolve();
  constructor(readonly local: LocalStorage, readonly keys: KeptKeys, readonly keeper: SettingsKeeper, readonly connected: () => boolean, readonly changed: () => void) {}

  getItem = (key: string): string | null => this.local.getItem(key);

  setItem = (key: string, value: string): void => {
    this.local.setItem(key, value);
    this.wrote(key, value);
  };

  wrote = (key: string, value: string): void => {
    if (!this.keys.everywhere.includes(key) && !this.keys.perBrowser.includes(key)) return;
    this.#unsent.set(key, value);
    this.#queue(() => this.#send()).catch(() => {});
  };

  sync(): Promise<void> {
    return this.#queue(async () => { await this.#receive(); await this.#send(); });
  }

  #queue(work: () => Promise<void>): Promise<void> {
    const done = this.#work.then(work);
    this.#work = done.catch(() => {});
    return done;
  }

  async #receive(): Promise<void> {
    if (!this.connected()) return;
    const kept = await this.keeper.list();
    let changed = false;
    for (const key of [...this.keys.everywhere, ...this.keys.perBrowser]) {
      if (this.#unsent.has(key)) continue;
      const value = kept[key];
      const here = this.local.getItem(key);
      if (value === undefined) { if (here !== null) this.#unsent.set(key, here); }
      else if (here === null || (here !== value && this.keys.everywhere.includes(key))) { this.local.setItem(key, value); changed = true; }
    }
    if (changed) this.changed();
  }

  async #send(): Promise<void> {
    if (this.#unsent.size === 0 || !this.connected()) return;
    const sending = new Map(this.#unsent);
    await this.keeper.save(Object.fromEntries(sending));
    for (const [key, value] of sending) if (this.#unsent.get(key) === value) this.#unsent.delete(key);
  }
}
