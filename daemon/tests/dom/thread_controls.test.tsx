import { expect, spyOn, test } from "bun:test";

import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import type { ThreadNeighbours } from "../../src/browser/sidebar/ThreadRow.tsx";
import { HOLD, useApp } from "./app.ts";
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
  expect(offered(SIDE)).toEqual(["Thread settings…", "Fork…", "Mark as read", "Put on hold", "Make home", "Move up", "Move down", "Move to folder…", "Archive…"]);

  const icon = async (name: "home" | "chat") => {
    const drawn = await mount(<Icon name={name} size={14} />);
    const html = drawn.host.innerHTML;
    await drawn.unmount();
    return html;
  };
  const row = async (thread: ThreadView) => {
    const view = await mount(<ThreadRow thread={thread} label={thread.id} current={false} unread={0} drafted={false} replying={false} opening={false} ready select={() => {}} neighbours={neighbours} drop={() => {}} />);
    const shown = [view.host.querySelector(".thread-row")?.getAttribute("draggable"), view.host.querySelector(".sidebar-item svg")?.outerHTML];
    await view.unmount();
    return shown;
  };
  expect(await row(HOME)).toEqual(["false", await icon("home")]);
  expect(await row(SIDE)).toEqual(["true", await icon("chat")]);
});

test("a side thread's options put it on hold and a thread on hold's resume it, once the daemon is ready, while home and the wakes thread offer neither", async () => {
  app.answer(answered("thread_hold"));
  const { holdItem } = await import("../../src/browser/sidebar/ThreadRow.tsx");
  const HELD = { ...SIDE, on_hold: true };
  const WAKES = { ...SIDE, id: "wakes", wakes: true };
  const items = (thread: ThreadView, ready: boolean) => holdItem(thread, ready).flatMap((item) => item === "separator" ? [] : [[item.label, item.icon, item.disabled]]);
  expect([items(HOME, true), items(WAKES, true)]).toEqual([[], []]);
  expect([items(SIDE, true), items(SIDE, false)]).toEqual([[["Put on hold", "pause", false]], [["Put on hold", "pause", true]]]);
  expect([items(HELD, true), items(HELD, false)]).toEqual([[["Resume", "play", false]], [["Resume", "play", true]]]);
  const since = app.socket().sent.length;
  for (const thread of [SIDE, HELD]) {
    const item = holdItem(thread, true)[0];
    if (item !== undefined && item !== "separator") await acting(() => { item.onSelect(); });
  }
  await settle();
  expect(asked(since, "thread_hold")).toEqual([{ name: "side", on_hold: true }, { name: "side", on_hold: false }]);
});

test("a thread's options wait for the daemon; mark as read needs an unread message, a move needs somewhere to go, and home can't be archived", async () => {
  app.answer(answered("thread_move"));
  const { threadMenuItems } = await import("../../src/browser/sidebar/ThreadRow.tsx");
  const free: ThreadNeighbours = { up: "above", down: "below", atEnd: false, byActivity: false };
  const shown = (thread: ThreadView, ready: boolean, neighbours = free) => threadMenuItems(thread, ready, neighbours).flatMap((item) => item === "separator" ? [] : [[item.label, item.disabled ?? false, item.danger ?? false]]);
  const UNREAD = { ...SIDE, unread: 1 };
  expect(shown(UNREAD, true)).toEqual([
    ["Thread settings…", false, false], ["Fork…", false, false], ["Mark as read", false, false], ["Put on hold", false, false], ["Make home", false, false],
    ["Move up", false, false], ["Move down", false, false], ["Move to folder…", false, false], ["Archive…", false, true],
  ]);
  expect(shown(UNREAD, false).filter(([, disabled]) => disabled !== true)).toEqual([]);
  const markable = (unread: number | undefined) => shown(unread === undefined ? SIDE : { ...SIDE, unread }, true).find(([label]) => label === "Mark as read")?.[1];
  expect([markable(undefined), markable(0), markable(1), markable(2)]).toEqual([true, true, false, false]);
  expect(shown(SIDE, true, { up: undefined, down: undefined, atEnd: true, byActivity: false }).filter(([label]) => label === "Move up" || label === "Move down")).toEqual([["Move up", true, false], ["Move down", true, false]]);
  expect(shown(HOME, true).at(-1)).toEqual(["Archive…", true, true]);

  const since = app.socket().sent.length;
  for (const label of ["Move up", "Move down"]) {
    const item = threadMenuItems(SIDE, true, free).find((each) => each !== "separator" && each.label === label);
    if (item !== undefined && item !== "separator") await acting(() => { item.onSelect(); });
  }
  await settle();
  expect(asked(since, "thread_move")).toEqual([{ name: "side", before: "above" }, { name: "side", before: "below" }]);
});

test("an unread count reads 99+ past 99, and tells a screen reader one message or how many", async () => {
  const { UnreadBadge } = await import("../../src/browser/sidebar/ThreadRow.tsx");
  const shown = async (count: number) => {
    const view = await mount(<UnreadBadge count={count} />);
    const text = view.host.textContent;
    await view.unmount();
    return text;
  };
  expect([await shown(1), await shown(2), await shown(99), await shown(100)]).toEqual([
    "1(1 unread message)", "2(2 unread messages)", "99(99 unread messages)", "99+(100 unread messages)",
  ]);
});

test("the open thread is marked read when it opens, when the window gets focus, when the page is shown and when a reply comes in, but only with the window focused and never once the chat is closed", async () => {
  const { Chat } = await import("../../src/browser/chat/Chat.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { workspace } = app.state();
  let focused = true;
  const focus = spyOn(document, "hasFocus").mockImplementation(() => focused);
  app.restores.push(() => focus.mockRestore());
  const minute = (n: number) => `2026-11-26T10:${String(n).padStart(2, "0")}:00Z`;
  const reply = async (n: number) => {
    const messages = Array.from({ length: n }, (_, at) => ({ msg_id: `m${String(at)}`, role: "assistant", content: "hi", content_blocks: [], timestamp: minute(at), images: [] }));
    await acting(() => { app.socket().receive({ type: "history", messages, config: {}, revision: 2, selected_character: "ada", selected_thread: "story" }); });
  };
  const since = app.socket().sent.length;
  const marked = () => asked(since, "mark_thread_read").map((args) => (args as { through: string }).through);
  await acting(() => { workspace.applyThreadListing({ ...LISTING, threads: LISTING.threads.map((thread) => ({ ...thread, unread: 1 })) }); });
  focused = false;
  await reply(1);
  focused = true;
  const view = await mount(<Chat state={chromeOf(undefined, workspace.getSnapshot())} sidebarOpen toggleSidebar={() => {}} mobile={false} />);
  await settle();
  expect(marked()).toEqual([minute(0)]);
  focused = false;
  await reply(2);
  expect(marked(), "a reply while the window has no focus stays unread").toEqual([minute(0)]);
  focused = true;
  await acting(() => { window.dispatchEvent(new Event("focus")); });
  focused = false;
  await reply(3);
  focused = true;
  await acting(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await reply(4);
  expect(marked()).toEqual([minute(0), minute(1), minute(2), minute(3)]);
  await view.unmount();
  await reply(5);
  await acting(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(marked(), "nothing is marked once the chat is closed").toEqual([minute(0), minute(1), minute(2), minute(3)]);
});

test("a thread on hold says so above its transcript, with a button that resumes it once the daemon is ready", async () => {
  app.answer(answered("thread_hold"));
  const { Chat } = await import("../../src/browser/chat/Chat.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const chrome = chromeOf(undefined, app.state().workspace.getSnapshot());
  const banner = async (state: typeof chrome) => {
    const view = await mount(<Chat state={state} sidebarOpen toggleSidebar={() => {}} mobile={false} />);
    await settle();
    return { view, shown: [...view.host.querySelectorAll(".banner")].map((each) => [each.textContent, each.querySelector("button")?.disabled]) };
  };
  const plain = await banner({ ...chrome, character: "ada", thread: "side", threads: [HOME, SIDE] });
  expect(plain.shown).toEqual([]);
  await plain.view.unmount();
  const held = { ...chrome, character: "ada", thread: "side", threads: [HOME, { ...SIDE, on_hold: true }] };
  const waiting = await banner({ ...held, status: "connecting" });
  expect(waiting.shown.at(-1)).toEqual(["On hold. ada doesn't see this thread, and no wake runs in it. Writing here resumes it.Resume", true]);
  await waiting.view.unmount();
  const ready = await banner({ ...held, status: "ready" });
  expect(ready.shown).toEqual([["On hold. ada doesn't see this thread, and no wake runs in it. Writing here resumes it.Resume", false]]);
  const since = app.socket().sent.length;
  await click(button(ready.view.host, "Resume"));
  await settle();
  expect(asked(since, "thread_hold")).toEqual([{ name: "side", on_hold: false }]);
  await ready.view.unmount();
});

test("a thread's settings show whether it compacts or trims when it gets long, and saving a change sends it", async () => {
  app.answer(answered("thread_compaction"));
  const { ThreadDialogs } = await import("../../src/browser/chat/thread_dialogs.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), threads: [HOME, SIDE] };
  const choice = () => [...document.body.querySelectorAll("select")].find((select) => (select.closest("label")?.textContent ?? "").startsWith("Older turns are archived"));

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

test("the wakes thread is for reading: a note stands in for the composer, its messages offer only copying, and nothing offers a reply, another take, making it home or compacting it", async () => {
  app.answer(answered("thread_compaction"));
  const turns = [
    { msg_id: "m_open", role: "user", origin: "autonomous", content: '[wake in "main"]\n\n[Your trigger "show" fired.]', images: [], content_blocks: [{ type: "text", text: '[wake in "main"]' }], timestamp: "2026-11-15T05:45:00.000Z" },
    { msg_id: "m_round", role: "assistant", content: "Done.", images: [], content_blocks: [{ type: "text", text: "Done." }], timestamp: "2026-11-15T05:52:00.000Z" },
  ];
  await acting(async () => { app.socket().receive({ type: "history", messages: turns, config: {}, revision: 2, selected_character: "ada", selected_thread: "story" }); await Bun.sleep(5); });
  const { Chat } = await import("../../src/browser/chat/Chat.tsx");
  const { Palette } = await import("../../src/browser/app/Palette.tsx");
  const { ThreadDialogs } = await import("../../src/browser/chat/thread_dialogs.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const chrome = chromeOf(undefined, app.state().workspace.getSnapshot());
  const kept = { ...chrome, threads: chrome.threads.map((thread) => ({ ...thread, home: false, wakes: true })) };

  const chat = async (state: typeof chrome) => {
    const view = await mount(<Chat state={state} sidebarOpen toggleSidebar={() => {}} mobile={false} />);
    await settle();
    await click(button(view.host, "Thread options"));
    const offered = [...view.host.querySelectorAll(".topbar [role=menuitem]")].map((item) => item.textContent ?? "");
    const actions = [...view.host.querySelectorAll("[data-msg-id=m_round] .message-actions button")].map((item) => item.getAttribute("aria-label"));
    return { view, offered, actions };
  };
  const reading = await chat(kept);
  expect(reading.view.host.querySelector(".composer-note")?.textContent).toBe("Shore keeps the working from ada's wakes here, to read. Write to ada in another thread.");
  expect(reading.view.host.querySelector("textarea, .cm-editor")).toBeNull();
  expect(reading.actions).toEqual(["Copy"]);
  expect(reading.offered.filter((label) => ["Another take", "Regenerate with a reason…", "Make home"].includes(label))).toEqual([]);
  await reading.view.unmount();

  const talking = await chat({ ...kept, threads: chrome.threads.map((thread) => ({ ...thread, home: false })) });
  expect(talking.view.host.querySelector(".composer-note")).toBeNull();
  expect(talking.actions).toContain("Delete");
  expect(talking.offered.filter((label) => ["Another take", "Regenerate with a reason…", "Make home"].includes(label))).toEqual(["Another take", "Regenerate with a reason…", "Make home"]);
  await talking.view.unmount();

  const palette = await mount(<Palette state={kept} close={() => {}} newThread={() => {}} newCharacter={() => {}} />);
  const options = [...palette.host.querySelectorAll("[role=option]")].map((item) => item.textContent ?? "");
  expect(options.filter((label) => label.startsWith("Make home") || label.startsWith("Another take"))).toEqual([]);
  expect(options.some((label) => label.startsWith("Thread settings"))).toBe(true);
  await palette.unmount();

  const choice = () => [...document.body.querySelectorAll("select")].find((select) => (select.closest("label")?.textContent ?? "").startsWith("Older turns are archived"));
  const settings = await mount(<ThreadDialogs state={kept} request={{ kind: "settings", thread: "story" }} close={() => {}} />);
  expect(choice()).toBeUndefined();
  expect(document.body.querySelector("dialog, [role=dialog]")).not.toBeNull();
  await settings.unmount();
  await quiet();
});

const field = (root: ParentNode, name: string) => [...root.querySelectorAll("input, textarea, select")].find((control) => (control.closest("label")?.textContent ?? "").startsWith(name));

test("a new thread needs a name, says so while it is being made, opens in the chat once it is, and a refusal is shown and can be tried again", async () => {
  const { NewThreadDialog } = await import("../../src/browser/sidebar/dialogs.tsx");
  const { navigate } = await import("../../src/browser/app/route.ts");
  let creating: () => unknown = () => { throw new Error("a thread named lamp already exists"); };
  app.answer((request) => {
    if (request["name"] === "create_thread") return creating();
    if (request["name"] === "switch_thread") return { character: "ada", thread: "lamp", changed: true };
    return undefined;
  });
  navigate({ view: "settings", page: "segments" });
  let closed = 0;
  const view = await mount(<NewThreadDialog character="ada" taken={["story"]} close={() => { closed += 1; }} />);
  const create = () => view.host.querySelector<HTMLButtonElement>("button[type=submit]");
  const shown = () => [create()?.textContent, create()?.disabled, view.host.querySelector("[role=alert]")?.textContent ?? null];
  expect(view.host.querySelector("h2")?.textContent).toBe("New thread with ada");
  expect(shown()).toEqual(["Create", true, null]);
  expect((field(view.host, "Older turns are archived") as HTMLSelectElement).value).toBe("trim");

  const since = app.socket().sent.length;
  await type(field(view.host, "Name"), " lamp ");
  expect(shown()).toEqual(["Create", false, null]);
  const submitted = new Event("submit", { bubbles: true, cancelable: true });
  await acting(() => { view.host.querySelector("form")?.dispatchEvent(submitted); });
  await settle();
  expect(submitted.defaultPrevented).toBe(true);
  expect(shown()).toEqual(["Create", false, "a thread named lamp already exists"]);
  expect([closed, location.hash, asked(since, "switch_thread")]).toEqual([0, "#settings/segments", []]);

  creating = () => HOLD;
  await click(create());
  expect(shown()).toEqual(["Creating…", true, null]);
  const held = app.sent(since).findLast((request) => request["name"] === "create_thread");
  await acting(async () => {
    app.socket().receive({ type: "command_output", rid: held?.["rid"], name: "create_thread", data: LISTING });
    app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
    await Bun.sleep(5);
  });
  expect(asked(since, "create_thread")).toEqual([{ name: "lamp" }, { name: "lamp" }]);
  expect(asked(since, "switch_thread")).toEqual([{ name: "lamp", resync: true }]);
  expect([closed, location.hash]).toEqual([1, ""]);
  expect(shown()).toEqual(["Create", false, null]);
  await view.unmount();
});

test("a new thread's id is made from its name, which becomes its label, and it is made with whatever else was filled in: its purpose, model, files one to a line, and compacting at home's limits", async () => {
  const { NewThreadDialog } = await import("../../src/browser/sidebar/dialogs.tsx");
  app.answer((request) => {
    if (request["name"] === "create_thread") return LISTING;
    if (request["name"] === "switch_thread") return { character: "ada", thread: "lamp", changed: true };
    return undefined;
  });
  const view = await mount(<NewThreadDialog character="ada" taken={["story"]} close={() => {}} />);
  expect([field(view.host, "Purpose")?.getAttribute("rows"), field(view.host, "Pinned in the prompt")?.getAttribute("rows")]).toEqual(["2", "3"]);
  const since = app.socket().sent.length;
  expect(field(view.host, "Label"), "the name is the only name asked for").toBeUndefined();
  await type(field(view.host, "Name"), " The lamp ");
  await type(field(view.host, "Purpose"), " Keep the light ");
  await type(field(view.host, "Model"), " opus ");
  await type(field(view.host, "Pinned in the prompt"), "notes/a.md\n\n  [[lamp/]]  \n");
  await type(field(view.host, "Older turns are archived"), "compact");
  await click(view.host.querySelector("button[type=submit]"));
  await settle();
  expect(asked(since, "create_thread")).toEqual([{ name: "the-lamp", label: "The lamp", purpose: "Keep the light", pins: ["notes/a.md", "[[lamp/]]"], model: "opus", compaction: true }]);
  expect(asked(since, "switch_thread")).toEqual([{ name: "the-lamp", resync: true }]);
  await view.unmount();
});

test("a new thread whose name makes the id of one already there gets the next free number", async () => {
  const { NewThreadDialog } = await import("../../src/browser/sidebar/dialogs.tsx");
  app.answer((request) => request["name"] === "create_thread" ? LISTING : request["name"] === "switch_thread" ? { character: "ada", thread: "story-2", changed: true } : undefined);
  const view = await mount(<NewThreadDialog character="ada" taken={["story"]} close={() => {}} />);
  const since = app.socket().sent.length;
  await type(field(view.host, "Name"), "story");
  await click(view.host.querySelector("button[type=submit]"));
  await settle();
  expect(asked(since, "create_thread")).toEqual([{ name: "story-2", label: "story" }]);
  await view.unmount();
});

test("each kind of thread dialog opens its own form, and one for a thread no longer there opens none", async () => {
  const { ThreadDialogs } = await import("../../src/browser/chat/thread_dialogs.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), threads: [HOME, SIDE] };
  const title = async (kind: "settings" | "fork" | "archive" | "move", thread = "side") => {
    const view = await mount(<ThreadDialogs state={state} request={{ kind, thread }} close={() => {}} />);
    const shown = document.body.querySelector("dialog h2")?.textContent ?? null;
    await view.unmount();
    return shown;
  };
  expect([await title("settings"), await title("fork"), await title("archive"), await title("move"), await title("settings", "gone")]).toEqual(["Thread settings", "Fork “side”", "Archive “side”?", "Move “side”", null]);
});

test("a fork's id is made from its name, which becomes its label, copies the turns asked for, and opens once made", async () => {
  const { ThreadDialogs } = await import("../../src/browser/chat/thread_dialogs.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), threads: [HOME, SIDE] };
  app.answer((request) => {
    const args = request["args"] as { name: string; turns?: number };
    switch (request["name"]) {
      case "fork_thread": return { ...LISTING, fork: { fork_id: "f1", thread: args.name, source: "story", created_at: "2026-11-27T00:00:00Z", turns: args.turns ?? 4, scope: args.turns === undefined ? "full" : "last_turns" } };
      case "thread_label": return LISTING;
      case "switch_thread": return { character: "ada", thread: args.name, changed: true };
      default: return undefined;
    }
  });
  const fork = async (name: string, turns: string) => {
    let closed = 0;
    const view = await mount(<ThreadDialogs state={state} request={{ kind: "fork", thread: "story" }} close={() => { closed += 1; }} />);
    const submit = () => document.body.querySelector<HTMLButtonElement>("dialog button[type=submit]");
    expect([document.body.querySelector("dialog h2")?.textContent, submit()?.textContent, submit()?.disabled]).toEqual(["Fork “story”", "Fork", true]);
    const since = app.socket().sent.length;
    await type(field(document.body, "Name"), name);
    await type(field(document.body, "Copy only the last turns"), "0");
    const none = submit()?.disabled;
    await type(field(document.body, "Copy only the last turns"), "1");
    expect([none, submit()?.disabled], "no turns can't be copied, one can").toEqual([true, false]);
    await type(field(document.body, "Copy only the last turns"), turns);
    const ready = submit()?.disabled;
    await click(submit());
    await settle();
    const sent = app.sent(since).filter((request) => request["type"] === "command" && request["name"] !== "list_threads").map((request) => [request["name"], request["args"]]);
    const shown = toasts.getSnapshot().map((toast) => toast.text);
    await acting(() => { for (const toast of toasts.getSnapshot()) toasts.dismiss(toast.id); });
    await view.unmount();
    return { ready, sent, shown, closed };
  };
  expect(await fork("A side road", "2")).toEqual({ ready: false, closed: 1, shown: ["Forked 2 turns into “A side road”"], sent: [
    ["fork_thread", { name: "a-side-road", from: "story", turns: 2 }], ["thread_label", { name: "a-side-road", label: "A side road" }], ["switch_thread", { name: "a-side-road", resync: true }],
  ] });
  expect(await fork("side", ""), "a name already an id needs no label, and one taken gets a number").toEqual({ ready: false, closed: 1, shown: ["Forked 4 turns into “side”"], sent: [
    ["fork_thread", { name: "side-2", from: "story" }], ["thread_label", { name: "side-2", label: "side" }], ["switch_thread", { name: "side-2", resync: true }],
  ] });
  expect(await fork("road", ""), "a name that is its own id needs no label").toEqual({ ready: false, closed: 1, shown: ["Forked 4 turns into “road”"], sent: [
    ["fork_thread", { name: "road", from: "story" }], ["switch_thread", { name: "road", resync: true }],
  ] });
});

test("a thread's settings open on what the thread has, save nothing that wasn't changed, and choose its model in a picker for that thread alone", async () => {
  const { ThreadDialogs } = await import("../../src/browser/chat/thread_dialogs.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const kept: ThreadView = { ...SIDE, id: "kept", locked: true, chat_model: "anthropic:opus" };
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), threads: [HOME, SIDE, kept] };
  const dialogs = () => [...document.body.querySelectorAll("dialog")].map((dialog) => dialog.querySelector("h2")?.textContent);
  const lock = () => document.body.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked;
  const model = () => document.body.querySelector(".thread-model")?.textContent;

  const mine = await mount(<ThreadDialogs state={state} request={{ kind: "settings", thread: "kept" }} close={() => {}} />);
  expect([lock(), model(), dialogs()]).toEqual([true, "opus", ["Thread settings"]]);
  expect([field(document.body, "Purpose")?.getAttribute("rows"), field(document.body, "Pinned in the prompt")?.getAttribute("rows")]).toEqual(["2", "3"]);
  const since = app.socket().sent.length;
  await click(button(document.body, "Save"));
  await settle();
  expect(app.sent(since).filter((request) => request["type"] === "command").map((request) => request["name"])).toEqual(["list_threads"]);
  await mine.unmount();

  const plain = await mount(<ThreadDialogs state={state} request={{ kind: "settings", thread: "side" }} close={() => {}} />);
  expect([lock(), model(), dialogs()]).toEqual([false, "ada’s default", ["Thread settings"]]);
  await click(document.body.querySelector(".thread-model"));
  expect(dialogs()).toEqual(["Thread settings", "Model for thread side"]);
  expect(document.body.querySelector("[role=radiogroup][aria-label='Apply to']")).toBeNull();
  const picker = [...document.body.querySelectorAll("dialog")].find((dialog) => dialog.querySelector("h2")?.textContent === "Model for thread side");
  await click(button(picker ?? document.body, "Close"));
  expect(dialogs()).toEqual(["Thread settings"]);
  await plain.unmount();
  await quiet();
});

test("saving a thread's settings sends each change: its pins, a cleared label, a new purpose, unlocking it and going back to the default model", async () => {
  app.answer((request) => String(request["name"]).startsWith("thread_") ? LISTING : undefined);
  const { ThreadDialogs } = await import("../../src/browser/chat/thread_dialogs.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const kept: ThreadView = { ...SIDE, id: "kept", label: "Lighthouse", purpose: "A story.", pins: ["stories/lighthouse.md"], locked: true, chat_model: "anthropic:opus" };
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), threads: [HOME, kept] };

  const view = await mount(<ThreadDialogs state={state} request={{ kind: "settings", thread: "kept" }} close={() => {}} />);
  const since = app.socket().sent.length;
  await type(field(document.body, "Label"), "  ");
  await type(field(document.body, "Purpose"), " Mara's winter. ");
  await type(field(document.body, "Pinned in the prompt"), "stories/lighthouse.md\n!git log --oneline -5\n");
  await click(document.body.querySelector("input[type=checkbox]"));
  await click(document.body.querySelector(".thread-model"));
  await click(button(document.body, "Use ada’s default"));
  await click(button(document.body, "Save"));
  await settle();

  expect(app.sent(since).filter((request) => String(request["name"]).startsWith("thread_")).map((request) => [request["name"], request["args"]])).toEqual([
    ["thread_pins", { name: "kept", pins: ["stories/lighthouse.md", "!git log --oneline -5"] }],
    ["thread_label", { name: "kept", label: null }],
    ["thread_purpose", { name: "kept", purpose: "Mara's winter." }],
    ["thread_lock", { name: "kept", locked: false }],
    ["thread_model", { name: "kept", model: null }],
  ]);
  await view.unmount();
  await quiet();
});
