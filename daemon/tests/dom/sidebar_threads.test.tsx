import { expect, test } from "bun:test";

import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import type { ChromeSnapshot } from "../../src/browser/workspace.ts";
import { useApp } from "./app.ts";
import { acting, button, click, mount } from "./dom.ts";

const app = useApp();
const present = (found: Element | null | undefined): boolean => found !== null && found !== undefined;

const settle = async () => { await acting(() => Bun.sleep(5)); };
const thread = (id: string, extra: Partial<ThreadView> = {}): ThreadView => ({ id, created_at: "2026-11-01T00:00:00Z", compaction: false, home: false, current: false, ...extra });
const HOME = thread("story", { home: true, current: true, unread: 5 });
const FOLDERS = ["A", "B", "C", "D"].map((name) => ({ name }));

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
  const element = async (next: Partial<ChromeSnapshot>) => <Sidebar state={await make(next)} mobile={false} close={() => {}} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} />;
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

test("a shut folder counts its threads' unread messages and still shows the open thread inside it", async () => {
  const threads = [HOME, thread("draft", { folder: "A", unread: 3 }), thread("old", { folder: "A", unread: 1 }), thread("blank", { folder: "A" })];
  const view = await sidebar({ threads, folders: [{ name: "A" }] });
  expect(view.badge("A"), "an open folder shows no count of its own").toBeNull();
  await click(view.named("A")?.querySelector("button.folder"));
  expect([view.names(), view.badge("A")]).toEqual([["story", "A"], "4"]);
  await view.rerender({ thread: "old" });
  expect([view.names(), view.badge("A")]).toEqual([["story", "A", "old"], "3"]);
});

test("threads on hold sit in a group of their own after the new-thread button; shut, it counts their unread messages and still shows the open one", async () => {
  const threads = [HOME, thread("side"), thread("paused", { on_hold: true, unread: 2, folder: "A" }), thread("stalled", { on_hold: true, unread: 1, last_active: "2026-11-05T00:00:00Z" })];
  const view = await sidebar({ threads, folders: [{ name: "A" }] });
  expect(view.names()).toEqual(["story", "side", "A", "On hold", "stalled", "paused"]);
  const list = [...view.host.querySelectorAll(".sidebar-threads > *")];
  expect(list.slice(-2).map((each) => each.getAttribute("aria-label") ?? each.textContent)).toEqual(["New thread", "On hold"]);
  expect([view.badge("On hold"), view.badge("stalled"), view.badge("paused")]).toEqual([null, "1", "2"]);
  await click(view.named("On hold")?.querySelector("button.folder"));
  expect([view.names(), view.badge("On hold")]).toEqual([["story", "side", "A", "On hold"], "3"]);
  await view.rerender({ thread: "paused" });
  expect([view.names(), view.badge("On hold")]).toEqual([["story", "side", "A", "On hold", "paused"], "1"]);
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

test("threads sorted by activity can't be moved up or down by hand, while a manual order can", async () => {
  const threads = [HOME, thread("side", { position: 1 }), thread("quiet", { position: 2 })];
  const sorted = await sidebar({ threads });
  const move = async (view: Awaited<ReturnType<typeof sidebar>>) => (await view.menu("Options for side")).filter((item) => item.textContent.startsWith("Move ") && !item.textContent.includes("folder")).map((item) => [item.textContent, item.disabled]);
  expect(await move(sorted)).toEqual([["Move up", true], ["Move down", true]]);
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

test("a new thread can be started once the daemon is ready", async () => {
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const plus = await mount(<Icon name="plus" size={14} />);
  const drawn = plus.host.innerHTML;
  await plus.unmount();
  const ready = await sidebar();
  expect([button(ready.host, "New thread").disabled, button(ready.host, "New thread").querySelector("svg")?.outerHTML]).toEqual([false, drawn]);
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
