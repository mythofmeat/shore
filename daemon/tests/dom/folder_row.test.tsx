import { expect, test } from "bun:test";

import { useApp } from "./app.ts";
import { replace } from "./daemon.ts";
import { acting, click, mount } from "./dom.ts";

const app = useApp();

interface Shown { collapsed?: boolean; unread?: number; later?: number; replying?: boolean; ready?: boolean }

async function folderRow(shown: Shown = {}) {
  const { FolderRow } = await import("../../src/browser/sidebar/FolderRow.tsx");
  const dropped: string[] = [];
  const moved: [string, boolean][] = [];
  const outside: string[] = [];
  const view = await mount(<div onDragOver={() => outside.push("over")} onDrop={() => outside.push("drop")}>
    <FolderRow character="ada" folder={{ name: "work", byActivity: false, threads: [] }} collapsed={shown.collapsed ?? false} unread={shown.unread ?? 0} later={shown.later ?? 0} replying={shown.replying ?? false} ready={shown.ready ?? true}
      neighbours={{ up: undefined, down: undefined, atEnd: true }} drop={(id) => dropped.push(id)} dropFolder={(name, after) => moved.push([name, after])} />
  </div>);
  const row = () => view.host.querySelector(".thread-row");
  const item = () => view.host.querySelector<HTMLElement>(".sidebar-item");
  return { ...view, row, item, dropped, moved, outside };
}

async function drawn(name: "chevronDown" | "chevronRight" | "more" | "flag", size: number): Promise<string> {
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const icon = await mount(<Icon name={name} size={size} />);
  const html = icon.host.innerHTML;
  await icon.unmount();
  return html;
}

test("a folder row says whether it is open with its chevron, and only shut shows a reply under way, its threads marked for later and its unread count", async () => {
  const shown = async (state: Shown) => {
    const view = await folderRow(state);
    const seen = [view.item()?.getAttribute("aria-expanded"), view.item()?.querySelector("svg")?.outerHTML, view.item()?.querySelector(".sidebar-replying .sr-only")?.textContent ?? null, view.item()?.querySelector(".sidebar-later-count")?.textContent ?? null, view.item()?.querySelector(".sidebar-unread [aria-hidden]")?.textContent ?? null];
    await view.unmount();
    return seen;
  };
  expect(await shown({ replying: true, unread: 3, later: 2 })).toEqual(["true", await drawn("chevronDown", 14), null, null, null]);
  expect(await shown({ collapsed: true, replying: true, unread: 1, later: 1 })).toEqual(["false", await drawn("chevronRight", 14), "(replying)", "1(1 marked for later)", "1"]);
  expect(await shown({ collapsed: true, later: 2 })).toEqual(["false", await drawn("chevronRight", 14), null, "2(2 marked for later)", null]);
  expect(await shown({ collapsed: true })).toEqual(["false", await drawn("chevronRight", 14), null, null, null]);
  const marked = await folderRow({ collapsed: true, later: 3 });
  expect(marked.item()?.querySelector(".sidebar-later-count")?.innerHTML).toBe(`${await drawn("flag", 12)}<span aria-hidden="true">3</span><span class="sr-only">(3 marked for later)</span>`);
});

test("a folder row's options button opens its menu and says so", async () => {
  const view = await folderRow();
  const more = view.host.querySelector(".thread-more");
  expect([more?.querySelector("svg")?.outerHTML, more?.getAttribute("aria-expanded"), view.row()?.classList.contains("menu-open")]).toEqual([await drawn("more", 16), "false", false]);
  await click(more);
  expect([more?.getAttribute("aria-expanded"), view.row()?.classList.contains("menu-open"), document.body.querySelector("[role=menu]")?.getAttribute("aria-label")]).toEqual(["true", true, "Options for folder work"]);
});

test("a folder row is dragged as a folder once the daemon is ready, and a folder or thread dragged over it is taken there alone", async () => {
  const { FOLDER_DRAG_TYPE, THREAD_DRAG_TYPE } = await import("../../src/browser/sidebar/ThreadRow.tsx");
  const view = await folderRow();
  const fire = async (type: string, data: Record<string, string>) => {
    const transfer = new DataTransfer();
    for (const [kind, value] of Object.entries(data)) transfer.setData(kind, value);
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { dataTransfer: { value: transfer }, clientY: { value: 0 } });
    await acting(() => { view.row()?.dispatchEvent(event); });
    return { prevented: event.defaultPrevented, transfer };
  };
  expect(view.row()?.getAttribute("draggable")).toBe("true");
  const started = await fire("dragstart", {});
  expect([started.transfer.getData(FOLDER_DRAG_TYPE), started.transfer.effectAllowed]).toEqual(["work", "move"]);
  for (const data of [{ [FOLDER_DRAG_TYPE]: "play" }, { [THREAD_DRAG_TYPE]: "side" }]) {
    const over = await fire("dragover", data);
    expect([over.prevented, over.transfer.dropEffect]).toEqual([true, "move"]);
  }
  await fire("drop", { [FOLDER_DRAG_TYPE]: "play" });
  expect([view.moved, view.outside]).toEqual([[["play", false]], []]);
  await view.unmount();
  const waiting = await folderRow({ ready: false });
  expect(waiting.row()?.getAttribute("draggable")).toBe("false");
});

test("on a screen without hover, folders and threads can't be dragged", async () => {
  const original = globalThis.matchMedia.bind(globalThis);
  replace(app.restores, globalThis, "matchMedia", (query: string) => query === "(hover: none)" ? { matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} } : original(query));
  const copy = "touch";
  const { TOUCH_ONLY } = await import(`../../src/browser/sidebar/ThreadRow.tsx?${copy}`) as typeof import("../../src/browser/sidebar/ThreadRow.tsx");
  expect(TOUCH_ONLY).toBe(true);
});
