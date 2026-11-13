import { expect, test } from "bun:test";

import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import { useApp } from "./app.ts";
import { LISTING } from "./daemon.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };

const HOME: ThreadView = { id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true };
const SIDE: ThreadView = { id: "side", created_at: "2026-11-02T00:00:00Z", compaction: false, home: false, current: false };

const answered = (name: string) => (request: Record<string, unknown>) => request["name"] === name ? LISTING : undefined;

const asked = (since: number, name: string) => app.sent(since).filter((request) => request["name"] === name).map((request) => request["args"]);

async function quiet(): Promise<void> {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  await acting(() => { for (const shown of toasts.getSnapshot()) toasts.dismiss(shown.id); });
}

test("the home thread's row shows a house and stays where it is, and any other thread's shows a speech bubble, can be dragged and offers to become home or move", async () => {
  const { ThreadRow, threadMenuItems } = await import("../../src/browser/sidebar/ThreadRow.tsx");
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const neighbours = { up: undefined, down: undefined, atEnd: true, byActivity: false };
  const offered = (thread: ThreadView) => threadMenuItems(thread, true, neighbours).flatMap((item) => item === "separator" ? [] : [item.label]);
  expect(offered(HOME)).toEqual(["Thread settings…", "Fork…", "Mark as read", "Archive…"]);
  expect(offered(SIDE)).toEqual(["Thread settings…", "Fork…", "Mark as read", "Make home", "Move up", "Move down", "Move to folder…", "Archive…"]);

  const icon = async (name: "home" | "chat") => {
    const drawn = await mount(<Icon name={name} size={14} />);
    const html = drawn.host.innerHTML;
    await drawn.unmount();
    return html;
  };
  const row = async (thread: ThreadView) => {
    const view = await mount(<ThreadRow thread={thread} label={thread.id} current={false} unread={0} replying={false} opening={false} compacting={false} ready select={() => {}} neighbours={neighbours} drop={() => {}} />);
    const shown = [view.host.querySelector(".thread-row")?.getAttribute("draggable"), view.host.querySelector(".sidebar-item svg")?.outerHTML];
    await view.unmount();
    return shown;
  };
  expect(await row(HOME)).toEqual(["false", await icon("home")]);
  expect(await row(SIDE)).toEqual(["true", await icon("chat")]);
});

test("a thread's settings show whether it compacts or trims when it gets long, and saving a change sends it", async () => {
  app.answer(answered("thread_compaction"));
  const { ThreadDialogs } = await import("../../src/browser/chat/thread_dialogs.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), threads: [HOME, SIDE] };
  const choice = () => [...document.body.querySelectorAll("select")].find((select) => (select.closest("label")?.textContent ?? "").startsWith("When it gets long"));

  const compacting = await mount(<ThreadDialogs state={state} request={{ kind: "settings", thread: "story" }} close={() => {}} />);
  expect(choice()?.value).toBe("compact");
  await compacting.unmount();

  const trimming = await mount(<ThreadDialogs state={state} request={{ kind: "settings", thread: "side" }} close={() => {}} />);
  expect(choice()?.value).toBe("trim");
  const since = app.socket().sent.length;
  await type(choice(), "compact");
  expect(choice()?.value).toBe("compact");
  await click(button(document.body, "Save"));
  await settle();
  expect(asked(since, "thread_compaction")).toEqual([{ name: "side", compaction: true }]);
  await trimming.unmount();
});

test("a thread that isn't home can be made home from its options once the daemon is ready, and the home thread has no such option", async () => {
  app.answer(answered("thread_home"));
  const { Chat } = await import("../../src/browser/chat/Chat.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const chrome = chromeOf(undefined, app.state().workspace.getSnapshot());
  const elsewhere = { ...chrome, threads: chrome.threads.map((thread) => ({ ...thread, home: false })) };
  const option = async (state: typeof chrome) => {
    const view = await mount(<Chat state={state} sidebarOpen toggleSidebar={() => {}} mobile={false} />);
    await settle();
    await click(button(view.host, "Thread options"));
    return { view, item: [...view.host.querySelectorAll<HTMLButtonElement>(".topbar [role=menuitem]")].find((item) => item.textContent === "Make home") };
  };

  const home = await option(chrome);
  expect(home.item).toBeUndefined();
  await home.view.unmount();

  const waiting = await option({ ...elsewhere, status: "connecting" });
  expect(waiting.item?.disabled).toBe(true);
  await waiting.view.unmount();

  const side = await option(elsewhere);
  expect(side.item?.disabled).toBe(false);
  const since = app.socket().sent.length;
  await click(side.item);
  await settle();
  expect(asked(since, "thread_home")).toEqual([{ name: "story" }]);
  await side.view.unmount();
  await quiet();
});

test("the palette offers to make the open thread home unless it already is, and opens the reasoning effort menu in the chat from wherever the user is", async () => {
  app.answer(answered("thread_home"));
  const { Palette } = await import("../../src/browser/app/Palette.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { navigate } = await import("../../src/browser/app/route.ts");
  const { EFFORT_MENU_EVENT } = await import("../../src/browser/app/intents.ts");
  app.restores.push(() => { navigate({ view: "chat" }); });
  const chrome = chromeOf(undefined, app.state().workspace.getSnapshot());
  const elsewhere = { ...chrome, threads: chrome.threads.map((thread) => ({ ...thread, home: false })) };
  const palette = async (state: typeof chrome) => await mount(<Palette state={state} close={() => {}} newThread={() => {}} newCharacter={() => {}} />);
  const option = (host: HTMLElement, label: string) => [...host.querySelectorAll("[role=option]")].find((item) => (item.textContent ?? "").startsWith(label));

  const home = await palette(chrome);
  expect(option(home.host, "Make home")).toBeUndefined();
  await home.unmount();

  const side = await palette(elsewhere);
  const since = app.socket().sent.length;
  await click(option(side.host, "Make home"));
  await settle();
  expect(asked(since, "thread_home")).toEqual([{ name: "story" }]);
  await side.unmount();
  await quiet();

  let opened = 0;
  const heard = () => { opened += 1; };
  addEventListener(EFFORT_MENU_EVENT, heard);
  app.restores.push(() => { removeEventListener(EFFORT_MENU_EVENT, heard); });
  navigate({ view: "settings", page: "models" });
  const away = await palette(chrome);
  await click(option(away.host, "Change reasoning effort"));
  expect(location.hash).toBe("");
  await acting(async () => { await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); }); });
  expect(opened).toBe(1);
  await away.unmount();
});
