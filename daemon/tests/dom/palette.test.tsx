import { expect, test } from "bun:test";

import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import type { ChromeSnapshot } from "../../src/browser/workspace.ts";
import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };
const frame = async () => { await acting(async () => { await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); }); }); };

const HOME: ThreadView = { id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true };
const lamp = (name: string, position: number): ThreadView => ({ id: `lamp-${name}`, created_at: "2026-11-02T00:00:00Z", compaction: true, home: false, current: false, position });
const LAMPS = [lamp("a", 1), lamp("b", 2), lamp("c", 3)];

async function chrome(over: Partial<ChromeSnapshot> = {}): Promise<ChromeSnapshot> {
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  return { ...chromeOf(undefined, app.state().workspace.getSnapshot()), status: "ready", character: "ada", thread: "story", threads: [HOME, ...LAMPS], characters: [{ name: "ada" }, { name: "bo" }], ...over };
}

async function palette(state: ChromeSnapshot, closed: () => void = () => {}) {
  const { Palette } = await import("../../src/browser/app/Palette.tsx");
  const element = (next: ChromeSnapshot) => <Palette state={next} close={closed} newThread={() => {}} newCharacter={() => {}} />;
  const view = await mount(element(state));
  const options = () => [...view.host.querySelectorAll<HTMLButtonElement>("[role=option]")];
  const label = (item: Element) => item.querySelector(".palette-label")?.textContent ?? "";
  const search = () => view.host.querySelector("input[type=search]");
  return {
    ...view,
    labels: () => options().map(label),
    picked: () => options().filter((item) => item.getAttribute("aria-selected") === "true").map(label),
    lit: () => options().filter((item) => item.classList.contains("on")).map(label),
    empty: () => view.host.querySelector(".picker-empty")?.textContent,
    search: async (query: string) => { await type(search(), query); },
    press: async (key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await acting(() => { search()?.dispatchEvent(event); });
      return event.defaultPrevented;
    },
    point: async (index: number) => { await acting(() => { options()[index]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); }); },
    choose: async (text: string) => { await click(options().find((item) => label(item) === text)); },
    scope: async (name: string) => { await click(button(view.host, name)); },
    checked: () => [...view.host.querySelectorAll("[role=radio]")].map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]),
    rerender: async (next: ChromeSnapshot) => { await view.update(element(next)); },
  };
}

const asked = (since: number, name: string) => app.sent(since).filter((request) => request["name"] === name).map((request) => request["args"]);

function watchScrolling(): unknown[][] {
  const scrolled: unknown[][] = [];
  const had = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollIntoViewOptions) { scrolled.push([this.querySelector(".palette-label")?.textContent, options]); },
  });
  app.restores.push(() => { if (had === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", had); });
  return scrolled;
}

test("the palette opens on everything with its first entry picked and small icons, asks for no settings keys, and says when nothing matches", async () => {
  const since = app.socket().sent.length;
  const view = await palette(await chrome());
  await settle();
  expect(view.checked()).toEqual([["Everything", "true"], ["Shortcuts", "false"], ["Settings keys", "false"]]);
  expect(view.labels().slice(3, 5), "the threads come before the commands").toEqual(["New thread", "Thread settings"]);
  expect([view.picked(), view.lit()]).toEqual([["Open lamp-a"], ["Open lamp-a"]]);
  expect([...view.host.querySelectorAll(".picker-search svg, [role=option] svg")].map((icon) => icon.getAttribute("width")).filter((width) => width !== "16")).toEqual([]);
  expect(asked(since, "config_schema")).toEqual([]);
  await view.search("zzz");
  expect([view.labels(), view.empty()]).toEqual([[], "Nothing matches."]);
});

test("with nothing typed the threads come first: the one visited before this one, then the rest newest first and archived last, each with its unread count, and not the open one", async () => {
  const { noteVisit } = await import("../../src/browser/app/recent.ts");
  noteVisit("ada", "lamp-c");
  noteVisit("ada", "story");
  const threads = [HOME, { ...lamp("a", 1), last_active: "2026-11-05T00:00:00Z", unread: 3 }, { ...lamp("b", 2), last_active: "2026-11-09T00:00:00Z" }, lamp("c", 3), { ...lamp("d", 4), archived: "2026-11-10T00:00:00Z", last_active: "2026-11-11T00:00:00Z" }];
  const view = await palette(await chrome({ threads }));
  expect(view.labels().slice(0, 5)).toEqual(["Open lamp-c", "Open lamp-b", "Open lamp-a", "Open lamp-d", "New thread"]);
  const shown = [...view.host.querySelectorAll("[role=option]")].slice(0, 4).map((item) => [item.querySelector(".sidebar-unread [aria-hidden]")?.textContent ?? null, item.querySelector(".palette-detail")?.textContent]);
  expect(shown).toEqual([[null, "ada"], [null, "ada"], ["3", "ada"], [null, "ada · archived"]]);
  expect(view.host.querySelectorAll("[role=option] .sidebar-unread"), "only threads with unread replies count them").toHaveLength(1);
  await view.rerender(await chrome({ threads: [HOME, { ...lamp("a", 1), unread: 1 }] }));
  expect([...view.host.querySelectorAll("[role=option] .sidebar-unread [aria-hidden]")].map((badge) => badge.textContent)).toEqual(["1"]);
});

test("Enter on the switcher as it opens goes back to the thread visited before this one", async () => {
  app.answer((request) => request["name"] === "switch_thread" ? { character: "ada", thread: "lamp-b", changed: true } : undefined);
  const { noteVisit } = await import("../../src/browser/app/recent.ts");
  noteVisit("ada", "lamp-b");
  noteVisit("ada", "story");
  const view = await palette(await chrome());
  const since = app.socket().sent.length;
  await view.press("Enter");
  await settle();
  expect(asked(since, "switch_thread")).toEqual([{ name: "lamp-b", resync: true }]);
});

test("other characters' threads are listed under their names, the visit before first wherever it was, and choosing one opens that character on that thread", async () => {
  app.answer((request) => request["name"] === "switch_character" ? { character: "bo", changed: true } : undefined);
  const { noteVisit } = await import("../../src/browser/app/recent.ts");
  noteVisit("bo", "shelf");
  noteVisit("ada", "story");
  const bo = [{ ...HOME, id: "main", current: false }, { ...lamp("x", 1), id: "rowing", last_active: "2026-11-20T00:00:00Z", unread: 2 }, { ...lamp("y", 2), id: "shelf" }];
  const view = await palette(await chrome({ allThreads: [{ character: "ada", threads: [HOME] }, { character: "bo", threads: bo }] }));
  const rows = () => [...view.host.querySelectorAll("[role=option]")].slice(0, 3).map((item) => [item.querySelector(".palette-label")?.textContent, item.querySelector(".palette-detail")?.textContent, item.querySelector(".sidebar-unread [aria-hidden]")?.textContent ?? null]);
  expect(rows()).toEqual([["Open shelf", "bo", null], ["Open rowing", "bo", "2"], ["Open lamp-a", "ada", null]]);
  const since = app.socket().sent.length;
  await view.choose("Open rowing");
  await settle();
  expect(app.sent(since).filter((request) => String(request["name"]).startsWith("switch_")).map((request) => [request["name"], request["args"]])).toEqual([
    ["switch_character", { name: "bo", thread: "rowing" }],
  ]);
});

test("Another take from the palette asks for a different reply, in the chat", async () => {
  const { navigate } = await import("../../src/browser/app/route.ts");
  app.restores.push(() => { navigate({ view: "chat" }); });
  navigate({ view: "settings", page: "models" });
  const view = await palette(await chrome());
  const since = app.socket().sent.length;
  await view.choose("Another take");
  await settle();
  expect([location.hash, app.sent(since).filter((request) => request["type"] === "regen").map((request) => request["another_take"])]).toEqual(["", [true]]);
});

test("a thread is found by its name or its label", async () => {
  const view = await palette(await chrome({ threads: [HOME, { ...lamp("a", 1), label: "Harbour lights" }, lamp("b", 2)] }));
  await view.search("lamp-a");
  expect(view.labels()).toEqual(["Open Harbour lights"]);
  await view.search("harbour");
  expect(view.labels()).toEqual(["Open Harbour lights"]);
});

test("the palette shows at most sixty commands", async () => {
  const many = Array.from({ length: 60 }, (_, index) => lamp(String(index), index + 1));
  const view = await palette(await chrome({ threads: [HOME, ...many] }));
  expect(view.labels()).toHaveLength(60);
});

test("typing, the pointer and the arrow keys pick a command, the pick stays put as the list changes, and Enter runs it from wherever the user is", async () => {
  app.answer((request) => request["name"] === "switch_thread" ? { character: "ada", thread: "lamp-a", changed: true } : undefined);
  const { navigate } = await import("../../src/browser/app/route.ts");
  app.restores.push(() => { navigate({ view: "chat" }); });
  const scrolled = watchScrolling();
  const { noteVisit } = await import("../../src/browser/app/recent.ts");
  noteVisit("ada", "lamp-a");
  let closed = 0;
  const state = await chrome();
  const view = await palette(state, () => { closed += 1; });

  await view.point(2);
  expect(view.picked()).toEqual(view.labels().slice(2, 3));
  await view.search("lamp");
  expect(view.labels()).toEqual(["Open lamp-a", "Open lamp-b", "Open lamp-c"]);
  expect(view.picked()).toEqual(["Open lamp-a"]);

  expect(await view.press("ArrowDown")).toBe(true);
  expect([view.picked(), view.lit()]).toEqual([["Open lamp-b"], ["Open lamp-b"]]);
  expect(scrolled.at(-1)).toEqual(["Open lamp-b", { block: "nearest" }]);
  await view.press("ArrowDown");
  await view.press("ArrowDown");
  expect(view.picked()).toEqual(["Open lamp-c"]);
  await view.rerender({ ...state, threads: [HOME, ...LAMPS, lamp("d", 4)] });
  expect(view.picked()).toEqual(["Open lamp-c"]);

  expect(await view.press("ArrowUp")).toBe(true);
  expect(view.picked()).toEqual(["Open lamp-b"]);
  await view.press("ArrowUp");
  await view.press("ArrowUp");
  expect(view.picked()).toEqual(["Open lamp-a"]);

  await view.point(3);
  expect(view.picked()).toEqual(["Open lamp-d"]);
  await view.rerender({ ...state, threads: [HOME, lamp("a", 1)] });
  expect([view.labels(), view.picked()]).toEqual([["Open lamp-a"], ["Open lamp-a"]]);
  expect(closed).toBe(0);

  navigate({ view: "settings", page: "models" });
  const since = app.socket().sent.length;
  expect(await view.press("Enter")).toBe(true);
  await settle();
  expect([closed, location.hash]).toEqual([1, ""]);
  expect(asked(since, "switch_thread")).toEqual([{ name: "lamp-a", resync: true }]);
});

test("the palette lists the keyboard shortcuts, and the settings keys once they load, each starting from its first", async () => {
  app.answer((request) => request["name"] === "config_schema" ? HOLD : undefined);
  const { navigate } = await import("../../src/browser/app/route.ts");
  const { takeConfigSearch } = await import("../../src/browser/app/intents.ts");
  app.restores.push(() => { navigate({ view: "chat" }); takeConfigSearch(); });
  let closed = 0;
  const view = await palette(await chrome(), () => { closed += 1; });

  await view.point(2);
  await view.scope("Shortcuts");
  expect(view.checked()).toEqual([["Everything", "false"], ["Shortcuts", "true"], ["Settings keys", "false"]]);
  expect(view.labels().slice(0, 2)).toEqual(["Open the command palette", "Focus the message box"]);
  expect(view.picked()).toEqual(["Open the command palette"]);

  await view.point(2);
  const since = app.socket().sent.length;
  await view.scope("Settings keys");
  await settle();
  expect([view.labels(), view.empty()]).toEqual([[], "Loading settings…"]);
  const [schema] = app.sent(since).filter((request) => request["name"] === "config_schema");
  const entry = (key: string, settable: boolean) => ({ key, kind: "string", type: "String", settable, optional: true, restart_required: false, secret: false, values: [] });
  await acting(async () => {
    app.socket().receive({ type: "command_output", rid: schema?.["rid"], name: "config_schema", data: { sources: { chat_models: [], tools: [], subagents: [], characters: [], providers: [] }, schema: [entry("defaults.model", true), entry("dirs.data", false), entry("providers.<name>.api_key_env", true)] } });
    app.socket().receive({ type: "request_finished", rid: schema?.["rid"], outcome: "completed" });
    await Bun.sleep(5);
  });
  expect([view.labels(), view.picked()]).toEqual([["defaults.model"], ["defaults.model"]]);
  expect(asked(since, "config_schema")).toEqual([{}]);

  await view.search("zzz");
  expect(view.empty()).toBe("Nothing matches.");
  await view.search("");
  await view.choose("defaults.model");
  expect([closed, location.hash, takeConfigSearch()]).toEqual([1, "#settings/configuration", "defaults.model"]);
});

test("the palette opens thread and conversation dialogs, and characters, in the chat from wherever the user is", async () => {
  app.answer((request) => request["name"] === "switch_character" ? { character: "bo", changed: true } : undefined);
  const { navigate } = await import("../../src/browser/app/route.ts");
  const { CONVERSATION_DIALOG_EVENT, THREAD_DIALOG_EVENT } = await import("../../src/browser/app/intents.ts");
  app.restores.push(() => { navigate({ view: "chat" }); });
  const heard: unknown[] = [];
  const listen = (name: string) => {
    const hear = (event: Event) => { heard.push([name, (event as CustomEvent).detail]); };
    addEventListener(name, hear);
    app.restores.push(() => { removeEventListener(name, hear); });
  };
  listen(THREAD_DIALOG_EVENT);
  listen(CONVERSATION_DIALOG_EVENT);
  const view = await palette(await chrome());

  navigate({ view: "settings", page: "models" });
  await view.choose("Fork thread");
  expect([location.hash, heard]).toEqual(["", [[THREAD_DIALOG_EVENT, { kind: "fork", thread: "story" }]]]);

  navigate({ view: "settings", page: "models" });
  await view.choose("Compact context");
  expect(location.hash).toBe("");
  await frame();
  expect(heard.at(-1)).toEqual([CONVERSATION_DIALOG_EVENT, "compact"]);

  navigate({ view: "settings", page: "models" });
  const since = app.socket().sent.length;
  await view.choose("Go to bo");
  await settle();
  expect([location.hash, asked(since, "switch_character")]).toEqual(["", [{ name: "bo" }]]);
});
