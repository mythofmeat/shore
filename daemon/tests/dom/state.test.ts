import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { LISTING, connect, forgetKeptSettings, keptSettings, replace, type Answer } from "./daemon.ts";
import { acting, blockStorage, renderHook, useDom } from "./dom.ts";

useDom("http://shore.test:7340/workspace/ada/story");

type State = typeof import("../../src/browser/app/state.ts");

const restores: (() => void)[] = [];
const loaded: State[] = [];
afterEach(() => {
  for (const state of loaded.splice(0)) state.workspace.connection.stop();
  for (const restore of restores.splice(0).reverse()) restore();
  localStorage.clear();
  forgetKeptSettings();
});

function swap(target: object, key: string, value: unknown): void { replace(restores, target, key, value); }

beforeAll(() => {
  Object.assign(globalThis, { SHORE_WEB_CONTRACT: "c1", SHORE_WEB_PROTOCOL: 2 });
});
afterAll(() => {
  for (const key of ["SHORE_WEB_CONTRACT", "SHORE_WEB_PROTOCOL"]) Reflect.deleteProperty(globalThis, key);
});

let loads = 0;
async function load(path = "/workspace/ada/story"): Promise<State> {
  history.replaceState(null, "", path);
  loads += 1;
  const state = await import(`../../src/browser/app/state.ts?load=${String(loads)}`) as State;
  loaded.push(state);
  return state;
}

async function connected(state: State, answer?: Answer) {
  return await connect(state.workspace.connection, restores, answer);
}

describe("the app's state", () => {
  test("asks for the conversation the address names", async () => {
    const cases: [string, string | null, string | null][] = [
      ["/workspace/ada/story", "ada", "story"],
      ["/workspace/a%20b/c%2Fd", "a b", "c/d"],
      ["/workspace/ada", "ada", null],
      ["/workspace/", null, null],
      ["/elsewhere/ada/story", null, null],
    ];
    for (const [path, character, thread] of cases) {
      const state = await load(path);
      expect(state.workspace.connection.selection, path).toMatchObject({ character, thread });
    }
  });

  test("shows each streamed piece on the next animation frame, and keeps the compaction pass's to its frames too", async () => {
    const frames: (() => void)[] = [];
    swap(globalThis, "requestAnimationFrame", (callback: () => void) => { frames.push(callback); return frames.length; });
    const state = await load();
    const socket = await connected(state);
    let heard = 0;
    state.workspace.subscribe(() => { heard += 1; });
    socket.receive({ type: "stream_chunk", rid: "r_1", text: "hel", content_type: "text" });
    socket.receive({ type: "stream_chunk", rid: "r_1", text: "lo", content_type: "text" });
    expect(heard).toBe(0);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(heard).toBe(1);
    expect(state.workspace.getSnapshot().streams.at(-1)?.text).toBe("hello");

    state.compactionWatch.open("ada", { thread: "story", trigger: "idle", started_at: "2026-11-10T00:00:00Z" });
    await Bun.sleep(5);
    const watch = socket.sent.find((request) => request["name"] === "compact_watch");
    expect(watch).toMatchObject({ type: "command", args: {} });
    let watched = 0;
    state.compactionWatch.subscribe(() => { watched += 1; });
    socket.receive({ type: "stream_chunk", rid: watch?.["rid"], text: "summary", content_type: "text" });
    expect(watched).toBe(0);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(watched).toBe(1);
    expect(state.compactionWatch.getSnapshot()?.blocks).toEqual([{ type: "text", text: "summary" }]);
  });

  test("stopping a compaction asks the daemon, and a reconnection replays an interrupted watch", async () => {
    const state = await load();
    const socket = await connected(state, (request) => {
      if (request["name"] === "compact_cancel") return { character: "ada", state: "idle", pass: null };
      if (request["name"] === "list_threads") return LISTING;
      if (request["name"] === "discover_operations") return { operations: [], requests: [] };
      if (request["name"] === "list_characters") return { characters: [] };
      return undefined;
    });
    state.compactionWatch.open("ada", { thread: "story", trigger: "idle", started_at: "2026-11-10T00:00:00Z" });
    expect(await state.compactionWatch.stop()).toBe("No compaction is running.");
    expect(socket.sent.map((request) => request["name"])).toContain("compact_cancel");
    expect(state.compactionWatch.getSnapshot()?.running).toBe(false);
    const fresh = await load();
    fresh.compactionWatch.open("ada", { thread: "story", trigger: "idle", started_at: "2026-11-10T00:00:00Z" });
    await Bun.sleep(5);
    expect(fresh.compactionWatch.getSnapshot()?.interrupted, "with no connection the watch cannot start").toBe(true);
    let watched = 0;
    const leave = fresh.compactionWatch.subscribe(() => { watched += 1; });
    fresh.workspace.connection.stop();
    await Bun.sleep(5);
    expect(watched, "only a ready connection restarts the watch").toBe(0);
    leave();
    const freshSocket = await connected(fresh);
    expect(fresh.compactionWatch.getSnapshot()?.interrupted).toBe(false);
    expect(freshSocket.sent.some((request) => request["name"] === "compact_watch"), "it was watched again once ready").toBe(true);
  });

  test("notifies about replies while connected, and marks them read when the page gets focus", async () => {
    const state = await load();
    const { NOTIFY_KEY } = await import("../../src/browser/notifications.ts");
    swap(document, "hasFocus", () => false);
    localStorage.setItem(NOTIFY_KEY, "true");
    dispatchEvent(new Event("storage"));
    const socket = await connected(state);
    expect(state.notifier.getSnapshot().enabled).toBe(true);
    socket.receive({ type: "new_message", revision: 2, character: "ada", thread: "story", msg_id: "m_1", role: "assistant", content: "hello", images: [], content_blocks: [], timestamp: "2026-11-10T00:00:00Z" });
    expect(state.notifier.getSnapshot().unread).toBe(1);
    dispatchEvent(new Event("focus"));
    expect(state.notifier.getSnapshot().unread).toBe(0);
  });

  test("a message that was not saved comes back with a notice naming its character and any pictures left out", async () => {
    const state = await load();
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const shown = spyOn(toasts, "show");
    restores.push(() => { shown.mockRestore(); });
    state.unsent.restored({ rid: "r_1", conversation: JSON.stringify(["ada", "story"]), tab: null, text: "hi", images: [], sent: 0 }, 0);
    state.unsent.restored({ rid: "r_2", conversation: "not json", tab: null, text: "hi", images: [], sent: 0 }, 2);
    expect(shown.mock.calls).toEqual([
      ["Your earlier message to ada wasn’t saved, so it’s back in its message box.", "error"],
      ["Your earlier message wasn’t saved, so it’s back in its message box. 2 images attached while it was sending didn’t fit and were removed.", "error"],
    ]);
  });

  test("another tab changing the stored settings is picked up", async () => {
    const state = await load();
    const { THEME_STORAGE_KEY } = await import("../../src/browser/theme.ts");
    const { FONT_SIZE_STORAGE_KEY } = await import("../../src/browser/font_size.ts");
    localStorage.setItem(THEME_STORAGE_KEY, "fog");
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, "large");
    localStorage.setItem("shore.folders.collapsed", JSON.stringify({ ada: ["work"] }));
    const { PREFERENCE_STORAGE_KEY } = await import("../../src/browser/preferences.ts");
    const { NOTIFY_KEY } = await import("../../src/browser/notifications.ts");
    expect(state.display.getSnapshot().values.metadata).toBe("off");
    localStorage.setItem(`${PREFERENCE_STORAGE_KEY}.metadata`, "on");
    localStorage.setItem(NOTIFY_KEY, "true");
    const { useStoredFlag } = await import("../../src/browser/ui/hooks.ts");
    const vim = await renderHook(() => useStoredFlag(state.VIM_MODE_KEY, false), undefined);
    localStorage.setItem(state.VIM_MODE_KEY, "true");
    await acting(() => { dispatchEvent(new Event("storage")); });
    expect(vim.current()[0]).toBe(true);
    await vim.unmount();
    expect([state.themes.getSnapshot(), state.fontSizes.getSnapshot()]).toEqual(["fog", "large"]);
    expect([...state.collapsedFolders.of("ada")]).toEqual(["work"]);
    expect(state.display.getSnapshot().values.metadata).toBe("on");
    expect(state.notifier.getSnapshot().enabled).toBe(true);
  });

  test("streaming and Enter-to-send are on unless turned off, and on when storage is blocked", async () => {
    const state = await load();
    expect([state.streamReplies(), state.enterSends()]).toEqual([true, true]);
    localStorage.setItem(state.STREAM_KEY, "false");
    localStorage.setItem(state.ENTER_SENDS_KEY, "false");
    expect([state.streamReplies(), state.enterSends()]).toEqual([false, false]);
    localStorage.setItem(state.STREAM_KEY, "no");
    expect(state.streamReplies()).toBe(true);
    restores.push(blockStorage());
    expect([state.streamReplies(), state.enterSends()]).toEqual([true, true]);
  });

  test("an error reads as its message, and work done in the background reports its failure", async () => {
    const state = await load();
    expect(state.errorText(new Error("broke"))).toBe("broke");
    expect(state.errorText("plain")).toBe("plain");
    state.perform(async () => { await Promise.resolve(); throw new Error("background broke"); });
    state.perform(async () => await Promise.resolve("fine"));
    await Bun.sleep(1);
    expect(state.workspace.getSnapshot().error).toBe("background broke");
  });
});

const EVERYWHERE = {
  "shore.theme": "fog", "shore.font-size": "large", "shore.stream": "false", "shore.enter-sends": "false", "shore.vim-mode": "true",
  "shore.folders.collapsed": JSON.stringify({ ada: ["work"] }),
  "shore.view.v1.timestamps": "off", "shore.view.v1.thinking": "off", "shore.view.v1.tools": "off", "shore.view.v1.subagent": "off", "shore.view.v1.compaction": "off",
  "shore.view.v1.images": "off", "shore.view.v1.metadata": "on", "shore.view.v1.usage": "always", "shore.view.v1.budget": "pace",
};
const PER_BROWSER = { "shore.notify": "true", "shore.sidebar": "false", "shore.settings-page": "usage" };

describe("settings the daemon keeps", () => {
  test("a browser at a new address starts with them once it is signed in, and shows them without a reload", async () => {
    Object.assign(keptSettings.values, EVERYWHERE, PER_BROWSER);
    const state = await load();
    const { useStoredFlag } = await import("../../src/browser/ui/hooks.ts");
    const vim = await renderHook(() => useStoredFlag(state.VIM_MODE_KEY, false), undefined);
    expect([state.themes.getSnapshot(), vim.current()[0], keptSettings.lists]).toEqual(["default", false, 0]);
    dispatchEvent(new Event("focus"));
    await Bun.sleep(5);
    expect(keptSettings.lists, "nothing is asked before the page is connected").toBe(0);
    await acting(async () => { await connected(state); });
    expect(keptSettings.lists).toBe(1);
    expect(Object.fromEntries(Object.keys({ ...EVERYWHERE, ...PER_BROWSER }).map((key) => [key, localStorage.getItem(key)]))).toEqual({ ...EVERYWHERE, ...PER_BROWSER });
    expect([state.themes.getSnapshot(), document.documentElement.dataset["theme"], state.fontSizes.getSnapshot(), vim.current()[0]]).toEqual(["fog", "fog", "large", true]);
    expect(state.display.getSnapshot().values).toEqual({ timestamps: "off", thinking: "off", tools: "off", subagent: "off", compaction: "off", images: "off", metadata: "on", usage: "always", budget: "pace" });
    expect([state.streamReplies(), state.enterSends(), state.notifier.getSnapshot().enabled, [...state.collapsedFolders.of("ada")]]).toEqual([false, false, true, ["work"]]);
    expect(keptSettings.saves).toEqual([]);
    await vim.unmount();
  });

  test("a browser that already has settings hands them to a daemon that has none", async () => {
    for (const [key, value] of Object.entries({ ...EVERYWHERE, ...PER_BROWSER, "shore.device-address": "box:7340", "shore.draft.v1.x": "words", "shore.reasoning": "false" })) localStorage.setItem(key, value);
    const state = await load();
    await connected(state);
    expect(keptSettings.saves).toEqual([{ ...EVERYWHERE, ...PER_BROWSER }]);
  });

  test("each setting changed on the page is sent as it is changed, and the ones tied to an address stay here", async () => {
    const state = await load();
    const socket = await connected(state);
    const { writeStored } = await import("../../src/browser/stored.ts");
    expect([keptSettings.lists, keptSettings.saves]).toEqual([1, []]);
    state.themes.select("fog");
    state.fontSizes.select("small");
    state.display.change("metadata", "on");
    state.collapsedFolders.toggle("ada", "work");
    state.notifier.disable();
    writeStored(state.SIDEBAR_KEY, "false");
    writeStored("shore.device-address", "box:7340");
    await Bun.sleep(5);
    expect(keptSettings.values).toEqual({ "shore.theme": "fog", "shore.font-size": "small", "shore.view.v1.metadata": "on", "shore.folders.collapsed": JSON.stringify({ ada: ["work"] }), "shore.notify": "false", "shore.sidebar": "false" });
    socket.receive({ type: "stream_chunk", rid: "r_1", text: "hi", content_type: "text" });
    await Bun.sleep(5);
    expect(keptSettings.lists, "replies arriving don't ask again").toBe(1);
  });

  test("coming back to the page picks up what another device changed, but keeps this browser's own notification choice", async () => {
    const state = await load();
    await connected(state);
    state.notifier.disable();
    await Bun.sleep(5);
    Object.assign(keptSettings.values, { "shore.theme": "fog", "shore.notify": "true" });
    dispatchEvent(new Event("focus"));
    await Bun.sleep(5);
    expect([keptSettings.lists, state.themes.getSnapshot(), state.notifier.getSnapshot().enabled]).toEqual([2, "fog", false]);
    state.workspace.connection.stop();
    dispatchEvent(new Event("focus"));
    await Bun.sleep(5);
    expect(keptSettings.lists, "a page that isn't connected doesn't ask").toBe(2);
  });

  test("a daemon that can't be asked leaves the page working with what this browser has", async () => {
    localStorage.setItem("shore.theme", "fog");
    const state = await load();
    await connected(state);
    const failures: unknown[] = [];
    const heard = (event: PromiseRejectionEvent | { reason: unknown }) => { failures.push(event.reason); };
    process.on("unhandledRejection", heard as never);
    restores.push(() => { process.off("unhandledRejection", heard as never); });
    swap(globalThis, "fetch", async () => await Promise.resolve(new Response("", { status: 503 })));
    dispatchEvent(new Event("focus"));
    state.themes.select("default");
    await Bun.sleep(5);
    expect([state.themes.getSnapshot(), state.themes.error, failures]).toEqual(["default", "", []]);
  });
});

describe("collapsed folders", () => {
  test("start from what was stored before the page loaded", async () => {
    localStorage.setItem("shore.folders.collapsed", JSON.stringify({ ada: ["kept"] }));
    const { collapsedFolders } = await load();
    expect([...collapsedFolders.of("ada")]).toEqual(["kept"]);
  });

  test("are kept per character, toggled, stored, and told to subscribers until they leave", async () => {
    const { collapsedFolders } = await load();
    let heard = 0;
    const leave = collapsedFolders.subscribe(() => { heard += 1; });
    expect([...collapsedFolders.of("ada")]).toEqual([]);
    expect(collapsedFolders.of("ada")).toBe(collapsedFolders.of("ada"));
    collapsedFolders.toggle("ada", "work");
    collapsedFolders.toggle("ada", "play");
    expect([...collapsedFolders.of("ada")]).toEqual(["work", "play"]);
    collapsedFolders.toggle("ada", "work");
    expect([...collapsedFolders.of("ada")]).toEqual(["play"]);
    expect(JSON.parse(localStorage.getItem("shore.folders.collapsed") ?? "null")).toEqual({ ada: ["play"] });
    expect(heard).toBe(3);
    leave();
    collapsedFolders.toggle("bo", "x");
    expect(heard).toBe(3);
    expect([...collapsedFolders.of(null)]).toEqual([]);
  });

  test("are read again only when what is stored changed, and anything unreadable counts as none", async () => {
    const { collapsedFolders } = await load();
    let heard = 0;
    collapsedFolders.subscribe(() => { heard += 1; });
    collapsedFolders.reload();
    expect(heard).toBe(0);
    localStorage.setItem("shore.folders.collapsed", JSON.stringify({ ada: ["a"], "": ["none"], bo: "not a list" }));
    collapsedFolders.reload();
    expect(heard).toBe(1);
    expect([[...collapsedFolders.of("ada")], [...collapsedFolders.of(null)], [...collapsedFolders.of("bo")]]).toEqual([["a"], ["none"], []]);
    const kept = collapsedFolders.of("ada");
    collapsedFolders.reload();
    expect(collapsedFolders.of("ada")).toBe(kept);
    for (const raw of ["not json", "5", "null"]) {
      localStorage.setItem("shore.folders.collapsed", raw);
      collapsedFolders.reload();
      expect([...collapsedFolders.of("ada")], raw).toEqual([]);
    }
  });

  test("still toggle when storage refuses to keep them, cannot be read, or is blocked from the start", async () => {
    let written = 0;
    swap(globalThis, "localStorage", { getItem: () => null, setItem: () => { written += 1; throw new Error("quota"); } });
    const full = await load();
    full.collapsedFolders.toggle("ada", "work");
    expect([...full.collapsedFolders.of("ada")]).toEqual(["work"]);
    expect(written).toBe(1);
    restores.pop()?.();

    swap(globalThis, "localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { written += 1; } });
    const unreadable = await load();
    unreadable.collapsedFolders.toggle("ada", "work");
    expect([...unreadable.collapsedFolders.of("ada")]).toEqual(["work"]);
    expect(written, "it kept them in memory instead").toBe(1);
    restores.pop()?.();

    restores.push(blockStorage());
    const blocked = await load();
    blocked.collapsedFolders.toggle("ada", "work");
    blocked.collapsedFolders.reload();
    expect([...blocked.collapsedFolders.of("ada")], "kept in memory across a reload").toEqual(["work"]);
  });
});

describe("the app's hooks", () => {
  test("a conversation's busy flag follows its own requests", async () => {
    const state = await load();
    const socket = await connected(state);
    const hook = await renderHook(() => state.useConversationActive({ character: "ada", thread: "story" }), undefined);
    expect(hook.current()).toBe(false);
    let finished: Promise<unknown> = Promise.resolve();
    await acting(() => { finished = state.conversation.submit("message", { text: "hi", stream: true, images: [] }); });
    expect(hook.current()).toBe(true);
    const rid = socket.sent.at(-1)?.["rid"];
    await acting(async () => { socket.receive({ type: "request_finished", rid, outcome: "completed" }); await finished; });
    expect(hook.current()).toBe(false);
    await hook.unmount();
  });


  test("follow the workspace, its chrome, a chosen value and the settings stores", async () => {
    const state = await load();
    const hook = await renderHook(() => ({
      workspace: state.useWorkspace(), chrome: state.useChrome(), status: state.useWorkspaceValue((snapshot) => snapshot.status),
      theme: state.useTheme(), size: state.useFontSize(), notifications: state.useNotifications(), display: state.useDisplay(),
      active: state.useActiveRequests(), busy: state.useConversationActive({ character: "ada", thread: "story" }), compaction: state.useCompactionRecord(), folders: state.useCollapsedFolders("ada"),
    }), undefined);
    expect(hook.current()).toMatchObject({ status: "idle", theme: "default", size: "default", notifications: { unread: 0 }, compaction: null, busy: false });
    expect(hook.current().workspace).toBe(state.workspace.getSnapshot());
    expect(hook.current().display).toBe(state.display.getSnapshot().values);
    expect(hook.current().active).toBe(state.conversation.getSnapshot());
    const chrome = hook.current().chrome;
    await acting(() => { state.workspace.report("visible"); });
    expect(hook.current().chrome).not.toBe(chrome);
    expect(hook.current().chrome.error).toBe("visible");
    const steady = hook.current().chrome;
    await acting(() => { state.collapsedFolders.toggle("ada", "work"); });
    expect([...hook.current().folders]).toEqual(["work"]);
    expect(hook.current().chrome, "an unrelated change keeps the same chrome").toBe(steady);
    await hook.unmount();
  });
});
