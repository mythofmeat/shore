import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import type { ChromeSnapshot } from "../../src/browser/workspace.ts";
import { useApp } from "./app.ts";
import { acting, button, click, mount } from "./dom.ts";
import { replace } from "./daemon.ts";

const app = useApp();
const present = (found: Element | null | undefined): boolean => found !== null && found !== undefined;

const settle = async () => { await acting(() => Bun.sleep(5)); };
const thread = (id: string, extra: Partial<ThreadView> = {}): ThreadView => ({ id, created_at: "2026-11-01T00:00:00Z", compaction: false, home: false, current: false, ...extra });
const HOME = thread("story", { home: true, current: true, unread: 5 });
const FOLDERS = ["A", "B", "C", "D"].map((name) => ({ name }));
let threadsStarted = 0;

function serve(): void {
  app.answer((request) => {
    switch (request["name"]) {
      case "presence": return { statuses: [], history: [] };
      case "thread_move": case "thread_folder_move": return { character: "ada", threads: [HOME], home: "story", current: "story" };
      default: return undefined;
    }
  });
}

async function sidebar(over: Partial<ChromeSnapshot> = {}) {
  const { Sidebar } = await import("../../src/browser/sidebar/Sidebar.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { collapsedFolders } = app.state();
  app.restores.push(() => { for (const name of collapsedFolders.of("ada")) collapsedFolders.toggle("ada", name); });
  serve();
  const make = async (next: Partial<ChromeSnapshot>): Promise<ChromeSnapshot> => ({ ...chromeOf(undefined, app.state().workspace.getSnapshot()), status: "ready", character: "ada", thread: "story", threads: [HOME], ...over, ...next });
  const element = async (next: Partial<ChromeSnapshot>) => <Sidebar state={await make(next)} mobile={false} close={() => {}} collapse={() => {}} newCharacter={() => {}} newThread={() => { threadsStarted += 1; }} openSwitcher={() => {}} />;
  const view = await mount(await element({}));
  await settle();
  const rows = () => [...view.host.querySelectorAll(".sidebar-threads > .thread-row, .sidebar-threads .thread-folder > .thread-row")];
  const named = (name: string) => rows().find((row) => row.querySelector(".sidebar-name")?.textContent === name);
  return {
    ...view,
    rerender: async (next: Partial<ChromeSnapshot>) => { await view.update(await element(next)); await settle(); },
    names: () => rows().map((row) => row.querySelector(".sidebar-name")?.textContent),
    named,
    badge: (name: string) => named(name)?.querySelector(".sidebar-unread [aria-hidden]")?.textContent ?? null,
    menu: async (label: string) => {
      await click(view.host.querySelector(`[aria-label='${label}']`));
      return [...document.body.querySelectorAll<HTMLButtonElement>(`[role=menu][aria-label='${label}'] [role=menuitem]`)];
    },
  };
}

const sent = (since: number, name: string) => app.sent(since).filter((request) => request["name"] === name).map((request) => request["args"]);

async function dragOnto(target: Element | null | undefined, dragged: string) {
  const { THREAD_DRAG_TYPE } = await import("../../src/browser/sidebar/ThreadRow.tsx");
  const over = (type: string) => {
    const transfer = new DataTransfer();
    if (dragged !== "") transfer.setData(THREAD_DRAG_TYPE, dragged);
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: 0 } });
    target?.dispatchEvent(event);
    return event.defaultPrevented;
  };
  let prevented: boolean[] = [];
  await acting(() => { prevented = [over("dragover"), over("drop")]; });
  await acting(() => Bun.sleep(5));
  return prevented;
}

test("home comes first, then the loose threads, then each folder's; the open thread counts no unread messages", async () => {
  const view = await sidebar({
    threads: [HOME, thread("side", { unread: 2, last_active: "2026-11-03T00:00:00Z" }), thread("quiet"), thread("draft", { folder: "A", unread: 3 }), thread("old", { folder: "A" })],
    folders: [{ name: "A" }],
  });
  expect(view.names()).toEqual(["story", "side", "quiet", "A", "draft", "old"]);
  expect([view.badge("story"), view.badge("side"), view.badge("quiet"), view.badge("draft"), view.badge("old")]).toEqual([null, "2", null, "3", null]);
  expect(present(view.named("story")?.querySelector(".sidebar-item.on"))).toBe(true);
  await view.rerender({ thread: "side" });
  expect([view.badge("story"), view.badge("side")], "once another thread is open, home's own count shows").toEqual(["5", null]);
});

test("the open thread shows its unread count while the window is in the background", async () => {
  let focused = true;
  replace(app.restores, document, "hasFocus", () => focused);
  const view = await sidebar({ threads: [HOME, thread("side", { unread: 1 })] });
  expect([view.badge("story"), view.badge("side")]).toEqual([null, "1"]);
  focused = false;
  await acting(() => { dispatchEvent(new Event("blur")); });
  expect([view.badge("story"), view.badge("side")]).toEqual(["5", "1"]);
  focused = true;
  await acting(() => { dispatchEvent(new Event("focus")); });
  expect([view.badge("story"), view.badge("side")]).toEqual([null, "1"]);
});

test("a shut folder counts its threads' unread messages and still shows the open thread inside it", async () => {
  const threads = [HOME, thread("draft", { folder: "A", unread: 3 }), thread("old", { folder: "A", unread: 1 }), thread("blank", { folder: "A" })];
  const view = await sidebar({ threads, folders: [{ name: "A" }] });
  expect(view.badge("A"), "an open folder shows no count of its own").toBeNull();
  await click(view.named("A")?.querySelector("button.folder"));
  expect([view.names(), view.badge("A")]).toEqual([["story", "A"], "4"]);
  await view.rerender({ thread: "old" });
  expect([view.names(), view.badge("A")]).toEqual([["story", "A", "old"], "3"]);
});

test("threads on hold sit in a group of their own below a line under the folders; shut, it counts their unread messages and still shows the open one", async () => {
  const threads = [HOME, thread("side"), thread("paused", { on_hold: true, unread: 2, folder: "A" }), thread("stalled", { on_hold: true, unread: 1, last_active: "2026-11-05T00:00:00Z" })];
  const view = await sidebar({ threads, folders: [{ name: "A" }] });
  expect(view.names()).toEqual(["story", "side", "A", "On hold", "stalled", "paused"]);
  const list = [...view.host.querySelectorAll(".sidebar-threads > *")];
  expect(list.slice(-3).map((each) => each.tagName === "HR" ? "line" : each.getAttribute("aria-label"))).toEqual(["Folder A", "line", "On hold"]);
  expect([view.badge("On hold"), view.badge("stalled"), view.badge("paused")]).toEqual([null, "1", "2"]);
  await click(view.named("On hold")?.querySelector("button.folder"));
  expect([view.names(), view.badge("On hold")]).toEqual([["story", "side", "A", "On hold"], "3"]);
  await view.rerender({ thread: "paused" });
  expect([view.names(), view.badge("On hold")]).toEqual([["story", "side", "A", "On hold", "paused"], "1"]);
});

test("archived threads sit last in a group with the archive icon that starts shut and counts them, shut still shows the open one, and opened lists them latest first", async () => {
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const drawn = async (name: "archive") => {
    const icon = await mount(<Icon name={name} size={14} />);
    const html = icon.host.innerHTML;
    await icon.unmount();
    return html;
  };
  const threads = [HOME, thread("side"), thread("paused", { on_hold: true }), thread("gone", { archived: "2026-11-02T00:00:00Z" }), thread("long-gone", { archived: "2026-11-01T00:00:00Z" })];
  const view = await sidebar({ threads });
  const group = () => view.named("Archived")?.querySelector<HTMLButtonElement>("button.folder");
  const shown = () => [group()?.getAttribute("aria-expanded"), group()?.querySelector("svg")?.outerHTML, view.named("Archived")?.querySelector(".sidebar-time")?.textContent ?? null];
  expect(view.names()).toEqual(["story", "side", "On hold", "paused", "Archived"]);
  expect([...view.host.querySelectorAll(".sidebar-threads > *")].at(-1)?.getAttribute("aria-label")).toBe("Archived");
  expect(shown()).toEqual(["false", await drawn("archive"), "2"]);
  expect(group()?.textContent).toBe("Archived2(2 threads)");
  await click(group());
  expect([view.names(), ...shown()]).toEqual([["story", "side", "On hold", "paused", "Archived", "gone", "long-gone"], "true", await drawn("archive"), null]);
  await click(group());
  await view.rerender({ thread: "long-gone" });
  expect(view.names()).toEqual(["story", "side", "On hold", "paused", "Archived", "long-gone"]);
  await view.rerender({ thread: "long-gone", threads: threads.filter((each) => each.id !== "gone") });
  expect(group()?.textContent).toBe("Archived1(1 thread)");
  await view.rerender({ thread: "long-gone" });
  expect([view.named("long-gone")?.getAttribute("draggable"), view.named("side")?.getAttribute("draggable")], "an archived thread can't be dragged").toEqual(["false", "true"]);
  const offered = (await view.menu("Options for long-gone")).map((item) => item.textContent);
  expect(offered).toEqual(["Unarchive"]);
  const since = app.socket().sent.length;
  await click([...document.body.querySelectorAll<HTMLButtonElement>("[role=menu] [role=menuitem]")].find((item) => item.textContent === "Unarchive"));
  await settle();
  expect(sent(since, "unarchive_thread")).toEqual([{ name: "long-gone" }]);
  await view.rerender({ threads: [HOME, thread("side"), thread("gone", { archived: "2026-11-02T00:00:00Z" })] });
  expect([...view.host.querySelectorAll(".sidebar-threads > *")].slice(-2).map((each) => each.tagName === "HR" ? "line" : each.getAttribute("aria-label")), "archived threads alone get the line too").toEqual(["line", "Archived"]);
  await view.rerender({ threads: [HOME, thread("side")] });
  expect([view.named("Archived"), view.host.querySelector("hr")], "no archived or held threads, no group and no line").toEqual([undefined, null]);
});

test("a shut folder and the shut group of threads on hold count their threads marked for later apart from their unread messages", async () => {
  const marked = "2026-11-27T10:00:00Z";
  const threads = [HOME, thread("side", { folder: "A", later: marked }), thread("near", { folder: "A", later: marked, unread: 1 }), thread("far", { folder: "A" }), thread("paused", { on_hold: true, later: marked })];
  const view = await sidebar({ threads, folders: [{ name: "A" }] });
  const later = (name: string) => view.named(name)?.querySelector(".sidebar-later-count")?.textContent ?? null;
  expect([later("A"), later("On hold")], "open, each row shows its own mark").toEqual([null, null]);
  await click(view.named("A")?.querySelector("button.folder"));
  await click(view.named("On hold")?.querySelector("button.folder"));
  expect([later("A"), view.badge("A"), later("On hold"), view.badge("On hold")]).toEqual(["2(2 marked for later)", "1", "1(1 marked for later)", null]);
  await view.rerender({ threads: threads.map(({ later: _later, ...each }) => each) });
  expect([later("A"), later("On hold")], "nothing marked, nothing counted").toEqual([null, null]);
});

test("the group of threads on hold shows the pause icon open or shut, shut shows no count when nothing is unread, and its threads keep to the order they were last active in", async () => {
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const icon = async (name: "pause") => {
    const drawn = await mount(<Icon name={name} size={14} />);
    const html = drawn.host.innerHTML;
    await drawn.unmount();
    return html;
  };
  const view = await sidebar({ threads: [HOME, thread("stalled", { on_hold: true, last_active: "2026-11-05T00:00:00Z" }), thread("paused", { on_hold: true })], manualOrder: true });
  const toggle = () => view.named("On hold")?.querySelector("button.folder");
  const shows = () => [toggle()?.getAttribute("aria-expanded"), toggle()?.querySelector("svg")?.outerHTML, view.badge("On hold")];
  expect(shows()).toEqual(["true", await icon("pause"), null]);
  const moves = (await view.menu("Options for paused")).filter((item) => item.textContent.startsWith("Move ") && !item.textContent.includes("folder")).map((item) => [item.textContent, item.disabled]);
  expect(moves, "held threads keep to the order they were last active in").toEqual([]);
  await click(toggle());
  expect(shows()).toEqual(["false", await icon("pause"), null]);
});

test("a thread on hold can't be dragged out of its group, and nothing can be dropped on one", async () => {
  const view = await sidebar({ threads: [HOME, thread("side"), thread("paused", { on_hold: true })] });
  const started = (row: Element | undefined) => {
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: new DataTransfer() });
    row?.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect([started(view.named("side")), started(view.named("paused"))]).toEqual([false, true]);
  expect([(await dragOnto(view.named("side"), "paused"))[0], (await dragOnto(view.named("paused"), "side"))[0]]).toEqual([true, false]);
});

test("the thread opening is marked busy, unless it is already the one shown", async () => {
  const view = await sidebar({ threads: [HOME, thread("side")], opening: { character: "ada", thread: "side" } });
  expect([view.named("side")?.querySelector(".sidebar-item")?.getAttribute("aria-busy"), view.named("story")?.querySelector(".sidebar-item")?.getAttribute("aria-busy")]).toEqual(["true", "false"]);
  expect(present(view.named("side")?.querySelector(".sidebar-item.on")), "the thread opening is shown as the open one").toBe(true);
  await view.rerender({ threads: [HOME, thread("side")], thread: "side", opening: { character: "ada", thread: "side" } });
  expect(view.named("side")?.querySelector(".sidebar-item")?.getAttribute("aria-busy")).toBe("false");
});

test("threads sorted by activity don't offer to move up or down by hand, while a manual order does", async () => {
  const threads = [HOME, thread("side", { position: 1 }), thread("quiet", { position: 2 })];
  const sorted = await sidebar({ threads });
  const move = async (view: Awaited<ReturnType<typeof sidebar>>) => (await view.menu("Options for side")).filter((item) => item.textContent.startsWith("Move ") && !item.textContent.includes("folder")).map((item) => [item.textContent, item.disabled]);
  expect(await move(sorted)).toEqual([]);
  await sorted.unmount();
  const manual = await sidebar({ threads, manualOrder: true });
  expect(await move(manual)).toEqual([["Move up", true], ["Move down", false]]);
});

test("each folder can move above the one before it or below the one after it", async () => {
  const view = await sidebar({ folders: FOLDERS });
  const items = async (name: string) => {
    const shown = (await view.menu(`Options for folder ${name}`)).filter((item) => item.textContent.startsWith("Move folder"));
    return { disabled: shown.map((item) => item.disabled), pick: async (label: string) => { await click(shown.find((item) => item.textContent === label)); await acting(() => Bun.sleep(5)); } };
  };
  const since = app.socket().sent.length;
  const first = await items("A");
  expect(first.disabled).toEqual([true, false]);
  await first.pick("Move folder down");
  const second = await items("B");
  expect(second.disabled).toEqual([false, false]);
  await second.pick("Move folder up");
  expect((await items("C")).disabled, "the next-to-last can still move down").toEqual([false, false]);
  expect((await items("D")).disabled).toEqual([false, true]);
  expect(sent(since, "thread_folder_move")).toEqual([{ name: "A", before: "C" }, { name: "B", before: "A" }]);
});

test("a thread dropped on the list leaves its folder, dropped on a row lands beside it, and dropped on a folder goes into it", async () => {
  const threads = [HOME, thread("side", { position: 1 }), thread("quiet", { position: 2 }), thread("draft", { folder: "A" })];
  const view = await sidebar({ threads, folders: [{ name: "A" }], manualOrder: true });
  const since = app.socket().sent.length;
  expect(await dragOnto(view.host.querySelector(".sidebar-threads"), "draft")).toEqual([true, true]);
  expect(await dragOnto(view.host.querySelector(".sidebar-threads"), ""), "nothing was dragged").toEqual([false, false]);
  await dragOnto(view.named("side"), "draft");
  await dragOnto(view.named("A"), "quiet");
  await dragOnto(view.named("draft"), "side");
  expect(sent(since, "thread_move")).toEqual([{ name: "draft", folder: "" }, { name: "draft", folder: "", before: "side" }, { name: "quiet", folder: "A" }, { name: "side", folder: "A", before: "draft" }]);
});

test("a folder dragged onto another lands before or after it by where it is dropped, a thread still goes into it, and nothing moves when dropped on itself or a thread", async () => {
  const { FOLDER_DRAG_TYPE, THREAD_DRAG_TYPE } = await import("../../src/browser/sidebar/ThreadRow.tsx");
  const view = await sidebar({ folders: FOLDERS, threads: [HOME, thread("side")] });
  const fire = async (target: Element | null | undefined, type: string, data: Record<string, string>, clientY = 0) => {
    const transfer = new DataTransfer();
    for (const [kind, value] of Object.entries(data)) transfer.setData(kind, value);
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: clientY } });
    await acting(() => { target?.dispatchEvent(event); });
    await acting(() => Bun.sleep(5));
    return { prevented: event.defaultPrevented, dragged: transfer.getData(FOLDER_DRAG_TYPE), shown: view.named("C")?.className.split(" ").filter((name) => name.startsWith("drop-")) };
  };
  const folder = (name: string) => ({ [FOLDER_DRAG_TYPE]: name });
  expect([view.named("A")?.getAttribute("draggable"), (await fire(view.named("A"), "dragstart", {})).dragged]).toEqual(["true", "A"]);
  expect(await fire(view.named("C"), "dragover", folder("A"), 0)).toMatchObject({ prevented: true, shown: ["drop-before"] });
  expect(await fire(view.named("C"), "dragover", folder("A"), 10)).toMatchObject({ prevented: true, shown: ["drop-after"] });
  expect((await fire(view.named("C"), "dragleave", {})).shown).toEqual([]);
  expect(await fire(view.named("C"), "dragover", { [THREAD_DRAG_TYPE]: "side" })).toMatchObject({ prevented: true, shown: ["drop-into"] });
  expect(await fire(view.named("C"), "dragover", { "text/plain": "C" })).toMatchObject({ prevented: false, shown: ["drop-into"] });
  expect((await fire(view.named("side"), "dragover", folder("A"))).prevented, "a thread row takes no folder").toBe(false);
  const since = app.socket().sent.length;
  expect(await fire(view.named("C"), "drop", folder("A"), 0)).toMatchObject({ prevented: true, shown: [] });
  await fire(view.named("C"), "drop", folder("A"), 10);
  await fire(view.named("C"), "drop", folder("D"), 10);
  expect((await fire(view.named("C"), "drop", folder("C"), 10)).prevented, "a folder dropped on itself is taken but stays").toBe(true);
  expect((await fire(view.named("C"), "drop", {})).prevented).toBe(false);
  await fire(view.named("C"), "drop", { [THREAD_DRAG_TYPE]: "side" });
  expect(sent(since, "thread_folder_move")).toEqual([{ name: "A", before: "C" }, { name: "A", before: "D" }, { name: "D" }]);
  expect(sent(since, "thread_move")).toEqual([{ name: "side", folder: "C" }]);
  await view.rerender({ status: "connecting" });
  expect(view.named("A")?.getAttribute("draggable"), "nothing can be dragged until the daemon is ready").toBe("false");
});

test("a new thread is started from the + on the open character's row once the daemon is ready, and nowhere in the list of threads", async () => {
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const plus = await mount(<Icon name="plus" size={16} />);
  const drawn = plus.host.innerHTML;
  await plus.unmount();
  const ready = await sidebar({ characters: [{ name: "ada" }, { name: "bea" }] });
  const rows = [...ready.host.querySelectorAll(".character-row")];
  const offered = rows.map((row) => [row.querySelector(".sidebar-name")?.textContent, [...row.querySelectorAll("button")].some((each) => each.getAttribute("aria-label") === "New thread")]);
  expect(offered, "only the open character has one").toEqual([["ada", true], ["bea", false]]);
  expect(() => button(ready.host.querySelector(".sidebar-threads") ?? ready.host, "New thread")).toThrow("no button named New thread");
  const start = button(ready.host, "New thread");
  expect([start.disabled, start.querySelector("svg")?.outerHTML]).toEqual([false, drawn]);
  const before = threadsStarted;
  await click(start);
  expect(threadsStarted - before).toBe(1);
  await ready.unmount();
  const waiting = await sidebar({ status: "reconnecting" });
  expect(button(waiting.host, "New thread").disabled).toBe(true);
});

test("a thread with a reply on the way shows it, unless it is the open thread", async () => {
  const { conversation } = app.state();
  const quiet = await sidebar({ threads: [HOME, thread("side")] });
  expect(quiet.host.querySelectorAll(".sidebar-replying")).toHaveLength(0);
  await quiet.unmount();
  await acting(() => { void conversation.submit("message", { text: "hello" }).catch(() => undefined); });
  const view = await sidebar({ threads: [HOME, thread("side")] });
  expect(present(view.named("story")?.querySelector(".sidebar-replying")), "the reply is in the open thread").toBe(false);
  await view.rerender({ thread: "side" });
  expect([view.named("story")?.querySelector(".sidebar-replying .sr-only")?.textContent, present(view.named("side")?.querySelector(".sidebar-replying"))]).toEqual(["(replying)", false]);
});

test("a thread with an unsent message in this tab shows it, unless it is the open thread, and the mark follows the draft", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: new IDBFactory() });
  app.restores.push(() => { if (original === undefined) Reflect.deleteProperty(globalThis, "indexedDB"); else Object.defineProperty(globalThis, "indexedDB", original); });
  const { browserDraft } = await import("../../src/browser/drafts.ts");
  await browserDraft(JSON.stringify(["ada", "side"])).save({ text: "half a thought", images: [] });
  await browserDraft(JSON.stringify(["ada", "story"])).save({ text: "and one here", images: [] });
  await browserDraft(JSON.stringify(["ada", "settings"])).save({ text: "", images: [], options: { stream: false } });
  const view = await sidebar({ threads: [HOME, thread("side"), thread("quiet"), thread("settings")] });
  const marked = () => view.names().filter((name) => present(view.named(name ?? "")?.querySelector(".sidebar-draft")));
  expect(marked(), "the open thread's draft is in its message box").toEqual(["side"]);
  await acting(() => browserDraft(JSON.stringify(["ada", "quiet"])).save({ text: "", images: [{ filename: "a.png", mime_type: "image/png", data: "AAAA" }] }));
  await settle();
  expect(marked()).toEqual(["side", "quiet"]);
  await acting(() => browserDraft(JSON.stringify(["ada", "side"])).save({ text: "", images: [] }));
  await settle();
  expect(marked()).toEqual(["quiet"]);
  await view.rerender({ thread: "quiet" });
  expect(marked()).toEqual(["story"]);
  sessionStorage.clear();
  await acting(() => browserDraft(JSON.stringify(["ada", "other"])).save({ text: "x", images: [] }));
  await settle();
  expect(marked(), "another tab's drafts aren't shown").toEqual([]);
});
