import { expect, test } from "bun:test";

import { useApp } from "./app.ts";
import { acting, mount } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };

test("the sidebar lists the characters with the open one's threads, and under them the user's status, settings and the connection", async () => {
  app.answer((request) => request["name"] === "presence" ? { statuses: [{ status: "busy", set_at: "2026-10-30T12:00:00.000Z" }], history: ["asleep", "busy"] } : undefined);
  const { Sidebar } = await import("../../src/browser/sidebar/Sidebar.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const state = chromeOf(undefined, app.state().workspace.getSnapshot());
  expect(state.status).toBe("ready");
  const since = app.socket().sent.length;
  const view = await mount(<Sidebar state={state} mobile={false} close={() => {}} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} openSwitcher={() => {}} />);
  await settle();

  const sidebar = view.host.querySelector("aside.sidebar");
  expect(sidebar?.getAttribute("aria-label")).toBe("Characters and threads");
  expect(sidebar?.querySelector(".wordmark")?.textContent).toBe("shore");
  expect([...(sidebar?.querySelectorAll(".sidebar-list .sidebar-item.character .sidebar-name") ?? [])].map((name) => name.textContent)).toEqual(["ada"]);
  expect([...(sidebar?.querySelector(".sidebar-footer")?.children ?? [])].map((part) => part.textContent)).toEqual(["busy", "Settings", "Connected"]);
  expect(app.sent(since).filter((request) => request["name"] === "presence").map((request) => request["args"])).toEqual([{}]);
});

test("a status the daemon refuses is shown to the user as an error", async () => {
  app.answer((request) => {
    if (request["name"] !== "presence") return undefined;
    const asked = (request["args"] as { on?: string[] }).on;
    if (asked !== undefined) throw new Error("\"busy\" can't be a status");
    return { statuses: [], history: ["asleep", "busy"] };
  });
  const { Sidebar } = await import("../../src/browser/sidebar/Sidebar.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { toasts, Toasts } = await import("../../src/browser/ui/toast.tsx");
  const view = await mount(<div><Sidebar state={chromeOf(undefined, app.state().workspace.getSnapshot())} mobile={false} close={() => {}} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} openSwitcher={() => {}} /><Toasts /></div>);
  await settle();
  const row = [...view.host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Your status");
  expect(row?.textContent).toBe("Set status");
  await acting(() => { row?.click(); });
  const busy = [...view.host.querySelectorAll<HTMLButtonElement>(".status-pick")].find((item) => item.textContent === "busy");
  await acting(() => { busy?.click(); });
  await settle();
  const refusals = [...view.host.querySelectorAll(".toast.error")].filter((toast) => toast.textContent.includes("can't be a status"));
  expect(refusals.map((toast) => toast.getAttribute("role"))).toEqual(["alert"]);
  expect(row?.textContent).toBe("Set status");
  await acting(() => { for (const shown of toasts.getSnapshot()) toasts.dismiss(shown.id); });
});

test("Settings in the sidebar reopens the settings page last looked at, and on a phone it closes the drawer as well", async () => {
  app.answer((request) => request["name"] === "presence" ? { statuses: [], history: [] } : undefined);
  const { Sidebar } = await import("../../src/browser/sidebar/Sidebar.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { navigate } = await import("../../src/browser/app/route.ts");
  app.restores.push(() => { navigate({ view: "chat" }); });
  const state = chromeOf(undefined, app.state().workspace.getSnapshot());
  const closed: string[] = [];
  const settings = (root: ParentNode) => [...root.querySelectorAll("button")].find((button) => button.textContent === "Settings");
  navigate({ view: "settings", page: "usage" });
  navigate({ view: "chat" });
  expect(location.hash).toBe("");

  const desk = await mount(<Sidebar state={state} mobile={false} close={() => { closed.push("desk"); }} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} openSwitcher={() => {}} />);
  await acting(() => { settings(desk.host)?.click(); });
  expect(location.hash).toBe("#settings/usage");
  expect(closed).toEqual([]);
  await desk.unmount();

  await acting(() => { navigate({ view: "chat" }); });
  expect(location.hash).toBe("");
  const phone = await mount(<Sidebar state={state} mobile close={() => { closed.push("phone"); }} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} openSwitcher={() => {}} />);
  await acting(() => { settings(phone.host)?.click(); });
  expect(location.hash).toBe("#settings/usage");
  expect(closed).toEqual(["phone"]);
});

async function sideBar(over: Record<string, unknown>, mobile = false, close: () => void = () => {}) {
  app.answer((request) => {
    const name = (request["args"] as { name?: string } | undefined)?.name ?? "";
    switch (request["name"]) {
      case "presence": return { statuses: [], history: [] };
      case "switch_character": return { character: name, changed: true };
      case "switch_thread": return { character: "ada", thread: name, changed: true };
      default: return undefined;
    }
  });
  const { Sidebar } = await import("../../src/browser/sidebar/Sidebar.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const threads = [{ id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true }, { id: "side", created_at: "2026-11-02T00:00:00Z", compaction: false, home: false, current: false }];
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), status: "ready", character: "ada", thread: "story", threads, characters: [{ name: "ada" }, { name: "bo" }], ...over };
  const view = await mount(<Sidebar state={state} mobile={mobile} close={close} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} openSwitcher={() => {}} />);
  await settle();
  const character = (name: string) => [...view.host.querySelectorAll<HTMLButtonElement>(".sidebar-item.character")].find((item) => item.querySelector(".sidebar-name")?.textContent === name);
  const thread = (name: string) => [...view.host.querySelectorAll<HTMLElement>(".sidebar-item.thread")].find((item) => item.querySelector(".sidebar-name")?.textContent === name);
  return { ...view, character, thread };
}

test("choosing a character or thread shows the chat, closes the phone drawer, and opens it only when it isn't the one shown", async () => {
  const { navigate } = await import("../../src/browser/app/route.ts");
  app.restores.push(() => { navigate({ view: "chat" }); });
  const asked = (since: number) => app.sent(since).filter((request) => String(request["name"]).startsWith("switch_")).map((request) => [request["name"], request["args"]]);
  const closed: string[] = [];
  for (const mobile of [false, true]) {
    const view = await sideBar({}, mobile, () => closed.push(mobile ? "phone" : "desk"));
    navigate({ view: "settings", page: "usage" });
    let since = app.socket().sent.length;
    await acting(() => { view.character("bo")?.click(); });
    expect([location.hash, asked(since)]).toEqual(["", [["switch_character", { name: "bo" }]]]);
    navigate({ view: "settings", page: "usage" });
    since = app.socket().sent.length;
    await acting(() => { view.thread("side")?.click(); });
    expect([location.hash, asked(since)]).toEqual(["", [["switch_thread", { name: "side", resync: true }]]]);
    since = app.socket().sent.length;
    await acting(() => { view.character("ada")?.click(); view.thread("story")?.click(); });
    expect(asked(since), "the one already shown").toEqual([]);
    await view.unmount();
  }
  expect(closed).toEqual(["phone", "phone", "phone", "phone"]);
});

test("the shown character is marked, one being opened says so, the search shows a small icon, and only a ready daemon with no characters says there are none", async () => {
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const icon = await mount(<Icon name="search" size={16} />);
  const drawn = icon.host.innerHTML;
  await icon.unmount();
  const opening = await sideBar({ opening: { character: "bo", thread: null } });
  const marks = (name: string) => [opening.character(name)?.getAttribute("aria-current") ?? null, opening.character(name)?.getAttribute("aria-busy"), opening.character(name)?.querySelector(".sidebar-replying .sr-only")?.textContent ?? null];
  expect([marks("ada"), marks("bo")]).toEqual([[null, "false", null], ["true", "true", "(opening)"]]);
  expect(opening.host.querySelector("button.sidebar-search svg")?.outerHTML).toBe(drawn);
  await opening.unmount();
  const settled = await sideBar({ opening: { character: "ada", thread: "side" } });
  expect([settled.character("ada")?.getAttribute("aria-busy"), settled.character("ada")?.getAttribute("aria-current")], "the open character opening another thread isn't busy").toEqual(["false", "true"]);
  await settled.unmount();
  const empty = (over: Record<string, unknown>) => sideBar(over).then(async (view) => { const text = view.host.querySelector(".sidebar-empty")?.textContent ?? null; await view.unmount(); return text; });
  expect([await empty({ characters: [] }), await empty({ characters: [], status: "reconnecting" }), await empty({})]).toEqual(["No characters yet.", null, null]);
});

test("a reply starting elsewhere shows on its thread without the sidebar being drawn again", async () => {
  const { conversation } = app.state();
  const view = await sideBar({ thread: "side" });
  expect(view.thread("story")?.querySelector(".sidebar-replying")).toBeNull();
  await acting(() => { void conversation.submit("message", { text: "hello" }).catch(() => undefined); });
  await settle();
  expect(view.thread("story")?.querySelector(".sidebar-replying .sr-only")?.textContent).toBe("(replying)");
});

test("another character's row counts its unread replies and threads marked for later, and the open character's row leaves that to its threads", async () => {
  const thread = (id: string, over: Record<string, unknown> = {}) => ({ id, created_at: "2026-11-01T00:00:00Z", compaction: false, home: false, current: false, ...over });
  const view = await sideBar({
    characters: [{ name: "ada" }, { name: "bo" }, { name: "cy" }, { name: "dee" }],
    threads: [thread("story", { home: true, unread: 5, later: "2026-11-27T00:00:00Z" })],
    allThreads: [
      { character: "ada", threads: [thread("story", { unread: 9 })] },
      { character: "bo", threads: [thread("main", { unread: 2 }), thread("rowing", { unread: 1, later: "2026-11-27T00:00:00Z" }), thread("shelf", { later: "2026-11-26T00:00:00Z" })] },
      { character: "cy", threads: [thread("main")] },
    ],
  });
  const counts = (name: string) => [view.character(name)?.querySelector(".sidebar-later-count .sr-only")?.textContent ?? null, view.character(name)?.querySelector(".sidebar-unread .sr-only")?.textContent ?? null];
  expect([counts("ada"), counts("bo"), counts("cy"), counts("dee")]).toEqual([
    [null, null], ["(2 marked for later)", "(3 unread messages)"], [null, null], [null, null],
  ]);
});

test("a single unread reply or thread marked for later still counts on another character's row", async () => {
  const thread = (id: string, over: Record<string, unknown> = {}) => ({ id, created_at: "2026-11-01T00:00:00Z", compaction: false, home: false, current: false, ...over });
  const view = await sideBar({ allThreads: [{ character: "bo", threads: [thread("main", { unread: 1, later: "2026-11-27T00:00:00Z" })] }] });
  expect([view.character("bo")?.querySelector(".sidebar-later-count .sr-only")?.textContent, view.character("bo")?.querySelector(".sidebar-unread .sr-only")?.textContent]).toEqual(["(1 marked for later)", "(1 unread message)"]);
});

test("the open character's row, drawn at its size and marked on, has a menu from its button or a right-click that makes a folder or sorts its threads, and another character's row has none", async () => {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const { FOLDER_DIALOG_EVENT } = await import("../../src/browser/app/intents.ts");
  const drawn = await mount(<Icon name="more" size={16} />);
  const moreIcon = drawn.host.innerHTML;
  await drawn.unmount();
  const folders: unknown[] = [];
  const asked = (event: Event) => { folders.push((event as CustomEvent).detail); };
  addEventListener(FOLDER_DIALOG_EVENT, asked);
  app.restores.push(() => { removeEventListener(FOLDER_DIALOG_EVENT, asked); });
  let sortFails = false;
  const sorting = () => app.answer((request) => {
    if (request["name"] !== "thread_sort") return request["name"] === "presence" ? { statuses: [], history: [] } : undefined;
    if (sortFails) throw new Error("the index is locked");
    return { character: "ada", threads: [], home: "story", current: "story" };
  });
  const view = await sideBar({ manualOrder: true });
  sorting();
  const row = (name: string) => view.character(name)?.closest(".character-row");
  const more = () => view.host.querySelector<HTMLButtonElement>(".character-row .thread-more");
  const menu = () => document.body.querySelector("[role=menu]");
  const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
  const shown = () => items().map((item) => [item.querySelector(".menu-label")?.textContent, item.querySelector(".menu-detail")?.textContent ?? null, item.disabled]);
  const choose = async (label: string) => { await acting(() => { items().find((item) => item.querySelector(".menu-label")?.textContent === label)?.click(); }); await settle(); };

  expect([view.character("ada")?.classList.contains("on"), view.character("bo")?.classList.contains("on"), view.character("ada")?.querySelector<HTMLElement>(".avatar")?.style.width]).toEqual([true, false, "30px"]);
  expect([...view.host.querySelectorAll(".character-row .thread-more")].map((button) => [button.getAttribute("aria-label"), button.getAttribute("aria-expanded"), button.innerHTML])).toEqual([["Options for ada’s threads", "false", moreIcon]]);
  await acting(() => { view.character("bo")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  expect(menu(), "another character's row has no menu").toBeNull();

  await acting(() => { more()?.click(); });
  expect([menu()?.getAttribute("aria-label"), more()?.getAttribute("aria-expanded"), row("ada")?.classList.contains("menu-open"), shown()]).toEqual([
    "Options for ada’s threads", "true", true, [["New folder…", null, false], ["Sort threads by activity", null, false]],
  ]);
  await choose("New folder…");
  expect([folders, menu(), row("ada")?.classList.contains("menu-open")]).toEqual([[{ kind: "new" }], null, false]);

  await acting(() => { view.character("ada")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  const since = app.socket().sent.length;
  await choose("Sort threads by activity");
  expect([app.sent(since).filter((request) => request["name"] === "thread_sort").map((request) => request["args"]), app.state().workspace.getSnapshot().manualOrder]).toEqual([[{ by_activity: true }], false]);
  await view.unmount();

  const sorted = await sideBar({ manualOrder: false });
  sorting();
  sortFails = true;
  await acting(() => { sorted.host.querySelector<HTMLButtonElement>(".character-row .thread-more")?.click(); });
  expect(shown()[1]).toEqual(["Sort threads by activity", "On", false]);
  const again = app.socket().sent.length;
  await choose("Sort threads by activity");
  expect([app.sent(again).filter((request) => request["name"] === "thread_sort").map((request) => request["args"]), toasts.getSnapshot().at(-1)?.text]).toEqual([[{ by_activity: false }], "the index is locked"]);
  await sorted.unmount();

  const offline = await sideBar({ status: "reconnecting" });
  await acting(() => { offline.host.querySelector<HTMLButtonElement>(".character-row .thread-more")?.click(); });
  expect(shown().map((item) => item[2]), "nothing in it works while the daemon is away").toEqual([true, true]);
});

test("the search at the top of the sidebar opens the switcher, closing the phone drawer first, and every character stays listed", async () => {
  app.answer((request) => request["name"] === "presence" ? { statuses: [], history: [] } : undefined);
  const { Sidebar } = await import("../../src/browser/sidebar/Sidebar.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), characters: [{ name: "ada" }, { name: "bo" }] };
  const steps: string[] = [];
  const open = async (mobile: boolean) => {
    const view = await mount(<Sidebar state={state} mobile={mobile} close={() => steps.push("close")} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} openSwitcher={() => steps.push("switcher")} />);
    const search = view.host.querySelector<HTMLButtonElement>("button.sidebar-search");
    const shown = [search?.querySelector(".sidebar-search-text")?.textContent, search?.querySelector("kbd")?.textContent ?? null, [...view.host.querySelectorAll(".sidebar-item.character .sidebar-name")].map((name) => name.textContent)];
    await acting(() => { search?.click(); });
    await view.unmount();
    return shown;
  };
  expect(await open(false)).toEqual(["Find a thread or command", "Ctrl K", ["ada", "bo"]]);
  expect(steps).toEqual(["switcher"]);
  steps.length = 0;
  expect(await open(true)).toEqual(["Find a thread or command", null, ["ada", "bo"]]);
  expect(steps).toEqual(["close", "switcher"]);
});
