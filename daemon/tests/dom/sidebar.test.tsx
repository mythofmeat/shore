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
