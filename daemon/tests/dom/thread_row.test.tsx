import { expect, spyOn, test } from "bun:test";

import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import { useApp } from "./app.ts";
import { acting, click, mount } from "./dom.ts";

useApp();
const present = (found: Element | null | undefined): boolean => found !== null && found !== undefined;

const HOME: ThreadView = { id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true };
const SIDE: ThreadView = { id: "side", created_at: "2026-11-02T00:00:00Z", compaction: false, home: false, current: false };
const NEIGHBOURS = { up: undefined, down: undefined, atEnd: true, byActivity: false };

interface Shown { thread?: ThreadView; current?: boolean; unread?: number; drafted?: boolean; replying?: boolean; opening?: boolean; ready?: boolean }

async function row(shown: Shown = {}) {
  const { ThreadRow, THREAD_DRAG_TYPE } = await import("../../src/browser/sidebar/ThreadRow.tsx");
  const selected: number[] = [];
  const dropped: [string, boolean][] = [];
  const outside: string[] = [];
  const thread = shown.thread ?? SIDE;
  const view = await mount(<div onDragOver={() => outside.push("over")} onDrop={() => outside.push("drop")}>
    <ThreadRow thread={thread} label={thread.label ?? thread.id} current={shown.current ?? false} unread={shown.unread ?? 0} drafted={shown.drafted ?? false} replying={shown.replying ?? false} opening={shown.opening ?? false}
      ready={shown.ready ?? true} select={() => selected.push(1)} neighbours={NEIGHBOURS} drop={(id, after) => dropped.push([id, after])} />
  </div>);
  const box = () => view.host.querySelector(".thread-row");
  const item = () => view.host.querySelector<HTMLElement>(".sidebar-item");
  const drag = async (type: string, data: Record<string, string>, clientY = 0) => {
    const transfer = new DataTransfer();
    for (const [kind, value] of Object.entries(data)) transfer.setData(kind, value);
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: clientY } });
    await acting(() => { box()?.dispatchEvent(event); });
    return { prevented: event.defaultPrevented, transfer };
  };
  return { ...view, box, item, selected, dropped, outside, drag, thread: (id: string) => ({ [THREAD_DRAG_TYPE]: id }), type: THREAD_DRAG_TYPE };
}

async function icon(name: "home" | "chat" | "lock" | "edit" | "more", size: number): Promise<string> {
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const drawn = await mount(<Icon name={name} size={size} />);
  const html = drawn.host.innerHTML;
  await drawn.unmount();
  return html;
}

test("a row names its thread, with its full label and purpose in its tooltip, and marks the open one", async () => {
  const home = await row({ thread: HOME, current: true });
  expect([home.item()?.querySelector("svg")?.outerHTML, home.item()?.classList.contains("on"), home.item()?.getAttribute("aria-current"), home.item()?.querySelector(".sidebar-name")?.textContent, home.item()?.getAttribute("title")]).toEqual([await icon("home", 14), true, "page", "story", "story"]);
  await home.unmount();
  const side = await row({ thread: { ...SIDE, label: "A side road with a long name", purpose: "Where the detours go" } });
  expect([side.item()?.querySelector("svg"), side.item()?.classList.contains("on"), side.item()?.getAttribute("aria-current"), side.item()?.getAttribute("title")]).toEqual([null, false, null, "A side road with a long name\nWhere the detours go"]);
  await side.unmount();
  const blank = await row({ thread: { ...SIDE, purpose: "" } });
  expect(blank.item()?.getAttribute("title")).toBe("side");
});

test("a row ends with how long ago its last message was, or says it is empty", async () => {
  const { rowTime } = await import("../../src/browser/sidebar/row_time.ts");
  const quiet = await row();
  expect([quiet.item()?.querySelector(".sidebar-time")?.textContent, quiet.item()?.querySelector(".sidebar-time")?.getAttribute("title")]).toEqual(["empty", "No messages yet"]);
  await quiet.unmount();
  const at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const used = await row({ thread: { ...SIDE, last_active: at } });
  expect([used.item()?.querySelector(".sidebar-time")?.textContent, used.item()?.querySelector(".sidebar-time")?.getAttribute("title")]).toEqual(["3h", rowTime(at, Date.now()).title]);
});

test("a row shows unread messages, a lock, an unsent message, and a reply or an opening under way", async () => {
  const quiet = await row();
  expect([quiet.item()?.classList.contains("unread"), present(quiet.item()?.querySelector(".sidebar-unread")), present(quiet.item()?.querySelector(".sidebar-locked")), present(quiet.item()?.querySelector(".sidebar-draft")), present(quiet.item()?.querySelector(".sidebar-replying")), quiet.item()?.getAttribute("aria-busy")]).toEqual([false, false, false, false, false, "false"]);
  await quiet.unmount();
  const one = await row({ unread: 1, drafted: true, thread: { ...SIDE, locked: true } });
  expect([one.item()?.classList.contains("unread"), one.item()?.querySelector(".sidebar-unread [aria-hidden]")?.textContent]).toEqual([true, "1"]);
  expect(one.item()?.querySelector(".sidebar-locked")?.outerHTML).toBe(`<span class="sidebar-locked" title="Locked: only you change its label, purpose and pins">${await icon("lock", 12)}<span class="sr-only">(locked)</span></span>`);
  expect(one.item()?.querySelector(".sidebar-draft")?.outerHTML).toBe(`<span class="sidebar-draft" title="An unsent message in this tab">${await icon("edit", 12)}<span class="sr-only">(unsent message)</span></span>`);
  await one.unmount();
  const replying = await row({ replying: true });
  expect(replying.item()?.querySelector(".sidebar-replying .sr-only")?.textContent).toBe("(replying)");
  await replying.unmount();
  const opening = await row({ opening: true });
  expect([opening.item()?.querySelector(".sidebar-replying .sr-only")?.textContent, opening.item()?.getAttribute("aria-busy")]).toEqual(["(opening)", "true"]);
});

test("a row opens its thread on a click, Enter or Space, once the daemon is ready", async () => {
  const ready = await row();
  expect([ready.item()?.getAttribute("tabindex"), ready.item()?.getAttribute("aria-disabled")]).toEqual(["0", "false"]);
  await click(ready.item());
  const press = async (key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await acting(() => { ready.item()?.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  expect([await press("Enter"), await press(" "), await press("a")]).toEqual([true, true, false]);
  expect(ready.selected).toHaveLength(3);
  await ready.unmount();
  const waiting = await row({ ready: false });
  expect([waiting.item()?.getAttribute("tabindex"), waiting.item()?.getAttribute("aria-disabled")]).toEqual(["-1", "true"]);
  await click(waiting.item());
  expect(waiting.selected).toEqual([]);
});

test("a row's options button opens its menu", async () => {
  const view = await row();
  const more = view.host.querySelector<HTMLElement>(".thread-more");
  expect([more?.querySelector("svg")?.outerHTML, more?.getAttribute("aria-expanded"), view.box()?.classList.contains("menu-open"), present(document.body.querySelector("[role=menu]"))]).toEqual([await icon("more", 16), "false", false, false]);
  await click(more);
  expect([more?.getAttribute("aria-expanded"), view.box()?.classList.contains("menu-open"), document.body.querySelector("[role=menu]")?.getAttribute("aria-label")]).toEqual(["true", true, "Options for side"]);
});

test("a thread that isn't home can be dragged once the daemon is ready, carrying its name", async () => {
  const home = await row({ thread: HOME });
  expect(home.box()?.getAttribute("draggable")).toBe("false");
  await home.unmount();
  const waiting = await row({ ready: false });
  expect(waiting.box()?.getAttribute("draggable")).toBe("false");
  await waiting.unmount();
  const side = await row();
  expect(side.box()?.getAttribute("draggable")).toBe("true");
  const { transfer } = await side.drag("dragstart", {});
  expect([transfer.getData(side.type), transfer.effectAllowed]).toEqual(["side", "move"]);
});

test("dragging a thread over another marks the half it would land in, and dropping it there moves it", async () => {
  const view = await row();
  spyOn(view.box() as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 100, height: 40, bottom: 140, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({}) });
  const marked = () => view.box()?.className.split(" ").filter((name) => name.startsWith("drop-"));
  const over = await view.drag("dragover", view.thread("notes"), 115);
  expect([over.prevented, over.transfer.dropEffect, marked(), view.outside]).toEqual([true, "move", ["drop-before"], []]);
  expect((await view.drag("dragover", view.thread("notes"), 120)).prevented && marked()).toEqual(["drop-before"]);
  await view.drag("dragover", view.thread("notes"), 121);
  expect(marked()).toEqual(["drop-after"]);
  await view.drag("dragleave", {});
  expect(marked()).toEqual([]);
  await view.drag("dragover", view.thread("notes"), 121);
  expect([(await view.drag("drop", view.thread("notes"), 121)).prevented, marked(), view.dropped, view.outside]).toEqual([true, [], [["notes", true]], []]);
  await view.drag("drop", view.thread("notes"), 110);
  expect(view.dropped.at(-1)).toEqual(["notes", false]);
  expect([(await view.drag("drop", view.thread("side"), 121)).prevented, view.dropped.length], "a thread dropped on itself stays").toEqual([true, 2]);
  expect([(await view.drag("drop", {}, 121)).prevented, view.dropped.length, view.outside], "nothing was dragged").toEqual([false, 2, ["drop"]]);
});

test("only a thread can be dropped on a row, and nothing on the home thread's", async () => {
  const files = await row();
  expect([(await files.drag("dragover", { Files: "x" })).prevented, files.outside]).toEqual([false, ["over"]]);
  await files.unmount();
  const home = await row({ thread: HOME });
  expect([(await home.drag("dragover", home.thread("notes"))).prevented, home.box()?.className.includes("drop-")]).toEqual([false, false]);
  expect([(await home.drag("drop", home.thread("notes"))).prevented, home.dropped, home.outside]).toEqual([false, [], ["over", "drop"]]);
});
