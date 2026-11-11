import { afterEach, expect, test } from "bun:test";

import type { PresenceArgs } from "../../src/protocol/PresenceArgs.ts";
import type { PresenceResult } from "../../src/protocol/PresenceResult.ts";
import { acting, mount, useDom } from "./dom.ts";

useDom();

afterEach(() => { document.body.replaceChildren(); });

async function picker() { return (await import("../../src/browser/sidebar/StatusPicker.tsx")).StatusPicker; }

interface Daemon {
  asked: PresenceArgs[];
  failures: unknown[];
  held: PresenceResult;
  broken: Error | undefined;
  ask: (args: PresenceArgs) => Promise<PresenceResult>;
  failed: (error: unknown) => void;
}

function daemon(choices: string[], status?: string): Daemon {
  const d: Daemon = {
    asked: [],
    failures: [],
    held: { choices, ...(status === undefined ? {} : { status, set_at: "2026-10-30T12:00:00.000Z" }) },
    broken: undefined,
    ask: async (args) => {
      d.asked.push(args);
      if (d.broken !== undefined) throw d.broken;
      if (typeof args.status === "string") d.held = { choices: d.held.choices, ...(args.status === "" ? {} : { status: args.status, set_at: "2026-10-30T13:00:00.000Z" }) };
      return d.held;
    },
    failed: (error) => { d.failures.push(error); },
  };
  return d;
}

const trigger = (root: ParentNode) => root.querySelector("button");
const offered = (root: ParentNode) => [...root.querySelectorAll("[role=menuitem]")].map((item) => [item.querySelector(".menu-label")?.textContent, item.querySelector(".menu-detail")?.textContent ?? null]);
async function choose(root: ParentNode, label: string): Promise<void> {
  await acting(() => { trigger(root)?.click(); });
  const item = [...root.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((each) => each.querySelector(".menu-label")?.textContent === label);
  if (item === undefined) throw new Error(`no status ${label}`);
  await acting(() => { item.click(); });
}

test("the picker asks for the status once the page is connected, and offers the user's statuses from a chip that names the one set", async () => {
  const StatusPicker = await picker();
  const d = daemon(["asleep", "at work"]);
  const view = await mount(<StatusPicker ready={false} ask={d.ask} failed={d.failed} />);
  expect(d.asked).toEqual([]);
  expect(view.host.innerHTML).toBe("");

  await view.update(<StatusPicker ready ask={d.ask} failed={d.failed} />);
  expect(d.asked).toEqual([{}]);
  const chip = trigger(view.host);
  expect([chip?.textContent, chip?.className, chip?.getAttribute("aria-label"), chip?.querySelector(".status-chip") !== null]).toEqual(["Set status", "chip", "Your status", true]);
  await acting(() => { chip?.click(); });
  expect(view.host.querySelector("[role=menu]")?.className).toBe("menu-list align-start above");
  expect(view.host.querySelector("[role=menu]")?.getAttribute("aria-label")).toBe("Your status");
  expect(offered(view.host)).toEqual([["asleep", null], ["at work", null]]);
  expect(view.host.querySelector("[role=separator]")).toBeNull();
});

test("choosing a status sets it, marks it in the list and offers to clear it, and clearing goes back to none", async () => {
  const StatusPicker = await picker();
  const d = daemon(["asleep", "at work"]);
  const view = await mount(<StatusPicker ready ask={d.ask} failed={d.failed} />);
  await choose(view.host, "at work");
  expect(d.asked).toEqual([{}, { status: "at work" }]);
  expect(trigger(view.host)?.textContent).toBe("at work");
  await acting(() => { trigger(view.host)?.click(); });
  expect(offered(view.host)).toEqual([["asleep", null], ["at work", "Set"], ["Clear status", null]]);
  expect(view.host.querySelectorAll("[role=separator]")).toHaveLength(1);
  await acting(() => { trigger(view.host)?.click(); });

  await choose(view.host, "Clear status");
  expect(d.asked.at(-1)).toEqual({ status: "" });
  expect(trigger(view.host)?.textContent).toBe("Set status");
  expect(d.failures).toEqual([]);
});

test("with no statuses to offer and none set there is no picker, but a status set elsewhere still shows and can be cleared", async () => {
  const StatusPicker = await picker();
  const none = daemon([]);
  const empty = await mount(<StatusPicker ready ask={none.ask} failed={none.failed} />);
  expect(none.asked).toEqual([{}]);
  expect(empty.host.innerHTML).toBe("");

  const set = daemon([], "on the train");
  const view = await mount(<StatusPicker ready ask={set.ask} failed={set.failed} />);
  expect(trigger(view.host)?.textContent).toBe("on the train");
  await acting(() => { trigger(view.host)?.click(); });
  expect(offered(view.host)).toEqual([["Clear status", null]]);
});

test("the picker asks again when the window gets focus, so a status set from another client shows, and stops once it is gone", async () => {
  const StatusPicker = await picker();
  const d = daemon(["asleep"]);
  const view = await mount(<StatusPicker ready ask={d.ask} failed={d.failed} />);
  d.held = { choices: ["asleep"], status: "asleep", set_at: "2026-10-30T12:30:00.000Z" };
  await acting(() => { window.dispatchEvent(new Event("focus")); });
  expect(d.asked).toEqual([{}, {}]);
  expect(trigger(view.host)?.textContent).toBe("asleep");

  await view.update(<StatusPicker ready={false} ask={d.ask} failed={d.failed} />);
  await acting(() => { window.dispatchEvent(new Event("focus")); });
  expect(d.asked).toHaveLength(2);
  await view.unmount();
  await acting(() => { window.dispatchEvent(new Event("focus")); });
  expect(d.asked).toHaveLength(2);
});

test("a status the daemon refuses is reported and the picker keeps showing what it had", async () => {
  const StatusPicker = await picker();
  const d = daemon(["asleep", "at work"], "asleep");
  const view = await mount(<StatusPicker ready ask={d.ask} failed={d.failed} />);
  d.broken = new Error("\"at work\" isn't one of your statuses");
  await choose(view.host, "at work");
  expect(d.failures).toEqual([d.broken]);
  expect(trigger(view.host)?.textContent).toBe("asleep");
});
