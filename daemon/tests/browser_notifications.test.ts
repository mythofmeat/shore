import { expect, test } from "bun:test";
import type { ConnectionUpdate } from "../src/browser/connection.ts";
import { NOTIFY_BODY_LIMIT, NOTIFY_KEY, Notifier, notificationBody, type NotificationApi, type NotifierOptions } from "../src/browser/notifications.ts";
import type { MessageOrigin } from "../src/protocol/MessageOrigin.ts";
import type { Role } from "../src/protocol/Role.ts";

type Grant = NotificationApi["permission"];

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

function fakeApi(permission: Grant, answer: Grant = "granted") {
  const shown: { title: string; body: string; tag: string; renotify: boolean; closed: boolean; onclick: (() => void) | null; close(): void }[] = [];
  const requests: number[] = [];
  class FakeNotification {
    static permission: Grant = permission;
    static requestPermission(): Promise<Grant> { requests.push(1); FakeNotification.permission = answer; return Promise.resolve(answer); }
    onclick: (() => void) | null = null;
    closed = false;
    constructor(readonly title: string, options: { body: string; tag: string; renotify: boolean }) {
      this.body = options.body;
      this.tag = options.tag;
      this.renotify = options.renotify;
      shown.push(this);
    }
    readonly body: string;
    readonly tag: string;
    readonly renotify: boolean;
    close(): void { this.closed = true; }
  }
  return { api: FakeNotification satisfies NotificationApi, shown, requests };
}

function setup(options: Partial<NotifierOptions> = {}, enabled = true) {
  const store = storage();
  if (enabled) store.data.set(NOTIFY_KEY, "true");
  let focused = false;
  const focusCalls: number[] = [];
  const fake = fakeApi("granted");
  const notifier = new Notifier({ storage: store, api: fake.api, focused: () => focused, focusWindow: () => { focusCalls.push(1); }, ...options });
  return { notifier, store, fake, focusCalls, focus: (value: boolean) => { focused = value; } };
}

function reply(content: string, role: Role = "assistant", origin: MessageOrigin | null = "assistant_reply"): ConnectionUpdate {
  return { kind: "frame", message: { type: "new_message", revision: 1, character: "nova", thread: "side", msg_id: `m-${content}`, role, content, images: [], content_blocks: [], timestamp: "2026-09-26T00:00:00Z", origin } };
}

const selection = { character: "nova", thread: "main" };

function failure(work: Promise<void>): Promise<string> {
  return work.then(() => "", (error: unknown) => String(error));
}

test("notifications are off until enabled and do nothing while off", () => {
  const { notifier, fake } = setup({}, false);
  expect(notifier.getSnapshot()).toEqual({ enabled: false, permission: "granted", unread: 0 });
  notifier.observe(reply("Hello"), selection);
  expect(fake.shown).toHaveLength(0);
  expect(notifier.getSnapshot().unread).toBe(0);
});

test("enabling asks for permission only while the browser hasn't decided, and remembers the choice", async () => {
  const store = storage();
  const undecided = fakeApi("default", "granted");
  const notifier = new Notifier({ storage: store, api: undecided.api, focused: () => false });
  await notifier.enable();
  expect(undecided.requests).toHaveLength(1);
  expect(store.data.get(NOTIFY_KEY)).toBe("true");
  expect(notifier.getSnapshot()).toEqual({ enabled: true, permission: "granted", unread: 0 });

  const blocked = fakeApi("denied");
  const denied = new Notifier({ storage: storage(), api: blocked.api, focused: () => false });
  await denied.enable();
  expect(blocked.requests).toHaveLength(0);
  expect(denied.getSnapshot()).toEqual({ enabled: true, permission: "denied", unread: 0 });
  denied.observe(reply("Hello"), selection);
  expect(blocked.shown).toHaveLength(0);
  expect(denied.getSnapshot().unread).toBe(1);

  const unavailable = new Notifier({ storage: storage(), api: null, focused: () => false });
  await unavailable.enable();
  unavailable.observe(reply("Hello"), selection);
  expect(unavailable.getSnapshot()).toEqual({ enabled: true, permission: "unavailable", unread: 1 });
});

test("a permission request that fails still refreshes the permission, and a setting the browser can't save is reported", async () => {
  const failing = fakeApi("default");
  failing.api.requestPermission = () => { failing.api.permission = "denied"; return Promise.reject(new Error("prompt failed")); };
  const notifier = new Notifier({ storage: storage(), api: failing.api, focused: () => false });
  expect(await failure(notifier.enable())).toContain("prompt failed");
  expect(notifier.getSnapshot()).toEqual({ enabled: true, permission: "denied", unread: 0 });

  const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
  const unsaved = new Notifier({ storage: full, api: null, focused: () => false });
  expect(await failure(unsaved.enable())).toContain("couldn’t save");
  expect(unsaved.getSnapshot().enabled).toBe(true);
  expect(() => { unsaved.disable(); }).toThrow("couldn’t save");
  expect(unsaved.getSnapshot().enabled).toBe(false);
});

test("a reply while the tab is unfocused shows one notification per conversation and counts as unread", () => {
  const { notifier, fake, focus } = setup();
  notifier.observe(reply("Hello there"), selection);
  expect(fake.shown).toHaveLength(1);
  expect(fake.shown[0]).toMatchObject({ title: "nova", body: "Hello there", tag: "shore:nova/side", renotify: true });
  expect(notifier.getSnapshot().unread).toBe(1);

  notifier.observe(reply("Still away"), selection);
  expect(fake.shown.map((item) => item.tag)).toEqual(["shore:nova/side", "shore:nova/side"]);
  expect(notifier.getSnapshot().unread).toBe(2);

  focus(true);
  notifier.observe(reply("Seen already"), selection);
  expect(fake.shown).toHaveLength(2);
  expect(notifier.getSnapshot().unread).toBe(2);
  notifier.markRead();
  expect(fake.shown.map((item) => item.closed)).toEqual([false, true]);
});

test("heartbeat messages and errors notify; user messages, empty replies and other updates don't", () => {
  const { notifier, fake } = setup();
  notifier.observe(reply("Checking in", "assistant", "autonomous"), selection);
  notifier.observe(reply("Legacy reply", "assistant", null), selection);
  notifier.observe({ kind: "frame", message: { type: "error", code: "provider_error", message: "Provider unavailable" } }, selection);
  expect(fake.shown.map((item) => [item.title, item.body, item.tag])).toEqual([
    ["nova", "Checking in", "shore:nova/side"], ["nova", "Legacy reply", "shore:nova/side"], ["nova", "Provider unavailable", "shore:nova/main"],
  ]);
  notifier.observe(reply("My question", "user", "user_input"), selection);
  notifier.observe(reply("   "), selection);
  notifier.observe({ kind: "frame", message: { type: "ping" } }, selection);
  notifier.observe({ kind: "status", status: "reconnecting", detail: "" }, selection);
  expect(fake.shown).toHaveLength(3);
  expect(notifier.getSnapshot().unread).toBe(3);
});

test("focusing the tab or clicking a notification clears what this tab showed", () => {
  const { notifier, fake, focusCalls } = setup();
  notifier.observe(reply("First"), selection);
  notifier.observe({ kind: "frame", message: { type: "error", code: "provider_error", message: "Second" } }, selection);
  fake.shown[1]?.onclick?.();
  expect(focusCalls).toHaveLength(1);
  expect(fake.shown.map((item) => item.closed)).toEqual([false, true]);
  notifier.markRead();
  expect(fake.shown.map((item) => item.closed)).toEqual([true, true]);
  expect(notifier.getSnapshot().unread).toBe(0);
});

test("disabling clears the count, and another tab's change is picked up on reload", () => {
  const { notifier, store, fake } = setup();
  notifier.observe(reply("Hello"), selection);
  notifier.disable();
  expect(store.data.get(NOTIFY_KEY)).toBe("false");
  expect(fake.shown[0]?.closed).toBe(true);
  expect(notifier.getSnapshot()).toMatchObject({ enabled: false, unread: 0 });
  store.data.set(NOTIFY_KEY, "true");
  notifier.reload();
  expect(notifier.getSnapshot().enabled).toBe(true);
});

test("notification bodies are trimmed and cut to the limit without splitting characters", () => {
  expect(notificationBody("  short  ")).toBe("short");
  const long = "🌊".repeat(NOTIFY_BODY_LIMIT + 5);
  const body = notificationBody(long);
  expect(Array.from(body)).toHaveLength(NOTIFY_BODY_LIMIT);
  expect(body.endsWith("🌊…")).toBe(true);
  expect(notificationBody("a".repeat(NOTIFY_BODY_LIMIT))).toHaveLength(NOTIFY_BODY_LIMIT);
  const family = "👨‍👩‍👧";
  const grouped = notificationBody(family.repeat(NOTIFY_BODY_LIMIT + 5));
  expect(grouped).toBe(`${family.repeat(NOTIFY_BODY_LIMIT - 1)}…`);
  expect(notificationBody(family.repeat(NOTIFY_BODY_LIMIT))).toBe(family.repeat(NOTIFY_BODY_LIMIT));
});

test("a browser that refuses to construct notifications still counts unread", () => {
  const store = storage();
  store.data.set(NOTIFY_KEY, "true");
  class Refusing {
    static permission: Grant = "granted";
    static requestPermission(): Promise<Grant> { return Promise.resolve("granted"); }
    onclick: (() => void) | null = null;
    closed = false;
    constructor() { throw new TypeError("Illegal constructor"); }
    close(): void { this.closed = true; }
  }
  const notifier = new Notifier({ storage: store, api: Refusing, focused: () => false });
  notifier.observe(reply("Hello"), selection);
  expect(notifier.getSnapshot().unread).toBe(1);
});
