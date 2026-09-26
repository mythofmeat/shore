import type { ConnectionUpdate } from "./connection.ts";

export const NOTIFY_KEY = "shore.notify";
export const NOTIFY_BODY_LIMIT = 200;
const UNSAVED = "This browser couldn’t save the notification setting, so it will reset on reload.";

type GrantState = "default" | "granted" | "denied";
export type NotifyPermission = GrantState | "unavailable";
export interface NotifySnapshot { enabled: boolean; permission: NotifyPermission; unread: number }
export interface ShownNotification { onclick: (() => void) | null; close(): void }
export interface NotificationApi {
  readonly permission: GrantState;
  requestPermission(): Promise<GrantState>;
  new (title: string, options: NotifyOptions): ShownNotification;
}
interface NotifyOptions { body: string; tag: string; renotify: boolean }
type NotifyStorage = Pick<Storage, "getItem" | "setItem">;
export interface NotifierOptions {
  storage?: NotifyStorage | null;
  api?: NotificationApi | null;
  focused?: () => boolean;
  focusWindow?: () => void;
}
export interface NotifySelection { character: string | null; thread: string | null }

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

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function notificationBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= NOTIFY_BODY_LIMIT) return trimmed;
  const kept: string[] = [];
  for (const { segment } of graphemes.segment(trimmed)) {
    if (kept.length === NOTIFY_BODY_LIMIT) return `${kept.slice(0, -1).join("").trimEnd()}…`;
    kept.push(segment);
  }
  return trimmed;
}

export class Notifier {
  readonly #storage: NotifyStorage | null;
  readonly #api: NotificationApi | null;
  readonly #focused: () => boolean;
  readonly #focusWindow: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #shown = new Map<string, ShownNotification>();
  #snapshot: NotifySnapshot;
  constructor(options: NotifierOptions = {}) {
    this.#storage = options.storage ?? null;
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
    for (const shown of this.#shown.values()) shown.close();
    this.#shown.clear();
  }
  async enable(): Promise<void> {
    const saved = this.#store(true);
    this.#set({ enabled: true });
    try { if (this.#api !== null && this.#api.permission === "default") await this.#api.requestPermission(); }
    finally { this.#set({ permission: this.#permission() }); }
    if (!saved) throw new Error(UNSAVED);
  }
  disable(): void {
    const saved = this.#store(false);
    this.#closeShown();
    this.#set({ enabled: false, unread: 0 });
    if (!saved) throw new Error(UNSAVED);
  }
  reload(): void {
    const enabled = this.#stored();
    if (!enabled) this.#closeShown();
    this.#set({ enabled, permission: this.#permission(), unread: enabled ? this.#snapshot.unread : 0 });
  }
  markRead(): void {
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
    const tag = `shore:${character ?? ""}/${thread ?? "main"}`;
    const shown = this.#show(character ?? "Shore", { body: notificationBody(body), tag, renotify: true });
    if (shown === undefined) return;
    this.#shown.set(tag, shown);
    shown.onclick = () => { this.#focusWindow(); shown.close(); if (this.#shown.get(tag) === shown) this.#shown.delete(tag); };
  }
  #show(title: string, options: NotifyOptions): ShownNotification | undefined {
    const api = this.#api;
    if (api === null || api.permission !== "granted") return undefined;
    try { return new api(title, options); } catch { return undefined; }
  }
}
