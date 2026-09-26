import type { ConnectionUpdate } from "./connection.ts";

export const NOTIFY_KEY = "shore.notify";
export const NOTIFY_BODY_LIMIT = 200;

type GrantState = "default" | "granted" | "denied";
export type NotifyPermission = GrantState | "unavailable";
export interface NotifySnapshot { enabled: boolean; permission: NotifyPermission; unread: number }
export interface ShownNotification { onclick: (() => void) | null; close(): void }
export interface NotificationApi {
  readonly permission: GrantState;
  requestPermission(): Promise<GrantState>;
  new (title: string, options: { body: string; tag: string }): ShownNotification;
}
type NotifyStorage = Pick<Storage, "getItem" | "setItem">;
export interface NotifierOptions {
  storage?: NotifyStorage | null;
  api?: NotificationApi | null;
  focused?: () => boolean;
  focusWindow?: () => void;
}
export interface NotifySelection { character: string | null; thread: string | null }

function browserStorage(): NotifyStorage | null {
  try { return globalThis.localStorage; } catch { return null; }
}

function browserApi(): NotificationApi | null {
  const scope = globalThis as { isSecureContext?: boolean; Notification?: NotificationApi };
  return scope.isSecureContext === true ? scope.Notification ?? null : null;
}

function browserFocused(): boolean {
  return (globalThis as { document?: { hasFocus(): boolean } }).document?.hasFocus() ?? true;
}

function focusBrowser(): void {
  (globalThis as { focus?: () => void }).focus?.();
}

export function notificationBody(text: string): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  return chars.length <= NOTIFY_BODY_LIMIT ? trimmed : `${chars.slice(0, NOTIFY_BODY_LIMIT - 1).join("").trimEnd()}…`;
}

export class Notifier {
  readonly #storage: NotifyStorage | null;
  readonly #api: NotificationApi | null;
  readonly #focused: () => boolean;
  readonly #focusWindow: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #shown = new Set<ShownNotification>();
  #snapshot: NotifySnapshot;
  constructor(options: NotifierOptions = {}) {
    this.#storage = options.storage === undefined ? browserStorage() : options.storage;
    this.#api = options.api === undefined ? browserApi() : options.api;
    this.#focused = options.focused ?? browserFocused;
    this.#focusWindow = options.focusWindow ?? focusBrowser;
    this.#snapshot = { enabled: this.#stored(), permission: this.#permission(), unread: 0 };
  }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  getSnapshot = (): NotifySnapshot => this.#snapshot;
  #set(patch: Partial<NotifySnapshot>): void {
    const next = { ...this.#snapshot, ...patch };
    if (next.enabled === this.#snapshot.enabled && next.permission === this.#snapshot.permission && next.unread === this.#snapshot.unread) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
  #stored(): boolean {
    try { return this.#storage?.getItem(NOTIFY_KEY) === "true"; } catch { return false; }
  }
  #store(enabled: boolean): boolean {
    try { this.#storage?.setItem(NOTIFY_KEY, String(enabled)); return true; } catch { return false; }
  }
  #permission(): NotifyPermission {
    return this.#api === null ? "unavailable" : this.#api.permission;
  }
  #closeShown(): void {
    for (const shown of this.#shown) shown.close();
    this.#shown.clear();
  }
  async enable(): Promise<void> {
    this.#store(true);
    this.#set({ enabled: true });
    if (this.#api !== null && this.#api.permission === "default") await this.#api.requestPermission();
    this.#set({ permission: this.#permission() });
  }
  disable(): void {
    this.#store(false);
    this.#closeShown();
    this.#set({ enabled: false, unread: 0 });
  }
  reload(): void {
    const enabled = this.#stored();
    if (!enabled) this.#closeShown();
    this.#set({ enabled, permission: this.#permission(), unread: enabled ? this.#snapshot.unread : 0 });
  }
  focused(): void {
    this.#closeShown();
    this.#set({ permission: this.#permission(), unread: 0 });
  }
  observe(update: ConnectionUpdate, selection: NotifySelection): void {
    if (update.kind !== "frame") return;
    const message = update.message;
    if (message.type === "new_message") {
      if (message.role !== "assistant" || message.origin === "user_input" || message.content.trim() === "") return;
      this.#alert(message.character ?? selection.character, message.thread ?? selection.thread, message.content);
    } else if (message.type === "error") this.#alert(selection.character, selection.thread, message.message);
  }
  #alert(character: string | null, thread: string | null, body: string): void {
    if (!this.#snapshot.enabled || this.#focused()) return;
    this.#set({ unread: this.#snapshot.unread + 1 });
    const shown = this.#show(character ?? "Shore", { body: notificationBody(body), tag: `shore:${character ?? ""}/${thread ?? "main"}` });
    if (shown === undefined) return;
    this.#shown.add(shown);
    shown.onclick = () => { this.#focusWindow(); shown.close(); this.#shown.delete(shown); };
  }
  #show(title: string, options: { body: string; tag: string }): ShownNotification | undefined {
    const api = this.#api;
    if (api === null || api.permission !== "granted") return undefined;
    try { return new api(title, options); } catch { return undefined; }
  }
}
