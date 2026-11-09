import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { conversationCharacter, droppedNotice, sentFate } from "../src/browser/chat/sending.ts";
import { QUOTE_EVENT, quoteText, withQuote } from "../src/browser/chat/quote.ts";
import { ReadMarks } from "../src/browser/chat/read_marks.ts";
import { workspaceNote } from "../src/browser/chat/workspace_note.ts";
import { COMPACTION_VIEW_EVENT, CONVERSATION_DIALOG_EVENT, EFFORT_MENU_EVENT, FOLDER_DIALOG_EVENT, THREAD_DIALOG_EVENT, openCompactionView, openConversationDialog, openEffortMenu, openFolderDialog, openThreadDialog, requestConfigSearch, takeConfigSearch } from "../src/browser/app/intents.ts";
import { SETTINGS_PAGES, parseRoute } from "../src/browser/app/routing.ts";
import { DEFAULT_FONT_SIZE, FONT_SIZE_STORAGE_KEY, FontSizeStore, isFontSizeId, storedFontSize } from "../src/browser/font_size.ts";
import { accumulateMetadata, metadataLabel } from "../src/browser/metadata.ts";
import { assertModelSettingsCoverage, modelSettingControl } from "../src/browser/model_forms.ts";
import { randomUUID } from "../src/browser/platform.ts";
import { listRequests, requestHistory } from "../src/browser/request_history.ts";
import { DEFAULT_THEME, THEME_STORAGE_KEY, ThemeStore, isThemeId, storedTheme } from "../src/browser/theme.ts";
import { fieldLabel } from "../src/browser/ui/labels.ts";
import { parseServerFrame } from "../src/browser/wire.ts";
import type { Workspace } from "../src/browser/workspace.ts";
import type { ModelSettingSchemaEntry } from "../src/protocol/ModelSettingSchemaEntry.ts";
import type { StreamMetadata } from "../src/protocol/StreamMetadata.ts";
import type { WebRequestInfo } from "../src/protocol/WebRequestInfo.ts";

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let broken = false;
  return {
    values,
    break: () => { broken = true; },
    getItem: (key: string) => { if (broken) throw new Error("blocked"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (broken) throw new Error("quota"); values.set(key, value); },
  };
}

describe("undoing a reply's workspace changes", () => {
  test("says what was restored and which changed files were left alone", () => {
    expect(workspaceNote(undefined)).toBeUndefined();
    expect(workspaceNote({ restored: [], skipped: [] })).toBeUndefined();
    expect(workspaceNote({ restored: ["a"], skipped: [], kept: "later_turns" })).toBe("Workspace files kept: later turns build on this one");
    expect(workspaceNote({ restored: ["a"], skipped: [] })).toBe("Restored 1 workspace file");
    expect(workspaceNote({ restored: ["a", "b"], skipped: ["c"] })).toBe("Restored 2 workspace files; 1 workspace file changed since and was left as is: c");
    expect(workspaceNote({ restored: [], skipped: ["c", "d", "e", "f"] })).toBe("4 workspace files changed since and were left as is: c, d, e, …");
    expect(workspaceNote({ restored: [], skipped: ["c", "d", "e"] })).toBe("3 workspace files changed since and were left as is: c, d, e");
  });
});

describe("appearance", () => {
  for (const [name, Store, key, fallback, chosen, isId, stored] of [
    ["theme", ThemeStore, THEME_STORAGE_KEY, DEFAULT_THEME, "fog", isThemeId, storedTheme],
    ["text size", FontSizeStore, FONT_SIZE_STORAGE_KEY, DEFAULT_FONT_SIZE, "large", isFontSizeId, storedFontSize],
  ] as const) {
    test(`the ${name} is read from storage, applied to the page, and saved when chosen`, () => {
      expect(isId(chosen)).toBe(true);
      expect(isId("neon")).toBe(false);
      expect(stored(storage({ [key]: chosen }))).toBe(chosen);
      expect(stored(storage({ [key]: "neon" }))).toBe(fallback);
      expect(stored(undefined)).toBe(fallback);
      const broken = storage();
      broken.break();
      expect(stored(broken)).toBe(fallback);

      const saved = storage({ [key]: chosen });
      const root = { dataset: {} as Record<string, string | undefined> };
      const store = new Store(saved, root);
      const attribute = name === "theme" ? "theme" : "fontSize";
      expect(store.getSnapshot()).toBe(chosen);
      expect(root.dataset[attribute]).toBe(chosen);
      let heard = 0;
      const stop = store.subscribe(() => { heard += 1; });
      store.select(fallback as never);
      expect([saved.values.get(key), root.dataset[attribute], store.error, heard]).toEqual([fallback, fallback, "", 1]);
      store.reload();
      expect(heard, "nothing changed in storage").toBe(1);
      saved.values.set(key, chosen);
      store.reload();
      expect([store.getSnapshot(), root.dataset[attribute], heard]).toEqual([chosen, chosen, 2]);
      saved.break();
      store.select(fallback as never);
      expect(store.getSnapshot()).toBe(fallback);
      expect(store.error).toContain("will reset on reload");
      stop();
      const unrooted = new Store(storage(), undefined);
      unrooted.select(chosen as never);
      expect(unrooted.getSnapshot()).toBe(chosen);
    });
  }
});

describe("sending a message", () => {
  const request = (phase: WebRequestInfo["phase"], accepted?: boolean): WebRequestInfo => ({
    id: "w", rid: "r", operation: "message", label: "", character: null, thread: null, started_at: 0, expires_at: 0, phase, result_omitted: false,
    ...(accepted === undefined ? {} : { accepted }),
  });

  test("a message's fate is saved once accepted or done, waiting while it runs, and unsent otherwise", () => {
    expect(sentFate(undefined)).toBe("unsent");
    expect(sentFate(request("running", true))).toBe("saved");
    expect(sentFate(request("failed", true))).toBe("saved");
    expect(sentFate(request("completed"))).toBe("saved");
    expect(sentFate(request("running"))).toBe("waiting");
    expect(sentFate(request("running", false))).toBe("waiting");
    for (const phase of ["failed", "cancelled", "superseded", "uncertain"] as const) expect(sentFate(request(phase)), phase).toBe("unsent");
  });

  test("dropped attachments are mentioned only when there were some, and a conversation key names its character", () => {
    expect(droppedNotice(0)).toBe("");
    expect(droppedNotice(1)).toBe(" 1 image attached while it was sending didn’t fit and was removed.");
    expect(droppedNotice(3)).toBe(" 3 images attached while it was sending didn’t fit and were removed.");
    expect(conversationCharacter('["ada","main"]')).toBe("ada");
    expect(conversationCharacter("[3]")).toBeUndefined();
    expect(conversationCharacter("not json")).toBeUndefined();
  });

  test("a quote marks every line, keeps blank ones inside, trims around it and joins the draft after a gap", () => {
    expect(quoteText("\r\n\nfirst  \r\n\nsecond\rthird\n\n")).toBe("> first\n>\n> second\n> third");
    expect(quoteText("  \n ")).toBe("");
    expect(withQuote("", "hi")).toBe("> hi\n\n");
    expect(withQuote("my reply  \n\n", "hi")).toBe("my reply\n\n> hi\n\n");
    expect(withQuote("kept", "  ")).toBe("kept");
    expect(QUOTE_EVENT).toBe("shore:quote");
  });
});

describe("a reply's metadata", () => {
  const metadata = (input: number, total: number, ttft: number, model = "opus"): StreamMetadata =>
    ({ model, tokens: { input, output: input + 1, cache_read: input + 2, cache_write: input + 3 }, timing: { total_ms: total, ttft_ms: ttft } });

  test("adds up over the rounds of a tool loop, keeping the first token time and the latest model", () => {
    const first = metadata(10, 100, 7);
    expect(accumulateMetadata(null, first)).toBe(first);
    expect(accumulateMetadata(first, metadata(5, 50, 3, "sonnet"))).toEqual({ model: "sonnet", tokens: { input: 15, output: 17, cache_read: 19, cache_write: 21 }, timing: { total_ms: 150, ttft_ms: 7 } });
    const huge = accumulateMetadata(metadata(1.5e19, 4_294_967_000, 1), metadata(1.5e19, 4_294_967_000, 1));
    expect(huge.timing.total_ms).toBe(4_294_967_295);
    expect(huge.tokens.input).toBe(Number(0xffff_ffff_ffff_ffffn));
    expect(metadataLabel(first)).toBe("opus · in: 10 · out: 11 · cache: 12 read / 13 write · 100 ms · first token: 7 ms");
  });
});

describe("model setting forms", () => {
  const setting = (kind: ModelSettingSchemaEntry["kind"], overrides: Partial<ModelSettingSchemaEntry> = {}): ModelSettingSchemaEntry =>
    ({ key: "k", kind, applicability: "always", suggestions: [], allow_custom: true, ...overrides });

  test("each kind of model setting gets its control, with choices when nothing else is allowed", () => {
    expect(modelSettingControl(setting("number"))).toEqual({ kind: "number" });
    expect(modelSettingControl(setting("u32"))).toEqual({ kind: "integer", minimum: 0, maximum: 4_294_967_295 });
    expect(modelSettingControl(setting("boolean"))).toEqual({ kind: "boolean" });
    expect(modelSettingControl(setting("duration"))).toEqual({ kind: "string" });
    expect(modelSettingControl(setting("duration_or_off"))).toEqual({ kind: "string" });
    expect(modelSettingControl(setting("string"))).toEqual({ kind: "string" });
    expect(modelSettingControl(setting("string", { allow_custom: false, suggestions: ["low"] }))).toEqual({ kind: "string", choices: ["low"] });
    expect(() => modelSettingControl(setting("string", { allow_custom: false }))).toThrow("Missing choices for k");
    expect(modelSettingControl(setting("json_object"))).toEqual({ kind: "json" });
    expect(() => modelSettingControl(setting("matrix" as ModelSettingSchemaEntry["kind"]))).toThrow("Unsupported model setting kind: matrix");
    expect(() => { assertModelSettingsCoverage([setting("number"), setting("boolean")], new Set(["number", "boolean"])); }).not.toThrow();
    expect(() => { assertModelSettingsCoverage([setting("number"), setting("json_object")], new Set(["number"])); }).toThrow("Missing model setting renderer: json");
  });
});

describe("small pieces of the page", () => {
  test("a field key reads as a label", () => {
    expect(fieldLabel("api_key")).toBe("Api key");
    expect(fieldLabel("maxTokens")).toBe("Max Tokens");
    expect(fieldLabel("--x--")).toBe("X");
    expect(fieldLabel("__")).toBe("__");
  });

  test("the address fragment picks the settings page, defaulting to models, and anything else is the chat", () => {
    expect(parseRoute("")).toEqual({ view: "chat" });
    expect(parseRoute("#chat")).toEqual({ view: "chat" });
    expect(parseRoute("#settings")).toEqual({ view: "settings", page: "models" });
    expect(parseRoute("#settings/usage")).toEqual({ view: "settings", page: "usage" });
    expect(parseRoute("#settings/nowhere")).toEqual({ view: "settings", page: "models" });
    expect(parseRoute("#settings/Usage")).toEqual({ view: "chat" });
    expect(parseRoute("x#settings")).toEqual({ view: "chat" });
    expect(SETTINGS_PAGES.every((page) => parseRoute(`#settings/${page.id}`).view === "settings")).toBe(true);
  });

  test("an id is a version 4 UUID, made by hand where the browser has no generator", () => {
    expect(randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
    restores.push(() => { if (original !== undefined) Object.defineProperty(crypto, "randomUUID", original); });
    const fills = spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(0xff);
      return array;
    });
    restores.push(() => { fills.mockRestore(); });
    expect(randomUUID()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    fills.mockImplementation(<T extends ArrayBufferView | null>(array: T): T => array);
    expect(randomUUID()).toBe("00000000-0000-4000-8000-000000000000");
  });

  test("dialogs and menus are asked for by events, and a configuration search is taken once", () => {
    const heard: [string, unknown][] = [];
    const names = [CONVERSATION_DIALOG_EVENT, EFFORT_MENU_EVENT, THREAD_DIALOG_EVENT, FOLDER_DIALOG_EVENT, COMPACTION_VIEW_EVENT];
    const listener = (event: Event) => { heard.push([event.type, (event as CustomEvent).detail]); };
    for (const name of names) addEventListener(name, listener);
    restores.push(() => { for (const name of names) removeEventListener(name, listener); });
    openConversationDialog("rename");
    openEffortMenu();
    openThreadDialog("fork", "story");
    openFolderDialog({ kind: "rename", folder: "work" });
    openCompactionView();
    expect(heard).toEqual([
      [CONVERSATION_DIALOG_EVENT, "rename"],
      [EFFORT_MENU_EVENT, null],
      [THREAD_DIALOG_EVENT, { kind: "fork", thread: "story" }],
      [FOLDER_DIALOG_EVENT, { kind: "rename", folder: "work" }],
      [COMPACTION_VIEW_EVENT, null],
    ]);
    requestConfigSearch("heartbeat");
    expect(takeConfigSearch()).toBe("heartbeat");
    expect(takeConfigSearch()).toBe("");
  });

  test("request history comes from the daemon, checked, and says so when it cannot", async () => {
    const asked: [string, RequestInit | undefined][] = [];
    const list = { requests: [], max_records: 50, max_result_bytes: 1024 };
    let answer: Response = Response.json(list);
    const fetching = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      asked.push([input instanceof Request ? input.url : input.toString(), init]);
      return answer;
    }) as typeof fetch);
    restores.push(() => { fetching.mockRestore(); });
    expect(await listRequests()).toEqual(list);
    expect(asked[0]?.[0]).toBe("/api/requests/list");
    expect(asked[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" });
    answer = Response.json({ requests: "nope" });
    expect(await listRequests().then(() => "", (error: unknown) => String(error))).toBe("Error: The daemon sent an unexpected request history. Reload the page.");
    answer = new Response("", { status: 401 });
    expect(await requestHistory("/clear").then(() => "", (error: unknown) => String(error))).toBe("Error: Couldn’t load request history. Try again after reconnecting.");
  });
});

describe("the frames a browser accepts", () => {
  test("a frame is known, from a newer daemon, or refused with a reason", () => {
    expect(parseServerFrame("{")).toEqual({ kind: "invalid", reason: "Server sent invalid JSON" });
    for (const bad of ["null", "[]", "3", '{"x":1}', '{"type":3}', '{"type":""}', `{"type":"${"t".repeat(129)}"}`]) {
      expect(parseServerFrame(bad), bad).toEqual({ kind: "invalid", reason: "Server frame has no valid event type" });
    }
    expect(parseServerFrame(`{"type":"${"t".repeat(128)}"}`).kind).toBe("future");
    expect(parseServerFrame('{"type":"hologram","x":1}')).toEqual({ kind: "future", message: { type: "hologram", x: 1 } });
    expect(parseServerFrame('{"type":"ping"}')).toEqual({ kind: "known", message: { type: "ping" } });
    expect(parseServerFrame('{"type":"error","code":"busy"}')).toEqual({ kind: "invalid", reason: "Server sent an invalid error event" });
  });

  test("a frame past the browser's size limit is refused, except a history", () => {
    const padding = "x".repeat(32 * 1024 * 1024);
    expect(parseServerFrame(`{"type":"ping","pad":"${padding}"}`)).toEqual({ kind: "invalid", reason: "Server frame exceeds the browser limit" });
    expect(parseServerFrame(`{"type":"history","pad":"${padding}"}`).kind).toBe("invalid");
    expect(parseServerFrame(`{"type":"history","pad":"${padding}"}`)).toEqual({ kind: "invalid", reason: "Server sent an invalid history event" });
  });
});

describe("read marks", () => {
  function workspaceWith(state: Record<string, unknown>) {
    const marked: unknown[] = [];
    let snapshot = {
      status: "ready", character: "ada", thread: "main", segmentView: null,
      threads: [{ id: "main", unread: 2 }], messages: [{ timestamp: "2026-11-10T09:00:00Z" }], ...state,
    };
    const fake = {
      getSnapshot: () => snapshot,
      actions: { run: async (name: string, input: unknown) => { marked.push([name, input]); return { ok: true }; } },
    };
    return { workspace: fake as unknown as Workspace, marked, set: (next: Record<string, unknown>) => { snapshot = { ...snapshot, ...next }; } };
  }

  test("a focused thread with unread messages is marked read through its latest message, once", () => {
    const view = workspaceWith({});
    let focused = true;
    const marks = new ReadMarks(view.workspace, () => focused);
    marks.check();
    marks.check();
    expect(view.marked).toEqual([["mark_thread_read", { name: "main", through: "2026-11-10T09:00:00Z" }]]);
    view.set({ messages: [{ timestamp: "2026-11-10T09:05:00Z" }] });
    marks.check();
    expect(view.marked).toHaveLength(2);
    view.set({ status: "reconnecting" });
    marks.check();
    view.set({ status: "ready" });
    marks.check();
    expect(view.marked, "a reconnect sends it again").toHaveLength(3);
    focused = false;
    view.set({ messages: [{ timestamp: "2026-11-10T10:00:00Z" }] });
    marks.check();
    expect(view.marked).toHaveLength(3);
  });

  test("nothing is marked without a conversation, while reading an old segment, with nothing unread or no messages", () => {
    for (const state of [{ character: null }, { thread: null }, { segmentView: { segment: 1 } }, { threads: [{ id: "main", unread: 0 }] }, { threads: [] }, { messages: [] }, { status: "connecting" }]) {
      const view = workspaceWith(state);
      new ReadMarks(view.workspace, () => true).check();
      expect(view.marked, JSON.stringify(state)).toEqual([]);
    }
  });
});
