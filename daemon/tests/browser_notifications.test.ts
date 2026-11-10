import { describe, expect, test } from "bun:test";

import type { ConnectionUpdate } from "../src/browser/connection.ts";
import { NOTIFY_KEY, Notifier, notificationBody, type NotificationApi } from "../src/browser/notifications.ts";

const LIMIT = 200;
import type { ImageRef } from "../src/protocol/ImageRef.ts";

interface Shown { title: string; options: { body: string; tag: string; renotify: boolean; icon?: string; image?: string }; closed: number; onclick: (() => void) | null; close(): void }

function notifications(permission: "default" | "granted" | "denied" = "granted", answer: "default" | "granted" | "denied" = "granted") {
  const shown: Shown[] = [];
  let requests = 0;
  let failing = false;
  const api = class {
    static permission: "default" | "granted" | "denied" = permission;
    static async requestPermission(): Promise<"default" | "granted" | "denied"> { requests += 1; api.permission = answer; return answer; }
    onclick: (() => void) | null = null;
    closed = 0;
    constructor(readonly title: string, readonly options: Shown["options"]) {
      if (failing) throw new Error("the browser refused");
      shown.push(this);
    }
    close(): void { this.closed += 1; }
  };
  return { api: api as unknown as NotificationApi, shown, requests: () => requests, fail: () => { failing = true; }, setPermission: (value: typeof permission) => { api.permission = value; } };
}

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let broken = false;
  return {
    values,
    break: () => { broken = true; },
    getItem: (key: string) => { if (broken) throw new Error("quota"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (broken) throw new Error("quota"); values.set(key, value); },
  };
}

function reply(content: string, overrides: Record<string, unknown> = {}): ConnectionUpdate {
  return { kind: "frame", message: { type: "new_message", revision: 1, msg_id: "m_1", role: "assistant", content, images: [], content_blocks: [], timestamp: "2026-11-10T00:00:00Z", ...overrides } };
}

const selection = { character: "ada", thread: "main" };

describe("a notification's text", () => {
  test("is trimmed, and a long one is cut to the limit by whole characters with an ellipsis", () => {
    expect(notificationBody("  hello  ")).toBe("hello");
    const exact = "a".repeat(LIMIT);
    expect(notificationBody(exact)).toBe(exact);
    expect(notificationBody(`${"a".repeat(LIMIT)}b`)).toBe(`${"a".repeat(LIMIT - 1)}…`);
    expect(notificationBody(`${"a".repeat(LIMIT - 2)} ${"b".repeat(9)}`), "no space before the ellipsis").toBe(`${"a".repeat(LIMIT - 2)}…`);
    const flags = "🇳🇿".repeat(LIMIT + 1);
    expect(notificationBody(flags), "a flag is one character").toBe(`${"🇳🇿".repeat(LIMIT - 1)}…`);
    expect(notificationBody("é".normalize("NFD").repeat(LIMIT))).toBe("é".normalize("NFD").repeat(LIMIT));
  });
});

describe("turning notifications on and off", () => {
  test("the setting is read from storage, and permission is asked for only when the browser has not decided", async () => {
    const saved = storage({ [NOTIFY_KEY]: "true" });
    const browser = notifications("default", "granted");
    const notifier = new Notifier({ storage: saved, api: browser.api, focused: () => false });
    expect(notifier.getSnapshot()).toEqual({ enabled: true, permission: "default", unread: 0 });
    await notifier.enable();
    expect(saved.values.get(NOTIFY_KEY)).toBe("true");
    expect(browser.requests()).toBe(1);
    expect(notifier.getSnapshot().permission).toBe("granted");
    await notifier.enable();
    expect(browser.requests(), "already decided").toBe(1);
    notifier.disable();
    expect(saved.values.get(NOTIFY_KEY)).toBe("false");
    expect(notifier.getSnapshot().enabled).toBe(false);
    expect(new Notifier({ storage: storage({ [NOTIFY_KEY]: "yes" }), api: null }).getSnapshot()).toEqual({ enabled: false, permission: "unavailable", unread: 0 });
    expect(new Notifier({ api: null }).getSnapshot().enabled).toBe(false);
    expect(new Notifier().getSnapshot().permission, "no secure browser context here").toBe("unavailable");
  });

  test("a setting the browser cannot save still applies for now and says it will not last", async () => {
    const saved = storage();
    saved.break();
    const notifier = new Notifier({ storage: saved, api: notifications().api, focused: () => false });
    expect(notifier.getSnapshot().enabled, "unreadable storage reads as off").toBe(false);
    expect(await notifier.enable().then(() => "", (error: unknown) => String(error))).toContain("will reset on reload");
    expect(notifier.getSnapshot().enabled).toBe(true);
    expect(() => notifier.disable()).toThrow("will reset on reload");
    expect(notifier.getSnapshot().enabled).toBe(false);
    const browser = notifications("default", "denied");
    const asked = new Notifier({ storage: null, api: browser.api });
    await asked.enable();
    expect(asked.getSnapshot()).toEqual({ enabled: true, permission: "denied", unread: 0 });
  });

  test("a reload follows the stored setting, dropping what is shown when it was turned off elsewhere", () => {
    const saved = storage({ [NOTIFY_KEY]: "true" });
    const browser = notifications();
    const notifier = new Notifier({ storage: saved, api: browser.api, focused: () => false });
    notifier.observe(reply("hi"), selection);
    browser.setPermission("denied");
    notifier.reload();
    expect(notifier.getSnapshot()).toEqual({ enabled: true, permission: "denied", unread: 1 });
    expect(browser.shown.map((item) => item.closed)).toEqual([0]);
    saved.values.set(NOTIFY_KEY, "false");
    notifier.reload();
    expect(notifier.getSnapshot()).toEqual({ enabled: false, permission: "denied", unread: 0 });
    expect(browser.shown.map((item) => item.closed)).toEqual([1]);
  });
});

describe("what gets a notification", () => {
  test("a reply or an error while the page is in the background, titled and tagged by its conversation", () => {
    const browser = notifications();
    const notifier = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: browser.api, focused: () => false });
    notifier.observe(reply("  hello there  ", { character: "bo", thread: "story" }), selection);
    notifier.observe(reply("from the selected one"), selection);
    notifier.observe({ kind: "frame", message: { type: "error", code: "provider_error", message: "the provider is down" } }, { character: null, thread: null });
    expect(browser.shown.map((item) => [item.title, item.options])).toEqual([
      ["bo", { body: "hello there", tag: "shore:bo/story", renotify: true }],
      ["ada", { body: "from the selected one", tag: "shore:ada/main", renotify: true }],
      ["Shore", { body: "the provider is down", tag: "shore:/main", renotify: true }],
    ]);
    expect(notifier.getSnapshot().unread).toBe(3);
  });

  test("a reply's first sent picture becomes its image, and its text names the picture", () => {
    const browser = notifications();
    const notifier = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: browser.api, focused: () => false });
    const images: ImageRef[] = [
      { path: "/m/a.png", embed: "![[a.png]]", name: "a.png", data: "iVBORw0K", problem: "too large" },
      { path: "/m/b.png", embed: "![[b.png]]", name: "b.png", data: "iVBORbbbb" },
      { path: "/m/c.png", data: "iVBORcccc" },
    ];
    notifier.observe(reply("look ![[b.png]]", { images }), selection);
    expect(browser.shown[0]?.options).toEqual({ body: "look [picture: b.png]", tag: "shore:ada/main", renotify: true, icon: "data:image/png;base64,iVBORbbbb", image: "data:image/png;base64,iVBORbbbb" });
    notifier.observe(reply("no data", { images: [{ path: "/m/d.png", embed: "![[d.png]]", name: "d.png" }] }), selection);
    expect(browser.shown[1]?.options.icon).toBeUndefined();
  });

  test("nothing for the user's own words, an empty reply, other frames, a focused page or notifications turned off", () => {
    const browser = notifications();
    let focused = false;
    const notifier = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: browser.api, focused: () => focused });
    notifier.observe(reply("mine", { role: "user" }), selection);
    notifier.observe(reply("echoed", { origin: "user_input" }), selection);
    notifier.observe(reply("   "), selection);
    notifier.observe({ kind: "frame", message: { type: "ping" } }, selection);
    notifier.observe({ kind: "status", status: "ready", detail: "" }, selection);
    focused = true;
    notifier.observe(reply("seen already"), selection);
    focused = false;
    notifier.disable();
    notifier.observe(reply("muted"), selection);
    expect(browser.shown).toEqual([]);
    expect(notifier.getSnapshot().unread).toBe(0);
  });

  test("without permission, or when the browser refuses, a reply only counts as unread", () => {
    const denied = notifications("denied");
    const quiet = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: denied.api, focused: () => false });
    quiet.observe(reply("hi"), selection);
    expect([denied.shown.length, quiet.getSnapshot().unread]).toEqual([0, 1]);
    const refusing = notifications();
    refusing.fail();
    const failing = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: refusing.api, focused: () => false });
    failing.observe(reply("hi"), selection);
    expect([refusing.shown.length, failing.getSnapshot().unread]).toEqual([0, 1]);
    const unavailable = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: null, focused: () => false });
    unavailable.observe(reply("hi"), selection);
    expect(unavailable.getSnapshot().unread).toBe(1);
  });

  test("clicking a notification brings the page forward and closes it, and reading closes the rest", () => {
    const browser = notifications();
    let focusedWindow = 0;
    const notifier = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: browser.api, focused: () => false, focusWindow: () => { focusedWindow += 1; } });
    notifier.observe(reply("first"), selection);
    notifier.observe(reply("second"), selection);
    notifier.observe(reply("elsewhere", { thread: "story" }), selection);
    const [first, second, elsewhere] = browser.shown;
    first?.onclick?.();
    expect([focusedWindow, first?.closed]).toEqual([1, 1]);
    second?.onclick?.();
    expect(second?.closed).toBe(1);
    notifier.markRead();
    expect([first?.closed, second?.closed, elsewhere?.closed], "a clicked one is not closed again").toEqual([1, 1, 1]);
    expect(notifier.getSnapshot().unread).toBe(0);
    notifier.markRead();
    expect(elsewhere?.closed, "a closed one is forgotten").toBe(1);
  });

  test("clicking an older notification leaves the newer one for its conversation to be closed", () => {
    const browser = notifications();
    const notifier = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: browser.api, focused: () => false, focusWindow: () => {} });
    notifier.observe(reply("first"), selection);
    notifier.observe(reply("second"), selection);
    const [first, second] = browser.shown;
    first?.onclick?.();
    notifier.markRead();
    expect([first?.closed, second?.closed]).toEqual([1, 1]);
  });

  test("turning notifications off closes the ones showing", () => {
    const browser = notifications();
    const notifier = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: browser.api, focused: () => false });
    notifier.observe(reply("hi"), selection);
    notifier.disable();
    expect(browser.shown.map((item) => item.closed)).toEqual([1]);
  });

  test("by default the page's own focus and window are used, and notifications only in a secure page", () => {
    const browser = notifications();
    const scope = globalThis as unknown as Record<string, unknown>;
    const notifier = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }), api: browser.api });
    notifier.observe(reply("while focused"), selection);
    expect(notifier.getSnapshot().unread, "with no page to ask, it counts as focused").toBe(0);
    let focused = 0;
    Object.assign(scope, { document: { hasFocus: () => false }, focus: () => { focused += 1; }, isSecureContext: true, Notification: browser.api });
    try {
      const background = new Notifier({ storage: storage({ [NOTIFY_KEY]: "true" }) });
      expect(background.getSnapshot().permission).toBe("granted");
      background.observe(reply("while away"), selection);
      expect(background.getSnapshot().unread).toBe(1);
      browser.shown.at(-1)?.onclick?.();
      expect(focused).toBe(1);
      scope["isSecureContext"] = false;
      expect(new Notifier().getSnapshot().permission).toBe("unavailable");
      scope["isSecureContext"] = true;
      scope["Notification"] = undefined;
      expect(new Notifier().getSnapshot().permission).toBe("unavailable");
    } finally {
      for (const key of ["document", "focus", "isSecureContext", "Notification"]) Reflect.deleteProperty(scope, key);
    }
  });

  test("listeners hear each change once, and only real changes", () => {
    const notifier = new Notifier({ storage: storage(), api: notifications().api, focused: () => false });
    let heard = 0;
    const stop = notifier.subscribe(() => { heard += 1; });
    notifier.markRead();
    expect(heard, "nothing changed").toBe(0);
    notifier.disable();
    expect(heard, "already off").toBe(0);
    notifier.reload();
    expect(heard).toBe(0);
    void notifier.enable();
    expect(heard).toBe(1);
    stop();
    notifier.disable();
    expect(heard).toBe(1);
  });
});
