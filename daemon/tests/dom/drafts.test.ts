import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import type { ImageUpload } from "../../src/protocol/ImageUpload.ts";
import { useDom } from "./dom.ts";

useDom();

type Drafts = typeof import("../../src/browser/drafts.ts");

class Locks {
  readonly held = new Set<string>();
  readonly #waiting = new Map<string, (() => void)[]>();

  async request<T>(name: string, options: { ifAvailable?: boolean } | ((lock: { name: string } | null) => Promise<T>), callback?: (lock: { name: string } | null) => Promise<T>): Promise<T> {
    const work = typeof options === "function" ? options : callback;
    if (work === undefined) throw new Error("a lock needs a callback");
    if (this.held.has(name)) {
      if (typeof options !== "function" && options.ifAvailable === true) return await work(null);
      await new Promise<void>((resolve) => { this.#waiting.set(name, [...(this.#waiting.get(name) ?? []), resolve]); });
    }
    this.held.add(name);
    try { return await work({ name }); } finally {
      this.held.delete(name);
      const [next, ...rest] = this.#waiting.get(name) ?? [];
      this.#waiting.set(name, rest);
      next?.();
    }
  }

  async query(): Promise<{ held: { name: string }[] }> { return await Promise.resolve({ held: [...this.held].map((name) => ({ name })) }); }
}

function memory(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => { values.clear(); },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

let tabs = 0;
let locks: Locks | undefined;
const restores: (() => void)[] = [];

function swap(target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => { if (original === undefined) Reflect.deleteProperty(target, key); else Object.defineProperty(target, key, original); });
}

beforeEach(() => {
  swap(globalThis, "sessionStorage", memory());
  swap(globalThis, "indexedDB", new IDBFactory());
  locks = new Locks();
  swap(navigator, "locks", locks);
  localStorage.clear();
});

afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

async function tab(session: Storage = memory()) {
  tabs += 1;
  const drafts = await import(`../../src/browser/drafts.ts?tab=${String(tabs)}`) as Drafts;
  const enter = () => { Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: session }); };
  return {
    session,
    run: async <T>(work: (module: Drafts) => Promise<T> | T): Promise<T> => { enter(); return await work(drafts); },
  };
}

const image = (name: string, data = "AAAA"): ImageUpload => ({ filename: name, mime_type: "image/png", data });

async function rows(store: string): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open("shore-drafts", 2);
    request.onsuccess = () => {
      const db = request.result;
      const all = db.transaction(store).objectStore(store).getAll();
      all.onsuccess = () => { db.close(); resolve(all.result as unknown[]); };
      all.onerror = () => { db.close(); reject(all.error ?? new Error("read failed")); };
    };
    request.onerror = () => { reject(request.error ?? new Error("open failed")); };
  });
}

describe("a conversation's draft", () => {
  test("is the same object for the same conversation, starts empty, and comes back in the same tab after a reload", async () => {
    const first = await tab();
    const text = await first.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      expect(browserDraft("ada/main")).toBe(draft);
      expect(browserDraft("ada/side")).not.toBe(draft);
      expect(await draft.load()).toEqual({ text: "", images: [] });
      await draft.save({ text: "hello", images: [], options: { stream: false } });
      return draft.current;
    });
    expect(text).toEqual({ text: "hello", images: [], options: { stream: false } });
    const reloaded = await tab(first.session);
    expect(await reloaded.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "hello", images: [], options: { stream: false } });
    const elsewhere = await tab();
    expect(await elsewhere.run(async ({ browserDraft }) => await browserDraft("ada/main").load()), "another tab starts its own draft").toEqual({ text: "", images: [] });
  });

  test("keeps its pictures beside it, reusing them while unchanged and dropping ones nothing uses", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      const images = [image("a.png")];
      await draft.save({ text: "one", images });
      expect(await rows("attachments")).toEqual([images]);
      await draft.save({ text: "two", images });
      expect(await rows("attachments")).toHaveLength(1);
      await draft.save({ text: "three", images: [image("b.png")] });
      expect(await rows("attachments")).toEqual([[image("b.png")]]);
      await draft.save({ text: "four", images: [] });
      expect(await rows("attachments")).toEqual([]);
      expect(await rows("drafts")).toMatchObject([{ conversation: "ada/main", text: "four", attachment: null, imageCount: 0, revision: 4 }]);
    });
    const reloaded = await tab(page.session);
    expect(await reloaded.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "four", images: [] });
  });

  test("an emptied draft is removed, and a new one starts after it", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.save({ text: "hello", images: [image("a.png")] });
      await draft.save({ text: "", images: [] });
      expect(await rows("drafts")).toEqual([]);
      expect(await rows("attachments")).toEqual([]);
      await draft.save({ text: "again", images: [] });
      expect(await rows("drafts")).toMatchObject([{ text: "again", revision: 1 }]);
    });
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/side");
      await draft.load();
      await draft.save({ text: "", images: [], options: { model: "opus" } });
      expect(await rows("drafts")).toHaveLength(2);
    });
  });

  test("an old draft from before draft storage moves in once, unless the conversation already has drafts", async () => {
    localStorage.setItem("shore.draft.v1.ada/main", "from before");
    const page = await tab();
    expect(await page.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "from before", images: [] });
    expect(localStorage.getItem("shore.draft.v1.ada/main")).toBeNull();
    expect(await rows("drafts")).toMatchObject([{ text: "from before" }]);

    localStorage.setItem("shore.draft.v1.ada/main", "older still");
    const other = await tab();
    expect(await other.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "", images: [] });
    expect(localStorage.getItem("shore.draft.v1.ada/main")).toBe("older still");
  });

  test("two tabs editing one draft keep both versions rather than overwriting either", async () => {
    const first = await tab();
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "start", images: [] }); });
    const copy = memory();
    copy.setItem("shore.draft.owner.v2.ada/main", first.session.getItem("shore.draft.owner.v2.ada/main") ?? "");
    const second = await tab(copy);
    await second.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); });
    await first.run(async ({ browserDraft }) => { await browserDraft("ada/main").save({ text: "first edit", images: [] }); });
    await second.run(async ({ browserDraft }) => { await browserDraft("ada/main").save({ text: "second edit", images: [] }); });
    expect((await rows("drafts") as { text: string; revision: number }[]).map((row) => `${row.text}@${String(row.revision)}`).sort((a, b) => a.localeCompare(b))).toEqual(["first edit@2", "second edit@1"]);
  });
});

describe("a tab opened as a copy of another", () => {
  test("gets its own copy of the drafts the first tab owns, while the first keeps its own", async () => {
    const first = await tab();
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "mine", images: [image("a.png")] }); });
    const copied = memory();
    for (const key of ["shore.draft.tab", "shore.draft.owner.v2.ada/main"]) copied.setItem(key, first.session.getItem(key) ?? "");
    const clone = await tab(copied);
    expect(await clone.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "mine", images: [image("a.png")] });
    expect(copied.getItem("shore.draft.tab")).not.toBe(first.session.getItem("shore.draft.tab"));
    expect(copied.getItem("shore.draft.owner.v2.ada/main")).not.toBe(first.session.getItem("shore.draft.owner.v2.ada/main"));
    expect(await rows("drafts")).toHaveLength(2);
    expect(await rows("attachments")).toHaveLength(2);
    await clone.run(async ({ browserDraft }) => { await browserDraft("ada/main").save({ text: "the copy's", images: [] }); });
    const reloaded = await tab(first.session);
    expect(await reloaded.run(async ({ browserDraft }) => await browserDraft("ada/main").load()), "the first tab's draft is untouched").toEqual({ text: "mine", images: [image("a.png")] });
  });

  test("a tab that comes back after closing is the same tab again", async () => {
    const first = await tab();
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "mine", images: [] }); });
    locks?.held.clear();
    const back = await tab(first.session);
    const before = first.session.getItem("shore.draft.tab");
    expect(await back.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "mine", images: [] });
    expect(first.session.getItem("shore.draft.tab")).toBe(before);
    expect(await rows("drafts")).toHaveLength(1);
  });

  test("without locks every tab is treated as a copy, so a reloaded draft is copied rather than shared", async () => {
    swap(navigator, "locks", undefined);
    const first = await tab();
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "mine", images: [] }); });
    const reloaded = await tab(first.session);
    expect(await reloaded.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "mine", images: [] });
    expect(await rows("drafts")).toHaveLength(2);
    expect(await reloaded.run(async ({ withSendingLock }) => await withSendingLock(async () => await Promise.resolve("ran")))).toBe("ran");
  });
});

describe("a sent message", () => {
  test("is kept until the daemon has it, and its draft is cleared but keeps its options", async () => {
    const page = await tab();
    const sent = await page.run(async ({ browserDraft, unclaimedSending }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.send("r_1", { text: "hello", images: [image("a.png")], options: { model: "opus" } });
      expect(draft.current).toEqual({ text: "", images: [], options: { model: "opus" } });
      expect(await unclaimedSending(), "a message this tab is still sending is its own").toEqual([]);
      return await rows("sending");
    });
    expect(sent).toMatchObject([{ rid: "r_1", conversation: "ada/main", text: "hello", images: [image("a.png")] }]);
    expect(typeof (sent[0] as { tab: unknown }).tab).toBe("string");
    expect(await rows("drafts")).toMatchObject([{ text: "", options: { model: "opus" } }]);
    await page.run(async ({ handOverSending, unclaimedSending }) => {
      handOverSending("r_1");
      expect((await unclaimedSending()).map((message) => message.rid)).toEqual(["r_1"]);
    });
    await page.run(async ({ forgetSending, unclaimedSending }) => {
      await forgetSending("r_1");
      expect(await unclaimedSending()).toEqual([]);
    });
  });

  test("another open tab's messages are left to it, and a closed tab's are anyone's", async () => {
    const sender = await tab();
    await sender.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.send("r_1", { text: "hello", images: [] }); });
    const other = await tab();
    expect(await other.run(async ({ unclaimedSending }) => await unclaimedSending())).toEqual([]);
    locks?.held.delete(`shore.draft.tab.${sender.session.getItem("shore.draft.tab") ?? ""}`);
    expect((await other.run(async ({ unclaimedSending }) => await unclaimedSending())).map((message) => message.rid)).toEqual(["r_1"]);
  });

  test("a message from a page without locks, or with no tab, is anyone's", async () => {
    swap(navigator, "locks", undefined);
    const sender = await tab();
    await sender.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.send("r_1", { text: "hello", images: [] }); });
    const other = await tab();
    expect((await other.run(async ({ unclaimedSending }) => await unclaimedSending())).map((message) => message.rid)).toEqual(["r_1"]);
  });

  test("that failed goes back into its draft ahead of what was typed since, once", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.send("r_1", { text: "hello", images: [image("a.png")] });
      await draft.save({ text: "next thought", images: [image("b.png")] });
      expect(await draft.restore("r_1")).toEqual({ restored: true, dropped: 0 });
      expect(draft.current).toEqual({ text: "hello\n\nnext thought", images: [image("a.png"), image("b.png")] });
      expect(await rows("sending")).toEqual([]);
      expect(await draft.restore("r_1")).toEqual({ restored: false, dropped: 0 });
      expect(draft.current?.text).toBe("hello\n\nnext thought");
    });
  });

  test("a message another tab already put back is not put back twice", async () => {
    const first = await tab();
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.send("r_1", { text: "hello", images: [] }); });
    const second = await tab();
    await second.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "typed", images: [] }); });
    await first.run(async ({ browserDraft }) => { expect(await browserDraft("ada/main").restore("r_1")).toEqual({ restored: true, dropped: 0 }); });
    await second.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      expect(await draft.restore("r_1", { text: "hello", images: [] })).toEqual({ restored: true, dropped: 0 });
      expect(draft.current?.text, "a copy kept in the page still comes back").toBe("hello\n\ntyped");
    });
  });

  test("a message another tab takes while this one puts it back leaves this draft as it was, unless it was edited since", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft, forgetSending }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.send("r_1", { text: "hello", images: [] });
      await draft.save({ text: "typed", images: [] });
      let taken = false;
      const leave = draft.subscribe(() => { if (!taken) { taken = true; void forgetSending("r_1"); } });
      expect(await draft.restore("r_1")).toEqual({ restored: false, dropped: 0 });
      leave();
      expect(draft.current).toEqual({ text: "typed", images: [] });
      await draft.send("r_2", { text: "again", images: [] });
      let edited = false;
      draft.subscribe(() => { if (!edited) { edited = true; void forgetSending("r_2"); void draft.save({ text: "newer", images: [] }); } });
      expect(await draft.restore("r_2")).toEqual({ restored: false, dropped: 0 });
      expect(draft.current).toEqual({ text: "newer", images: [] });
    });
  });

  test("a message this tab gave up on is anyone's again, however the attempt ended", async () => {
    const page = await tab();
    const elsewhere = await (await tab()).run((module) => module);
    await elsewhere.unclaimedSending();
    const message = (rid: string) => ({ rid, conversation: "ada/main", tab: null, text: rid, images: [], sent: 0 });
    await page.run(async ({ browserDraft, unclaimedSending }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.send("r_gone", { text: "x", images: [] });
      await draft.send("r_back", { text: "y", images: [] });
      await draft.send("r_taken", { text: "z", images: [] });
      await elsewhere.forgetSending("r_gone");
      expect(await draft.restore("r_gone")).toEqual({ restored: false, dropped: 0 });
      expect(await draft.restore("r_back")).toEqual({ restored: true, dropped: 0 });
      let taken = false;
      draft.subscribe(() => { if (!taken) { taken = true; void elsewhere.forgetSending("r_taken"); } });
      expect(await draft.restore("r_taken")).toEqual({ restored: false, dropped: 0 });
      await seed("sending", [[message("r_gone"), undefined], [message("r_back"), undefined], [message("r_taken"), undefined]]);
      expect((await unclaimedSending()).map((item) => item.rid).sort((a, b) => a.localeCompare(b))).toEqual(["r_back", "r_gone", "r_taken"]);
    });
  });

});

async function seed(store: string, entries: [unknown, IDBValidKey | undefined][]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("shore-drafts", 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts", { keyPath: "id" });
      request.result.createObjectStore("attachments");
      request.result.createObjectStore("sending", { keyPath: "rid" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(store, "readwrite");
      for (const [value, key] of entries) tx.objectStore(store).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error("seed failed")); };
    };
    request.onerror = () => { reject(request.error ?? new Error("open failed")); };
  });
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, conversation: "bo/main", revision: 1, text: id, attachment: null, imageCount: 0, bytes: 0, updated: 0, ...extra });

describe("draft storage limits", () => {
  test("holds 64 drafts, and asks for one to be discarded before a 65th", async () => {
    await seed("drafts", Array.from({ length: 63 }, (_, index) => [row(`d_${String(index)}`), undefined]));
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.save({ text: "the 64th", images: [] });
      await draft.save({ text: "still the 64th", images: [] });
    });
    const other = await tab();
    expect(await other.run(async ({ browserDraft }) => { const draft = browserDraft("ada/side"); await draft.load(); return await draft.save({ text: "65th", images: [] }).then(() => "", (error: unknown) => (error as Error).message); }))
      .toBe("Draft storage is full. Discard a saved draft to save this one; your current text and attachments remain open.");
    expect(await other.run(({ browserDraft }) => browserDraft("ada/side").current), "what was typed stays open").toEqual({ text: "65th", images: [] });
  });

  test("holds 128 MiB of drafts in all, counting text, options and pictures at two bytes a character", async () => {
    const max = 128 * 1024 * 1024;
    const content = { text: "ab", images: [{ filename: "p.png", mime_type: "image/png", data: "AAAA" }], options: { m: 1 } };
    const own = (2 + 5 + 9 + 4 + JSON.stringify({ m: 1 }).length) * 2;
    await seed("drafts", [[row("big", { bytes: max - own }), undefined]]);
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.save(content);
      expect(await rows("drafts")).toHaveLength(2);
      expect(await draft.save({ ...content, text: "abc" }).then(() => "", (error: unknown) => (error as Error).message)).toMatch(/^Draft storage is full/);
      expect(await draft.save({ ...content, images: [{ filename: "p.png", data: "AAAA" }], text: "abcdefghijk" }).then(() => "", (error: unknown) => (error as Error).message), "a picture with no type counts none").toBe("");
    });
  });

  test("refuses a single draft over 128 MiB before touching storage", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      const half = 64 * 1024 * 1024;
      expect(await draft.save({ text: "x".repeat(half - 1), images: [] }).then(() => "", (error: unknown) => (error as Error).message)).toBe("This draft exceeds the 128 MiB browser storage limit");
      expect(await draft.save({ text: "x".repeat(half - 2), images: [] }).then(() => "", (error: unknown) => (error as Error).message), "the empty options still count").toBe("");
      await draft.save({ text: "", images: [] });
    });
  });

  test("drops stored pictures no draft refers to, whatever their key", async () => {
    await seed("attachments", [[[image("old.png")], "orphan"], [[image("odd.png")], 7]]);
    const page = await tab();
    await page.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "x", images: [image("a.png")] }); });
    expect(await rows("attachments")).toEqual([[image("a.png")]]);
  });
});

describe("a draft being saved", () => {
  test("tells its listeners at once and when stored, and is unsaved until the last save lands", async () => {
    const unloads: EventListener[] = [];
    const original = window.addEventListener.bind(window);
    swap(window, "addEventListener", (type: string, listener: EventListener) => { if (type === "beforeunload") unloads.push(listener); else original(type, listener); });
    const closing = () => { const event = new Event("beforeunload", { cancelable: true }); for (const listener of unloads) listener(event); return event.defaultPrevented; };
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      const heard: string[] = [];
      const leave = draft.subscribe((content) => { heard.push(content.text); });
      const first = draft.save({ text: "one", images: [] });
      const second = draft.save({ text: "two", images: [] });
      expect([draft.saving, draft.unsaved]).toEqual([true, true]);
      expect(closing()).toBe(true);
      await first;
      expect([draft.saving, draft.unsaved], "an older save landing changes nothing").toEqual([true, true]);
      await second;
      expect([draft.saving, draft.unsaved]).toEqual([false, false]);
      expect(heard).toEqual(["one", "two", "two"]);
      expect(closing()).toBe(false);
      leave();
      await draft.save({ text: "three", images: [] });
      expect(heard).toEqual(["one", "two", "two"]);
    });
  });

  test("a save that fails stays unsaved, but is no longer saving", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      const heard: string[] = [];
      draft.subscribe((content) => { heard.push(content.text); });
      expect(await draft.save({ text: "x".repeat(64 * 1024 * 1024 - 1), images: [] }).then(() => "", () => "failed")).toBe("failed");
      expect([draft.saving, draft.unsaved]).toEqual([false, true]);
      expect(heard).toHaveLength(2);
      await draft.save({ text: "fine", images: [] });
      expect(draft.unsaved).toBe(false);
    });
  });

  test("watches for the page closing once, however many drafts it has", async () => {
    const adds: string[] = [];
    const original = window.addEventListener.bind(window);
    swap(window, "addEventListener", (type: string, listener: EventListener) => { adds.push(type); original(type, listener); });
    const page = await tab();
    await page.run(({ browserDraft }) => { browserDraft("ada/main"); browserDraft("ada/side"); });
    expect(adds.filter((type) => type === "beforeunload")).toEqual(["beforeunload"]);
  });

  test("loading waits for saves under way, and a save made while loading wins", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      void draft.save({ text: "early", images: [] });
      expect(await draft.load()).toEqual({ text: "early", images: [] });
    });
    const other = await tab();
    await other.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      const loading = draft.load();
      await draft.save({ text: "typed while loading", images: [] });
      expect(await loading).toEqual({ text: "typed while loading", images: [] });
    });
  });

  test("a draft whose pictures went missing is kept and says so, and one from another conversation is not read", async () => {
    const page = await tab();
    page.session.setItem("shore.draft.owner.v2.ada/main", "lost");
    page.session.setItem("shore.draft.owner.v2.ada/side", "other");
    await seed("drafts", [[row("lost", { conversation: "ada/main", attachment: "gone", imageCount: 1 }), undefined], [row("other", { conversation: "bo/main" }), undefined]]);
    await page.run(async ({ browserDraft }) => {
      expect(await browserDraft("ada/main").load().then(() => "", (error: unknown) => (error as Error).message)).toBe("Saved attachments are missing. The draft was kept for recovery.");
      expect(await browserDraft("ada/side").load()).toEqual({ text: "", images: [] });
    });
  });
});

describe("only one tab at a time", () => {
  test("puts sent messages back, waiting for the other", async () => {
    const page = await tab();
    const order: string[] = [];
    let release: () => void = () => {};
    await page.run(async ({ withSendingLock }) => {
      const first = withSendingLock(async () => { order.push("first in"); await new Promise<void>((resolve) => { release = resolve; }); order.push("first out"); });
      const second = withSendingLock(async () => { order.push("second in"); return await Promise.resolve("done"); });
      await Promise.resolve();
      expect(order).toEqual(["first in"]);
      release();
      await first;
      expect(await second).toBe("done");
    });
    expect(order).toEqual(["first in", "first out", "second in"]);
  });
});

async function opened(version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open("shore-drafts", version);
    request.onupgradeneeded = () => { upgrade?.(request.result); };
    request.onsuccess = () => { resolve(request.result); };
    request.onblocked = () => { reject(new Error("blocked")); };
    request.onerror = () => { reject(request.error ?? new Error("open failed")); };
  });
}

const failure = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

describe("draft storage that cannot be used", () => {
  test("an older tab holding the storage open is asked to close, and the storage opens once it has", async () => {
    const older = await opened(1);
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      expect(await draft.save({ text: "x", images: [] }).then(() => "", failure)).toBe("Error: Close older Shore tabs to open draft storage");
      older.close();
      await Bun.sleep(5);
      await draft.save({ text: "y", images: [] });
    });
    expect(await rows("drafts")).toMatchObject([{ text: "y" }]);
    (await opened(3)).close();
  });

  test("storage from a newer Shore is refused with the browser's reason, every time it is tried", async () => {
    (await opened(3)).close();
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      expect(await draft.save({ text: "x", images: [] }).then(() => "", failure)).toMatch(/^VersionError/);
      expect(await draft.save({ text: "y", images: [] }).then(() => "", failure)).toMatch(/^VersionError/);
    });
  });

  test("a newer Shore upgrading the storage is let through, and this page then stops saving", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.save({ text: "x", images: [] });
      (await opened(3)).close();
      expect(await draft.save({ text: "y", images: [] }).then(() => "", failure)).toMatch(/^VersionError/);
    });
  });

  test("a read that fails is reported, and a sent message the page still holds is put back anyway", async () => {
    const { IDBObjectStore } = await import("fake-indexeddb");
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.send("r_1", { text: "hello", images: [] });
      for (const [error, message] of [[new Error("disk read failed"), "Error: disk read failed"], [null, "Error: Could not read saved draft"]] as const) {
        swap(IDBObjectStore.prototype, "get", () => ({ result: undefined, error, set onsuccess(_handler: () => void) { void _handler; }, set onerror(handler: () => void) { queueMicrotask(handler); } }));
        expect(await draft.restore("r_1").then(() => "", failure)).toBe(message);
        expect(await draft.restore("r_1", { text: "kept here", images: [] })).toEqual({ restored: true, dropped: 0 });
        restores.pop()?.();
      }
      expect(draft.current?.text).toBe("kept here\n\nkept here");
    });
  });

  test("a write the browser abandons says so, and a strange failure becomes an error", async () => {
    const { IDBObjectStore } = await import("fake-indexeddb");
    const page = await tab();
    await page.run(async ({ browserDraft, forgetSending }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.send("r_1", { text: "hello", images: [] });
      swap(IDBObjectStore.prototype, "delete", function (this: IDBObjectStore) { this.transaction.abort(); });
      expect(await forgetSending("r_1").then(() => "", failure)).toBe("Error: Could not update the sent message");
      restores.pop()?.();
      await seed("attachments", [[[image("orphan.png")], "orphan"]]);
      swap(IDBObjectStore.prototype, "delete", function (this: IDBObjectStore) { this.transaction.abort(); });
      expect(await draft.save({ text: "x", images: [] }).then(() => "", failure), "abandoned while tidying pictures").toBe("Error: Could not save the draft");
      restores.pop()?.();
      swap(IDBObjectStore.prototype, "put", () => { throw "quota"; });
      expect(await draft.save({ text: "x", images: [] }).then(() => "", failure)).toBe("Error: quota");
      restores.pop()?.();
      await draft.save({ text: "fine", images: [] });
    });
  });
});

function sequentialIds(): void {
  let next = 0;
  swap(crypto, "randomUUID", () => { next += 1; return `id-${String(next)}`; });
}

describe("what the GitHub pass found untested", () => {
  test("a draft is saved under the id it was made with, and again under a new one once cleared", async () => {
    sequentialIds();
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      expect(draft.saving).toBe(false);
      await draft.load();
      await draft.save({ text: "first", images: [] });
      expect(await rows("drafts")).toMatchObject([{ id: "id-1", revision: 1 }]);
      await draft.save({ text: "", images: [] });
      await draft.save({ text: "again", images: [] });
      expect(await rows("drafts")).toMatchObject([{ id: "id-3", revision: 1 }]);
    });
  });

  test("a draft of one picture alone is kept", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "", images: [image("a.png")] }); });
    expect(await rows("drafts")).toMatchObject([{ text: "", imageCount: 1 }]);
  });

  test("a reloaded draft carries on as the same record with the same pictures", async () => {
    const first = await tab();
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "one", images: [image("a.png")] }); });
    const [saved] = await rows("drafts") as { id: string; attachment: string }[];
    locks?.held.delete(`shore.draft.tab.${first.session.getItem("shore.draft.tab") ?? ""}`);
    const again = await tab(first.session);
    await again.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      const loaded = await draft.load();
      await draft.save({ ...loaded, text: "two" });
    });
    expect(await rows("drafts")).toMatchObject([{ id: saved?.id, attachment: saved?.attachment, revision: 2, text: "two" }]);
  });

  test("unchanged pictures keep their stored copy from save to save", async () => {
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      const images = [image("a.png")];
      await draft.save({ text: "one", images });
      const [first] = await rows("drafts") as { attachment: string }[];
      await draft.save({ text: "two", images });
      const [second] = await rows("drafts") as { attachment: string }[];
      expect(second?.attachment).toBe(first?.attachment ?? "");
    });
  });

  test("a tab that copied a draft from another keeps its own pictures when the other drops theirs", async () => {
    const first = await tab();
    const images = [image("a.png")];
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "start", images }); });
    const copy = memory();
    copy.setItem("shore.draft.owner.v2.ada/main", first.session.getItem("shore.draft.owner.v2.ada/main") ?? "");
    const second = await tab(copy);
    const loaded = await second.run(async ({ browserDraft }) => await browserDraft("ada/main").load());
    await first.run(async ({ browserDraft }) => { await browserDraft("ada/main").save({ text: "first edit", images }); });
    await second.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.save({ ...loaded, text: "second edit" }); await draft.save({ ...loaded, text: "second again" }); });
    expect(await rows("drafts")).toHaveLength(2);
    await first.run(async ({ browserDraft }) => { await browserDraft("ada/main").save({ text: "no pictures", images: [] }); });
    locks?.held.delete(`shore.draft.tab.${copy.getItem("shore.draft.tab") ?? ""}`);
    const reloaded = await tab(copy);
    expect(await reloaded.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "second again", images });
  });

  test("an old draft moves in even when other conversations have drafts", async () => {
    await seed("drafts", [[row("other", { conversation: "bo/main" }), undefined]]);
    localStorage.setItem("shore.draft.v1.ada/main", "from before");
    const page = await tab();
    expect(await page.run(async ({ browserDraft }) => await browserDraft("ada/main").load())).toEqual({ text: "from before", images: [] });
  });

  test("a copied tab's own messages are left to it while it is open", async () => {
    const first = await tab();
    await first.run(async ({ browserDraft }) => { await browserDraft("ada/main").load(); });
    const copied = memory();
    copied.setItem("shore.draft.tab", first.session.getItem("shore.draft.tab") ?? "");
    const clone = await tab(copied);
    await clone.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.send("r_clone", { text: "hi", images: [] }); });
    const other = await tab();
    expect(await other.run(async ({ unclaimedSending }) => await unclaimedSending())).toEqual([]);
    locks?.held.delete(`shore.draft.tab.${copied.getItem("shore.draft.tab") ?? ""}`);
    expect((await other.run(async ({ unclaimedSending }) => await unclaimedSending())).map((message) => message.rid)).toEqual(["r_clone"]);
  });

  test("a reloaded tab takes back its own messages before another tab can", async () => {
    const first = await tab();
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.send("r_1", { text: "hi", images: [] }); });
    locks?.held.delete(`shore.draft.tab.${first.session.getItem("shore.draft.tab") ?? ""}`);
    const reloaded = await tab(first.session);
    expect((await reloaded.run(async ({ unclaimedSending }) => await unclaimedSending())).map((message) => message.rid)).toEqual(["r_1"]);
    const other = await tab();
    expect(await other.run(async ({ unclaimedSending }) => await unclaimedSending())).toEqual([]);
  });

  test("putting a message back fails loudly for any trouble but another tab taking it", async () => {
    const { IDBObjectStore } = await import("fake-indexeddb");
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      await draft.send("r_1", { text: "hello", images: [] });
      swap(IDBObjectStore.prototype, "put", () => { throw new Error("quota"); });
      expect(await draft.restore("r_1").then(() => "", failure)).toBe("Error: quota");
    });
  });

  test("a save made while the draft was being read wins over what was read", async () => {
    const first = await tab();
    await first.run(async ({ browserDraft }) => { const draft = browserDraft("ada/main"); await draft.load(); await draft.save({ text: "stored", images: [] }); });
    const { IDBObjectStore } = await import("fake-indexeddb");
    const again = await tab(first.session);
    await again.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      const original: unknown = Reflect.get(IDBObjectStore.prototype, "get");
      let typed = false;
      swap(IDBObjectStore.prototype, "get", function (this: IDBObjectStore, key: IDBValidKey) {
        if (!typed) { typed = true; void draft.save({ text: "typed meanwhile", images: [] }); }
        return Reflect.apply(original as (key: IDBValidKey) => IDBRequest, this, [key]);
      });
      expect(await draft.load()).toEqual({ text: "typed meanwhile", images: [] });
    });
  });

  test("saves land one after another, each seeing the last one's result", async () => {
    const { IDBDatabase } = await import("fake-indexeddb");
    const page = await tab();
    await page.run(async ({ browserDraft }) => {
      const draft = browserDraft("ada/main");
      await draft.load();
      const original: unknown = Reflect.get(IDBDatabase.prototype, "transaction");
      let slowed = false;
      swap(IDBDatabase.prototype, "transaction", function (this: IDBDatabase, ...args: unknown[]) {
        const tx = Reflect.apply(original as (...rest: unknown[]) => IDBTransaction, this, args);
        if (!slowed && args[1] === "readwrite") {
          slowed = true;
          let handler: ((event: Event) => void) | null = null;
          Object.defineProperty(tx, "oncomplete", { configurable: true, get: () => handler === null ? null : (event: Event) => { setTimeout(() => { handler?.(event); }, 20); }, set: (value: ((event: Event) => void) | null) => { handler = value; } });
        }
        return tx;
      });
      const first = draft.save({ text: "one", images: [] });
      const second = draft.save({ text: "two", images: [] });
      await first;
      await second;
    });
    expect(await rows("drafts")).toMatchObject([{ text: "two", revision: 2 }]);
  });
});
