import type { WebPreferences } from "../protocol/WebPreferences.ts";
import { readState, writeState } from "../storage/store.ts";

export const PREFERENCE_LIMITS = { keys: 64, valueBytes: 16 * 1024, bodyBytes: 256 * 1024 } as const;
const STATE_FILE = "web_preferences.json";
const KEY = /^shore\.[a-z0-9][a-z0-9.-]{0,63}$/;

export class PreferenceError extends Error {}

export class PreferenceStore {
  #values: Map<string, string>;
  constructor(readonly dataDir?: string) {
    const saved = dataDir === undefined ? undefined : readState(dataDir, STATE_FILE);
    this.#values = new Map(saved === undefined ? [] : Object.entries(JSON.parse(saved) as Record<string, string>));
  }

  list(): WebPreferences {
    return { values: Object.fromEntries(this.#values) };
  }

  save(changes: WebPreferences): WebPreferences {
    const next = new Map(this.#values);
    for (const [key, value] of Object.entries(changes.values)) {
      if (!KEY.test(key)) throw new PreferenceError(`${key} is not a setting the web UI keeps`);
      if (Buffer.byteLength(value) > PREFERENCE_LIMITS.valueBytes) throw new PreferenceError(`${key} is too long to keep`);
      next.set(key, value);
    }
    if (next.size > PREFERENCE_LIMITS.keys) throw new PreferenceError("Too many web UI settings to keep");
    if (this.dataDir !== undefined) writeState(this.dataDir, STATE_FILE, JSON.stringify(Object.fromEntries(next)));
    this.#values = next;
    return this.list();
  }
}
