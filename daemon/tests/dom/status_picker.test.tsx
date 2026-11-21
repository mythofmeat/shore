import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";

import type { PresenceArgs } from "../../src/protocol/PresenceArgs.ts";
import type { PresenceResult } from "../../src/protocol/PresenceResult.ts";
import { acting, button, mount, type, useDom } from "./dom.ts";

useDom();

const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  setSystemTime();
  document.body.replaceChildren();
});

async function picker() { return await import("../../src/browser/sidebar/StatusPicker.tsx"); }

const NOW = Date.UTC(2026, 9, 30, 14);
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

interface Daemon {
  asked: PresenceArgs[];
  failures: unknown[];
  held: PresenceResult;
  broken: Error | undefined;
  ask: (args: PresenceArgs) => Promise<PresenceResult>;
  failed: (error: unknown) => void;
}

function daemon(history: string[], on: [string, number][] = []): Daemon {
  const d: Daemon = {
    asked: [],
    failures: [],
    held: { statuses: on.map(([status, minutes]) => ({ status, set_at: ago(minutes) })), history },
    broken: undefined,
    ask: async (args) => {
      d.asked.push(args);
      if (d.broken !== undefined) throw d.broken;
      const off = new Set(args.clear === true ? d.held.statuses.map((status) => status.status) : args.off);
      const kept = d.held.statuses.filter((status) => !off.has(status.status));
      const added = (args.on ?? []).filter((name) => !kept.some((status) => status.status === name)).map((status) => ({ status, set_at: ago(0) }));
      const used = [...(args.on ?? []), ...d.held.history.filter((name) => !(args.on ?? []).includes(name))].filter((name) => !(args.forget ?? []).includes(name));
      d.held = { statuses: [...kept, ...added], history: used };
      return d.held;
    },
    failed: (error) => { d.failures.push(error); },
  };
  return d;
}

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

const trigger = (root: ParentNode) => root.querySelector<HTMLButtonElement>(".sidebar-status > button");
const panel = (root: ParentNode) => root.querySelector("[role=dialog]");
const chips = (root: ParentNode) => [...root.querySelectorAll(".status-chip")].map((chip) => [chip.querySelector(".status-chip-name")?.textContent, chip.querySelector(".status-chip-age")?.textContent]);
const used = (root: ParentNode) => [...root.querySelectorAll(".status-history .status-pick")].map((item) => item.textContent);
const field = (root: ParentNode) => root.querySelector<HTMLInputElement>("input[aria-label='Add a status']");
async function submit(root: ParentNode): Promise<Event> {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  await acting(() => { root.querySelector("form.status-add")?.dispatchEvent(event); });
  return event;
}

test("the picker asks for the statuses once the page is connected, and with none on offers a field and the ones used before", async () => {
  setSystemTime(new Date(NOW));
  const { StatusPicker, PresenceStore } = await picker();
  const d = daemon(["asleep", "at work"]);
  const store = new PresenceStore(d.ask, d.failed);
  const view = await mount(<StatusPicker ready={false} store={store} />);
  expect(d.asked).toEqual([]);
  expect(view.host.innerHTML).toBe("");

  await view.update(<StatusPicker ready store={store} />);
  expect(d.asked).toEqual([{}]);
  const row = trigger(view.host);
  expect([row?.textContent, row?.getAttribute("aria-label"), row?.getAttribute("title"), row?.getAttribute("aria-expanded"), row?.querySelector(".sidebar-name")?.className]).toEqual(["Set status", "Your status", "Your status", "false", "sidebar-name unset"]);
  await acting(() => { row?.click(); });
  expect([panel(view.host)?.className, panel(view.host)?.getAttribute("aria-label"), row?.getAttribute("aria-expanded")]).toEqual(["menu-list align-start above status-panel", "Your status", "true"]);
  expect(document.activeElement).toBe(field(view.host));
  expect(view.host.querySelector(".status-on")).toBeNull();
  expect(view.host.querySelector(".status-history")?.getAttribute("aria-label")).toBe("Used before");
  expect(used(view.host)).toEqual(["asleep", "at work"]);
  expect(view.host.querySelector(".status-clear")).toBeNull();
  await acting(() => { row?.click(); });
  expect(panel(view.host), "its button closes it again").toBeNull();
});

test("a typed status goes on when it is entered, trimmed, the field empties, and the panel stays open for the next", async () => {
  setSystemTime(new Date(NOW));
  const { StatusPicker, PresenceStore } = await picker();
  const d = daemon([]);
  const view = await mount(<StatusPicker ready store={new PresenceStore(d.ask, d.failed)} />);
  expect(view.host.querySelector(".status-history")).toBeNull();
  await acting(() => { trigger(view.host)?.click(); });
  expect(view.host.querySelector(".status-history"), "nothing has been used yet").toBeNull();

  await type(field(view.host), "   ");
  expect((await submit(view.host)).defaultPrevented).toBe(true);
  expect(d.asked).toEqual([{}]);

  await type(field(view.host), "  on the couch ");
  await submit(view.host);
  expect(d.asked.at(-1)).toEqual({ on: ["on the couch"] });
  expect(field(view.host)?.value).toBe("");
  await type(field(view.host), "home");
  await submit(view.host);
  expect(panel(view.host)).not.toBeNull();
  expect(chips(view.host)).toEqual([["on the couch", "1m"], ["home", "1m"]]);
  expect(view.host.querySelector(".status-on")?.getAttribute("aria-label")).toBe("On now");
  const row = trigger(view.host);
  expect([row?.textContent, row?.getAttribute("aria-label"), row?.getAttribute("title"), row?.querySelector(".sidebar-name")?.className]).toEqual(["on the couch, home", "Your status: on the couch, home", "Your status: on the couch, home", "sidebar-name"]);
  expect(d.failures).toEqual([]);
});

test("each status on shows how long it has been on and can be turned off alone, and all of them at once", async () => {
  setSystemTime(new Date(NOW));
  const { StatusPicker, PresenceStore } = await picker();
  const d = daemon(["home", "sick", "out"], [["home", 300], ["sick", 26 * 60], ["out", 59]]);
  const view = await mount(<StatusPicker ready store={new PresenceStore(d.ask, d.failed)} />);
  await acting(() => { trigger(view.host)?.click(); });
  expect(chips(view.host)).toEqual([["home", "5h"], ["sick", "1d"], ["out", "59m"]]);
  expect(used(view.host), "the ones on aren't offered again").toEqual([]);

  await acting(() => { button(view.host, "Turn off sick").focus(); button(view.host, "Turn off sick").click(); });
  expect(d.asked.at(-1)).toEqual({ off: ["sick"] });
  expect(document.activeElement, "the field keeps the keyboard once the button is gone").toBe(field(view.host));
  expect(chips(view.host).map(([name]) => name)).toEqual(["home", "out"]);
  expect(used(view.host)).toEqual(["sick"]);

  await acting(() => { button(view.host, "Turn all off").focus(); button(view.host, "Turn all off").click(); });
  expect(d.asked.at(-1)).toEqual({ clear: true });
  expect(document.activeElement).toBe(field(view.host));
  expect(view.host.querySelector(".status-on")).toBeNull();
  expect(trigger(view.host)?.textContent).toBe("Set status");
  expect(used(view.host)).toEqual(["home", "sick", "out"]);
});

test("the ones used before are narrowed to those holding what is typed, whatever its case, and each can be put on again or forgotten", async () => {
  setSystemTime(new Date(NOW));
  const { StatusPicker, PresenceStore } = await picker();
  const d = daemon(["in bed", "reading a book", "Bedtime story", "out"], [["out", 10]]);
  const view = await mount(<StatusPicker ready store={new PresenceStore(d.ask, d.failed)} />);
  await acting(() => { trigger(view.host)?.click(); });
  await type(field(view.host), " BED");
  expect(used(view.host)).toEqual(["in bed", "Bedtime story"]);
  await type(field(view.host), "");

  const book = [...view.host.querySelectorAll<HTMLButtonElement>(".status-pick")].find((item) => item.textContent === "reading a book");
  await acting(() => { book?.focus(); book?.click(); });
  expect(d.asked.at(-1)).toEqual({ on: ["reading a book"] });
  expect(document.activeElement).toBe(field(view.host));
  expect(chips(view.host).map(([name]) => name)).toEqual(["out", "reading a book"]);

  await acting(() => { button(view.host, "Forget Bedtime story").focus(); button(view.host, "Forget Bedtime story").click(); });
  expect(d.asked.at(-1)).toEqual({ forget: ["Bedtime story"] });
  expect(document.activeElement).toBe(field(view.host));
  expect(used(view.host)).toEqual(["in bed"]);
});

test("Escape closes the panel and goes back to its button, a press outside closes it and one inside doesn't, and keys do nothing while it is closed", async () => {
  setSystemTime(new Date(NOW));
  const { StatusPicker, PresenceStore } = await picker();
  const d = daemon(["asleep"]);
  const outside = document.createElement("div");
  document.body.append(outside);
  const view = await mount(<StatusPicker ready store={new PresenceStore(d.ask, d.failed)} />);
  let heard = 0;
  const count = () => { heard += 1; };
  document.addEventListener("keydown", count);
  restores.push(() => { document.removeEventListener("keydown", count); });

  await acting(() => { trigger(view.host)?.click(); });
  let escape: KeyboardEvent | undefined;
  await acting(() => { escape = key(field(view.host) ?? view.host, "Escape"); });
  expect(panel(view.host)).toBeNull();
  expect([escape?.defaultPrevented, heard, document.activeElement === trigger(view.host)]).toEqual([true, 0, true]);
  const ignored = key(trigger(view.host) ?? view.host, "Escape");
  expect([ignored.defaultPrevented, heard]).toEqual([false, 1]);

  await acting(() => { trigger(view.host)?.click(); });
  const typing = key(field(view.host) ?? view.host, "a");
  expect([typing.defaultPrevented, panel(view.host) !== null]).toEqual([false, true]);
  await acting(() => { field(view.host)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  expect(panel(view.host), "a press inside keeps it open").not.toBeNull();
  await acting(() => { outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  expect(panel(view.host)).toBeNull();
});

test("the panel listens for presses outside only while it is open, and stops when it closes or is gone", async () => {
  const { StatusPicker, PresenceStore } = await picker();
  const added = spyOn(document, "addEventListener");
  const removed = spyOn(document, "removeEventListener");
  restores.push(() => { added.mockRestore(); removed.mockRestore(); });
  const presses = (spy: typeof added) => spy.mock.calls.filter(([kind]) => kind === "pointerdown").map(([, listener]) => listener);
  const d = daemon(["asleep"]);
  const view = await mount(<StatusPicker ready store={new PresenceStore(d.ask, d.failed)} />);
  expect(presses(added)).toEqual([]);
  await acting(() => { trigger(view.host)?.click(); });
  expect(presses(added)).toHaveLength(1);
  expect(presses(removed)).toEqual([]);
  await acting(() => { trigger(view.host)?.click(); });
  expect(presses(removed)).toEqual(presses(added));
  await acting(() => { trigger(view.host)?.click(); });
  await view.unmount();
  expect(presses(added)).toHaveLength(2);
  expect(presses(removed)).toEqual(presses(added));
});

test("how long a status has been on is shown in whole minutes, hours or days, and never less than a minute", async () => {
  const { onFor } = await picker();
  const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  expect([0, -5, 1.5, 59.9, 60, 23 * 60 + 59, 24 * 60, 3 * 24 * 60 + 1].map((minutes) => onFor(at(minutes), NOW))).toEqual(["1m", "1m", "1m", "59m", "1h", "23h", "1d", "3d"]);
});

test("the picker asks again when the window gets focus, so a status set from another client shows, and stops once it is gone", async () => {
  const { StatusPicker, PresenceStore } = await picker();
  const d = daemon(["asleep"]);
  const store = new PresenceStore(d.ask, d.failed);
  const view = await mount(<StatusPicker ready store={store} />);
  d.held = { statuses: [{ status: "asleep", set_at: ago(30) }], history: ["asleep"] };
  await acting(() => { window.dispatchEvent(new Event("focus")); });
  expect(d.asked).toEqual([{}, {}]);
  expect(trigger(view.host)?.textContent).toBe("asleep");

  await view.update(<StatusPicker ready={false} store={store} />);
  await acting(() => { window.dispatchEvent(new Event("focus")); });
  expect(d.asked).toHaveLength(2);
  await view.unmount();
  await acting(() => { window.dispatchEvent(new Event("focus")); });
  expect(d.asked).toHaveLength(2);
});

test("a status the daemon refuses is reported and the picker keeps showing what it had", async () => {
  const { StatusPicker, PresenceStore } = await picker();
  const d = daemon(["asleep"], [["asleep", 5]]);
  const view = await mount(<StatusPicker ready store={new PresenceStore(d.ask, d.failed)} />);
  d.broken = new Error("\"\" can't be a status");
  await acting(() => { trigger(view.host)?.click(); });
  await type(field(view.host), "z");
  await submit(view.host);
  expect(d.failures).toEqual([d.broken]);
  expect(trigger(view.host)?.textContent).toBe("asleep");
});

test("the statuses are kept between openings of the sidebar, so the row is there at once and while the page is offline", async () => {
  const { StatusPicker, PresenceStore } = await picker();
  const d = daemon(["at work"], [["at work", 5]]);
  const store = new PresenceStore(d.ask, d.failed);
  const first = await mount(<StatusPicker ready store={store} />);
  expect(trigger(first.host)?.textContent).toBe("at work");
  await first.unmount();

  const offline = await mount(<StatusPicker ready={false} store={store} />);
  expect(trigger(offline.host)?.textContent).toBe("at work");
  expect(d.asked).toEqual([{}]);
});

test("the kept statuses tell whoever is listening about each answer from the daemon until they leave", async () => {
  setSystemTime(new Date(NOW));
  const { PresenceStore } = await picker();
  const d = daemon([]);
  const store = new PresenceStore(d.ask, d.failed);
  let heard = 0;
  const leave = store.subscribe(() => { heard += 1; });
  expect(store.getSnapshot()).toBeNull();
  store.load({ on: ["asleep"] });
  await Bun.sleep(1);
  expect([heard, store.getSnapshot()]).toEqual([1, { statuses: [{ status: "asleep", set_at: ago(0) }], history: ["asleep"] }]);
  leave();
  store.load({ clear: true });
  await Bun.sleep(1);
  expect([heard, store.getSnapshot()]).toEqual([1, { statuses: [], history: ["asleep"] }]);
});
