import { expect, spyOn, test } from "bun:test";

import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import type { ChromeSnapshot } from "../../src/browser/workspace.ts";
import { useApp } from "./app.ts";
import { HISTORY, replace } from "./daemon.ts";
import { acting, click, mount } from "./dom.ts";

const app = useApp();
const present = (found: Element | null | undefined): boolean => found !== null && found !== undefined;

const settle = async () => { await acting(() => Bun.sleep(5)); };
const frame = async () => { await acting(async () => { await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); }); }); };

const HOME: ThreadView = { id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true };
const SIDE: ThreadView = { id: "side", created_at: "2026-11-02T00:00:00Z", compaction: false, home: false, current: false };
const NOTES: ThreadView = { id: "notes", created_at: "2026-11-03T00:00:00Z", compaction: false, home: false, current: false };
const MOD = { ctrlKey: true, metaKey: true };
const START = "/workspace/ada/story";

async function chrome(over: Partial<ChromeSnapshot> = {}): Promise<ChromeSnapshot> {
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  return { ...chromeOf(undefined, app.state().workspace.getSnapshot()), status: "ready", character: "ada", thread: "story", threads: [HOME, SIDE], ...over };
}

async function shell(over: Partial<ChromeSnapshot> = {}) {
  const { Shell } = await import("../../src/browser/app/Shell.tsx");
  const { navigate } = await import("../../src/browser/app/route.ts");
  app.restores.push(() => { navigate({ view: "chat" }); history.replaceState(null, "", START); localStorage.clear(); });
  serve();
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  await acting(() => { for (const shown of toasts.getSnapshot()) toasts.dismiss(shown.id); });
  const view = await mount(<Shell state={await chrome(over)} />);
  await settle();
  const root = () => view.host.querySelector(".shell");
  return {
    ...view,
    rerender: async (next: Partial<ChromeSnapshot>) => { await view.update(<Shell state={await chrome(next)} />); await settle(); },
    layout: () => [root()?.getAttribute("data-layout"), root()?.getAttribute("data-sidebar"), view.host.querySelector("aside.sidebar") !== null, view.host.querySelector(".scrim") !== null],
    dialog: () => document.body.querySelector("dialog h2")?.textContent,
  };
}

async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...init });
  await acting(() => { target.dispatchEvent(event); });
  await settle();
  return event;
}

function screen(narrow: boolean) {
  const original = globalThis.matchMedia.bind(globalThis);
  const listeners = new Set<() => void>();
  let matches = narrow;
  replace(app.restores, globalThis, "matchMedia", (query: string) => query !== "(max-width: 860px)" ? original(query) : {
    matches, media: query,
    addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
  });
  return { set: async (next: boolean) => { matches = next; await acting(() => { for (const listener of listeners) listener(); }); } };
}

const MODELS = {
  models: { anthropic: [{ name: "opus", qualified_name: "anthropic:opus", sdk: "anthropic", model_id: "opus", source: "static", hidden: false, favorite: false }] }, active: "anthropic:opus",
  roles: [{ role: "chat", model: "anthropic:opus", source: "character" }], include_hidden: false, favorites_only: false, favorite_count: 0, hidden_count: 0,
};
const SETTINGS = { model: "anthropic:opus", provider: "anthropic", model_id: "opus", effective_sampler: {}, saved_global: {}, saved_character: {}, setting_schema: [], scopes: {} };

function serve(): void {
  app.answer((request) => {
    switch (request["name"]) {
      case "presence": return { statuses: [], history: [] };
      case "list_models": return MODELS;
      case "model_settings": return SETTINGS;
      case "switch_thread": return { character: "ada", thread: (request["args"] as { name: string }).name, changed: false };
      default: return undefined;
    }
  });
}

const switched = (since: number) => app.sent(since).filter((request) => request["name"] === "switch_thread").map((request) => request["args"]);

test("on a wide screen the sidebar shows until it is collapsed or hidden, and the choice is kept", async () => {
  const view = await shell();
  expect(view.layout()).toEqual(["desktop", "open", true, false]);
  expect(view.dialog(), "no dialog is open to start with").toBeUndefined();
  await click(view.host.querySelector("[aria-label='Collapse sidebar']"));
  expect([view.layout(), localStorage.getItem("shore.sidebar")]).toEqual([["desktop", "closed", false, false], "false"]);
  const shown = await press("\\", MOD);
  expect([view.layout(), localStorage.getItem("shore.sidebar"), shown.defaultPrevented, location.hash]).toEqual([["desktop", "open", true, false], "true", true, ""]);
  await press("\\", MOD);
  expect(view.layout()).toEqual(["desktop", "closed", false, false]);
});

test("on a narrow screen the sidebar is a drawer that the scrim, Escape, another thread or a wider screen closes", async () => {
  const size = screen(true);
  const since = app.socket().sent.length;
  const view = await shell();
  expect([view.layout(), app.sent(since).filter((request) => request["name"] === "presence")], "the sidebar was never drawn").toEqual([["mobile", "closed", false, false], []]);
  await press("\\", MOD);
  expect([view.layout(), view.host.querySelector(".scrim")?.getAttribute("tabindex"), localStorage.getItem("shore.sidebar")]).toEqual([["mobile", "open", true, true], "-1", null]);
  await press("\\", MOD);
  expect(view.layout(), "the shortcut closes it again").toEqual(["mobile", "closed", false, false]);
  await press("\\", MOD);
  await click(view.host.querySelector(".scrim"));
  expect(view.layout()).toEqual(["mobile", "closed", false, false]);
  await press("\\", MOD);
  await press("Escape");
  expect(view.layout()).toEqual(["mobile", "closed", false, false]);
  await press("Escape");
  expect(view.layout(), "Escape with the drawer shut leaves it shut").toEqual(["mobile", "closed", false, false]);
  await press("\\", MOD);
  await view.rerender({ thread: "side" });
  expect(view.layout()).toEqual(["mobile", "closed", false, false]);
  await press("\\", MOD);
  await size.set(false);
  expect(view.layout(), "the wide layout keeps its own choice").toEqual(["desktop", "open", true, false]);
  await size.set(true);
  expect(view.layout(), "back on the narrow screen the drawer starts shut").toEqual(["mobile", "closed", false, false]);
});

test("the shortcuts open the palette, a new thread, settings and the keyboard help, and focus the message box", async () => {
  const { navigate } = await import("../../src/browser/app/route.ts");
  const palette = await shell();
  await acting(() => { navigate({ view: "settings", page: "usage" }); });
  await press("k", MOD);
  expect([palette.dialog(), location.hash]).toEqual(["Command palette", "#settings/usage"]);
  await palette.unmount();

  const focus = await shell();
  await acting(() => { navigate({ view: "settings", page: "usage" }); });
  await press("/", MOD);
  await frame();
  expect([location.hash, document.activeElement?.id, focus.dialog()]).toEqual(["", "message-composer", undefined]);
  const elsewhere = document.body.querySelector<HTMLElement>("[aria-label='Collapse sidebar']");
  elsewhere?.focus();
  expect(document.activeElement).toBe(elsewhere);
  await press("/", MOD, elsewhere ?? document.body);
  await frame();
  expect(document.activeElement?.id, "from the chat too").toBe("message-composer");
  await focus.unmount();

  const thread = await shell();
  await press("O", { ...MOD, shiftKey: true });
  expect([thread.dialog(), thread.layout()[1]]).toEqual(["New thread with ada", "open"]);
  await thread.unmount();

  const settings = await shell();
  localStorage.removeItem("shore.settings-page");
  await press(",", MOD);
  expect([location.hash, settings.layout()[1]]).toEqual(["#settings/models", "open"]);
  await settings.unmount();

  const since = app.socket().sent.length;
  await shell();
  await press("?");
  expect([location.hash, switched(since)]).toEqual(["#settings/keyboard", []]);
});

test("Mod, Shift and L mark the open thread for later or clear its mark, once connected, and do nothing else", async () => {
  const later = (since: number) => app.sent(since).filter((request) => request["name"] === "thread_later").map((request) => request["args"]);
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const view = await shell();
  let since = app.sent(0).length;
  await press("ArrowDown", { altKey: true });
  expect(later(since), "the next thread is only opened").toEqual([]);
  since = app.sent(0).length;
  await press("L", { ...MOD, shiftKey: true });
  expect(later(since)).toEqual([{ name: "story", later: true }]);
  expect([switched(since), toasts.getSnapshot().map((toast) => toast.text)], "nothing else is opened or said").toEqual([[], []]);
  await view.rerender({ threads: [{ ...HOME, later: "2026-11-27T10:00:00Z" }, SIDE] });
  since = app.sent(0).length;
  await press("l", { ...MOD, shiftKey: true });
  expect(later(since)).toEqual([{ name: "story", later: false }]);
  await view.rerender({ status: "connecting" });
  since = app.sent(0).length;
  await press("l", { ...MOD, shiftKey: true });
  await view.rerender({ thread: "gone" });
  await press("l", { ...MOD, shiftKey: true });
  expect(later(since), "nothing to mark until connected, or with no thread open").toEqual([]);
});

test("the sidebar's search opens the switcher, where Enter goes back to the thread open before this one", async () => {
  const threads = [{ ...HOME, last_active: "2026-11-27T10:00:00Z" }, SIDE, NOTES];
  const view = await shell({ threads });
  await view.rerender({ thread: "side", threads });
  await view.rerender({ thread: "notes", threads });
  await click(document.body.querySelector("button.sidebar-search"));
  expect(view.dialog()).toBe("Command palette");
  const since = app.sent(0).length;
  await press("Enter", {}, document.body.querySelector("dialog input[type=search]") ?? document.body);
  expect(switched(since)).toEqual([{ name: "side", resync: true }]);
});

test("a new thread waits for a character and the connection", async () => {
  const reconnecting = await shell({ status: "reconnecting" });
  await press("O", { ...MOD, shiftKey: true });
  expect(reconnecting.dialog()).toBeUndefined();
  await reconnecting.unmount();

  const nobody = await shell({ character: null, thread: null });
  await press("O", { ...MOD, shiftKey: true });
  await nobody.rerender({});
  expect(nobody.dialog(), "choosing a character later doesn't bring the dialog up").toBeUndefined();
});

test("the help key is a key typed into a box while typing, and other keys are left to the page", async () => {
  await shell();
  const box = document.body.querySelector("#message-composer");
  if (box === null) throw new Error("no message box");
  expect((await press("?", {}, box)).defaultPrevented).toBe(false);
  expect(location.hash).toBe("");
  await press("?", {}, window);
  expect(location.hash, "a key with no element behind it").toBe("#settings/keyboard");
  await acting(() => { history.pushState(null, "", START); dispatchEvent(new HashChangeEvent("hashchange")); });
  await press("?", {}, document.body.querySelector("[aria-label='Collapse sidebar']") ?? document.body);
  expect(location.hash).toBe("#settings/keyboard");
  expect((await press("x")).defaultPrevented).toBe(false);
});

test("shortcuts are left alone while composing, once another handler took the key, with a dialog open, and once the shell is gone", async () => {
  const view = await shell();
  await press(",", { ...MOD, isComposing: true });
  const taken = document.createElement("button");
  taken.addEventListener("keydown", (event) => { event.preventDefault(); });
  document.body.append(taken);
  await press(",", MOD, taken);
  taken.remove();
  expect(location.hash).toBe("");
  await press("k", MOD);
  expect(present(document.body.querySelector("dialog[open]"))).toBe(true);
  await press(",", MOD);
  expect(location.hash).toBe("");
  await view.unmount();
  await press(",", MOD);
  expect(location.hash).toBe("");
});

test("Alt and the arrows open the thread above or below, from the one opening, once connected", async () => {
  const threads = [HOME, SIDE, NOTES];
  const view = await shell({ threads });
  let since = app.socket().sent.length;
  await press("ArrowDown", { altKey: true });
  expect([switched(since), document.body.querySelector(".toast")?.textContent], "the newest thread is listed first").toEqual([[{ name: "notes", resync: true }], undefined]);
  since = app.socket().sent.length;
  await press("ArrowUp", { altKey: true });
  expect(switched(since), "up from the top is the bottom").toEqual([{ name: "side", resync: true }]);
  await view.unmount();

  const opening = await shell({ threads, opening: { character: "ada", thread: "notes" } });
  since = app.socket().sent.length;
  await press("ArrowDown", { altKey: true });
  expect(switched(since)).toEqual([{ name: "side", resync: true }]);
  await opening.unmount();

  const alone = await shell({ threads: [HOME] });
  since = app.socket().sent.length;
  await press("ArrowDown", { altKey: true });
  expect(switched(since), "there is no other thread").toEqual([]);
  await alone.unmount();

  await shell({ threads, status: "reconnecting" });
  since = app.socket().sent.length;
  await press("ArrowDown", { altKey: true });
  expect(switched(since)).toEqual([]);
});

test("Alt, Shift and Down open the next thread with unread messages, or say there is none", async () => {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  app.restores.push(() => { for (const shown of toasts.getSnapshot()) toasts.dismiss(shown.id); });
  const unread = [HOME, { ...SIDE, unread: 2 }];
  const view = await shell({ threads: unread });
  let since = app.socket().sent.length;
  await press("ArrowDown", { altKey: true, shiftKey: true });
  expect([switched(since), toasts.getSnapshot()]).toEqual([[{ name: "side", resync: true }], []]);
  await view.unmount();

  const waiting = await shell({ threads: unread, status: "reconnecting" });
  since = app.socket().sent.length;
  await press("ArrowDown", { altKey: true, shiftKey: true });
  expect([switched(since), toasts.getSnapshot()]).toEqual([[], []]);
  await waiting.unmount();

  await shell();
  since = app.socket().sent.length;
  await press("ArrowDown", { altKey: true, shiftKey: true });
  expect([switched(since), toasts.getSnapshot().map((shown) => shown.text)]).toEqual([[], ["No unread messages in other threads"]]);
});

test("a thread or folder dialog asked for from elsewhere opens over the shell, and a shell that is gone stops listening", async () => {
  const { FOLDER_DIALOG_EVENT, THREAD_DIALOG_EVENT, openFolderDialog, openThreadDialog } = await import("../../src/browser/app/intents.ts");
  const added = spyOn(window, "addEventListener");
  const removed = spyOn(window, "removeEventListener");
  app.restores.push(() => { added.mockRestore(); removed.mockRestore(); });
  const threadView = await shell();
  await acting(() => { openThreadDialog("settings", "side"); });
  expect(threadView.dialog()).toBe("Thread settings");
  await threadView.unmount();
  const folderView = await shell();
  await acting(() => { openFolderDialog({ kind: "new" }); });
  expect(folderView.dialog()).toBe("New folder");
  await folderView.unmount();
  for (const name of [THREAD_DIALOG_EVENT, FOLDER_DIALOG_EVENT]) {
    const listening = (calls: readonly (readonly unknown[])[]) => calls.filter(([type]) => type === name).map(([, listener]) => listener);
    expect(listening(added.mock.calls), name).not.toEqual([]);
    expect(listening(added.mock.calls).filter((listener) => !listening(removed.mock.calls).includes(listener)), name).toEqual([]);
  }
});

test("the sidebar's new character button opens its dialog", async () => {
  const view = await shell();
  await click(view.host.querySelector("[aria-label='New character']"));
  expect(view.dialog()).toBe("New character");
});

test("an error from the daemon is shown once as an error toast and then cleared", async () => {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  app.restores.push(() => { for (const shown of toasts.getSnapshot()) toasts.dismiss(shown.id); });
  const { workspace } = app.state();
  const quiet = await shell();
  expect(toasts.getSnapshot()).toEqual([]);
  await quiet.unmount();
  await acting(() => { workspace.report("the daemon fell over"); });
  const view = await shell();
  const shown = [...view.host.querySelectorAll(".toast.error")].map((toast) => toast.textContent);
  expect([shown.length, shown[0]?.includes("the daemon fell over")]).toEqual([1, true]);
  expect(workspace.getSnapshot().error).toBe("");
});

test("the address names the open character and thread, keeps the page's hash, and each switch is a new entry in the history", async () => {
  const { navigate } = await import("../../src/browser/app/route.ts");
  const replaced = spyOn(history, "replaceState");
  const pushed = spyOn(history, "pushState");
  app.restores.push(() => { replaced.mockRestore(); pushed.mockRestore(); });
  const view = await shell();
  expect([location.pathname, replaced.mock.calls.length, pushed.mock.calls.length]).toEqual([START, 0, 0]);
  await view.rerender({ thread: "side" });
  expect([location.pathname, pushed.mock.calls.length, replaced.mock.calls.length]).toEqual(["/workspace/ada/side", 1, 0]);
  await view.rerender({ thread: null });
  expect([location.pathname, pushed.mock.calls.length]).toEqual(["/workspace/ada/main", 2]);
  await acting(() => { navigate({ view: "settings", page: "usage" }); });
  const settings = pushed.mock.calls.length;
  await view.rerender({ character: "a b", thread: "c/d" });
  expect([location.pathname, location.hash, pushed.mock.calls.length]).toEqual(["/workspace/a%20b/c%2Fd", "#settings/usage", settings + 1]);
  await view.rerender({ character: null, thread: null });
  expect(location.pathname, "with no character the address stays").toBe("/workspace/a%20b/c%2Fd");
});

test("an address naming a thread or character that isn't there says so once, and an address that names neither says nothing", async () => {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const said = async (path: string, over: Partial<ChromeSnapshot> = {}) => {
    history.replaceState(null, "", path);
    const view = await shell(over);
    const shown = toasts.getSnapshot().map((toast) => [toast.text, toast.tone]);
    await view.rerender({ ...over, thread: "side" });
    const after = toasts.getSnapshot().length;
    await view.unmount();
    return [shown, after];
  };
  expect(await said("/workspace/ada/gone")).toEqual([[["ada has no thread “gone”, so this is story", "error"]], 1]);
  expect(await said("/workspace/bo/notes")).toEqual([[["There is no character “bo”, so this is ada", "error"]], 1]);
  expect(await said("/workspace/ada/gone", { thread: null })).toEqual([[["ada has no thread “gone”, so this is main", "error"]], 1]);
  expect(await said("/workspace")).toEqual([[], 0]);
  expect(await said(START)).toEqual([[], 0]);
});

test("the first address the shell sees is replaced, not added to the history", async () => {
  history.replaceState(null, "", "/workspace");
  const pushed = spyOn(history, "pushState");
  app.restores.push(() => { pushed.mockRestore(); });
  await shell();
  expect([location.pathname, pushed.mock.calls.length]).toEqual([START, 0]);
});

test("Back and Forward open the thread the address names, without adding to the history, and leave the shown thread alone", async () => {
  const pushed = spyOn(history, "pushState");
  app.restores.push(() => { pushed.mockRestore(); });
  const view = await shell();
  let revision = 10;
  const select = (thread: string, character = "ada") => { app.socket().receive({ ...HISTORY, revision: ++revision, selected_character: character, selected_thread: thread }); };
  app.restores.push(() => { select("story"); });
  app.answer((request) => {
    const name = (request["args"] as { name?: string } | undefined)?.name ?? "";
    switch (request["name"]) {
      case "switch_thread": select(name); return { character: "ada", thread: name, changed: true };
      case "switch_character": select("main", name); return { character: name, changed: true };
      case "presence": return { statuses: [], history: [] };
      default: return undefined;
    }
  });
  await acting(() => { select("side"); });
  await view.rerender({ thread: "side" });
  const back = async (path: string) => {
    const since = app.sent(0).length;
    history.replaceState(null, "", path);
    await acting(() => { dispatchEvent(new PopStateEvent("popstate")); });
    await settle();
    return app.sent(since).filter((request) => String(request["name"]).startsWith("switch_")).map((request) => [request["name"], request["args"]]);
  };
  expect(await back(START)).toEqual([["switch_thread", { name: "story", resync: true }]]);
  await view.rerender({ thread: "story" });
  expect([location.pathname, pushed.mock.calls.length], "the thread Back opened stays where it was").toEqual([START, 1]);
  expect(await back(START), "a change of hash alone opens nothing").toEqual([]);
  expect(await back("/elsewhere"), "an address that names no thread opens nothing").toEqual([]);
  expect(await back("/workspace/ada/side")).toEqual([["switch_thread", { name: "side", resync: true }]]);
  await view.rerender({ thread: "side" });
  expect(await back("/workspace/bea/main"), "the character's own thread opens with it").toEqual([["switch_character", { name: "bea" }]]);
  await view.unmount();
  expect(await back("/workspace/ada/notes"), "a shell that is gone stops following the address").toEqual([]);
});

test("the tab title names the thread and character, or settings, counts the unread replies the daemon counts, and goes back to Shore when the shell closes", async () => {
  const { navigate } = await import("../../src/browser/app/route.ts");
  const view = await shell();
  expect(document.title).toBe("story · ada");
  await view.rerender({ thread: "side", threads: [HOME, { ...SIDE, label: "Side quest" }] });
  expect(document.title, "a thread with a label goes by it").toBe("Side quest · ada");
  await view.rerender({ thread: "gone" });
  expect(document.title, "a thread not in the list goes by its name").toBe("gone · ada");
  await view.rerender({ thread: null });
  expect(document.title).toBe("main · ada");
  await view.rerender({ character: null, thread: null });
  expect(document.title).toBe("Shore");
  await acting(() => { navigate({ view: "settings", page: "usage" }); });
  expect([document.title, view.host.querySelector(".settings-nav") !== null]).toEqual(["Settings · Shore", true]);
  await acting(() => { navigate({ view: "chat" }); });
  await view.rerender({});
  expect(present(view.host.querySelector(".settings-nav"))).toBe(false);
  let focused = true;
  replace(app.restores, document, "hasFocus", () => focused);
  await view.rerender({ threads: [{ ...HOME, unread: 2 }, { ...SIDE, unread: 3 }] });
  expect(document.title, "the open thread's replies are being read").toBe("(3) story · ada");
  focused = false;
  await acting(() => { dispatchEvent(new Event("blur")); });
  expect(document.title, "while the window is in the background they count too").toBe("(5) story · ada");
  focused = true;
  await acting(() => { dispatchEvent(new Event("focus")); });
  expect(document.title).toBe("(3) story · ada");
  await view.rerender({ threads: [{ ...HOME, unread: 2 }, { ...SIDE, unread: 1 }] });
  expect(document.title).toBe("(1) story · ada");
  await view.rerender({ threads: [{ ...HOME, unread: 2 }, { ...SIDE, unread: 0 }] });
  expect(document.title).toBe("story · ada");
  await view.unmount();
  expect(document.title).toBe("Shore");
});
