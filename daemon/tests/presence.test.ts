import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";

import { changePresence, lastSeen, noteSeen, presence, presenceState, unshownPresence, type Presence } from "../src/autonomy/presence.ts";
import { presenceCommand } from "../src/commands/presence.ts";
import { assemblePrompt, presenceText, wakeRunningText } from "../src/engine/prompt.ts";
import type { Message } from "../src/engine/types.ts";
import { readState, writeState } from "../src/storage/store.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 9, 30, 12);
const AT = "2026-10-30T12:00:00.000Z";
const iso = (at: number): string => new Date(at).toISOString();

afterEach(() => { setSystemTime(); });

async function data(): Promise<string> {
  return await mkdtemp(testTmp("shore-presence-"));
}

test("statuses go on and off one at a time or several together, and each keeps the time it went on", async () => {
  const dir = await data();
  expect(presenceState(dir)).toEqual({ presence: undefined, history: [] });
  expect(changePresence(dir, { on: ["home"] }, T0)).toEqual({ presence: { statuses: [{ status: "home", set_at: AT }], changed_at: AT }, history: ["home"], changed: true });
  changePresence(dir, { on: ["on the couch", "not feeling great"] }, T0 + HOUR);

  const swapped = changePresence(dir, { on: ["in bed"], off: ["on the couch"] }, T0 + 2 * HOUR);
  const now = { statuses: [{ status: "home", set_at: AT }, { status: "not feeling great", set_at: iso(T0 + HOUR) }, { status: "in bed", set_at: iso(T0 + 2 * HOUR) }], changed_at: iso(T0 + 2 * HOUR) };
  expect(swapped).toMatchObject({ presence: now, changed: true });
  expect(presence(dir)).toEqual(now);

  const off = changePresence(dir, { off: ["home"] }, T0 + 3 * HOUR);
  expect(off.changed).toBe(true);
  expect(off.presence?.statuses.map((status) => status.status)).toEqual(["not feeling great", "in bed"]);
});

test("a status turned on that is already on keeps its time, and one turned off that isn't on changes nothing", async () => {
  const dir = await data();
  changePresence(dir, { on: ["home"] }, T0);
  const again = changePresence(dir, { on: ["home", "home"], off: ["out"] }, T0 + HOUR);
  expect(again).toEqual({ presence: { statuses: [{ status: "home", set_at: AT }], changed_at: AT }, history: ["home"], changed: false });
  expect(changePresence(dir, { on: ["sick", "sick"] }, T0 + HOUR).presence?.statuses).toEqual([{ status: "home", set_at: AT }, { status: "sick", set_at: iso(T0 + HOUR) }]);
});

test("clearing turns every status off but any turned on with it, which keeps its time if it was on", async () => {
  const dir = await data();
  changePresence(dir, { on: ["home", "sick"] }, T0);
  const cleared = changePresence(dir, { clear: true, on: ["sick", "in bed"] }, T0 + HOUR);
  expect(cleared).toMatchObject({ presence: { statuses: [{ status: "sick", set_at: AT }, { status: "in bed", set_at: iso(T0 + HOUR) }], changed_at: iso(T0 + HOUR) }, changed: true });

  const none = changePresence(dir, { clear: true }, T0 + 2 * HOUR);
  expect(none).toMatchObject({ presence: { statuses: [], changed_at: iso(T0 + 2 * HOUR) }, changed: true });
  expect(changePresence(dir, { clear: true }, T0 + 3 * HOUR)).toMatchObject({ presence: { statuses: [], changed_at: iso(T0 + 2 * HOUR) }, changed: false });
});

test("each status turned on goes to the front of the history, which keeps it after it goes off, until it is forgotten", async () => {
  const dir = await data();
  changePresence(dir, { on: ["home"] }, T0);
  changePresence(dir, { on: ["sick", "in bed"] }, T0);
  expect(presenceState(dir).history).toEqual(["sick", "in bed", "home"]);
  changePresence(dir, { off: ["sick"] }, T0);
  expect(presenceState(dir).history).toEqual(["sick", "in bed", "home"]);
  changePresence(dir, { on: ["home"] }, T0);
  expect(presenceState(dir).history).toEqual(["home", "sick", "in bed"]);

  expect(changePresence(dir, { forget: ["sick", "never used"] }, T0 + HOUR)).toMatchObject({ history: ["home", "in bed"], changed: false });
  const forgotten = changePresence(dir, { forget: ["home"] }, T0 + HOUR);
  expect(forgotten).toMatchObject({ history: ["in bed"], changed: false });
  expect(forgotten.presence?.statuses.map((status) => status.status)).toEqual(["home", "in bed"]);
});

test("stored statuses or a last-seen time that can't be read count as none, and an unreadable entry drops only itself", async () => {
  const dir = await data();
  for (const state of ["{not json", "null", "[]", JSON.stringify({ status: "asleep", set_at: AT })]) {
    writeState(dir, "presence.json", state);
    expect(presenceState(dir), state).toEqual({ presence: undefined, history: [] });
  }
  writeState(dir, "presence.json", JSON.stringify({ statuses: [{ status: "home", set_at: AT }], changed_at: "then", history: ["home"] }));
  expect(presenceState(dir)).toEqual({ presence: undefined, history: ["home"] });
  writeState(dir, "presence.json", JSON.stringify({ statuses: "home", changed_at: AT, history: "home" }));
  expect(presenceState(dir)).toEqual({ presence: { statuses: [], changed_at: AT }, history: [] });
  writeState(dir, "presence.json", JSON.stringify({
    statuses: [null, 5, { status: 5, set_at: AT }, { status: "a" }, { status: "b", set_at: "then" }, { status: "c", set_at: T0 }, { status: "d", set_at: AT }],
    changed_at: AT,
    history: ["d", 5, null],
  }));
  expect(presenceState(dir)).toEqual({ presence: { statuses: [{ status: "d", set_at: AT }], changed_at: AT }, history: ["d"] });

  for (const state of ["{not json", "null", JSON.stringify({ at: T0 }), JSON.stringify({ at: "then" }), "{}"]) {
    writeState(dir, "last_seen.json", state);
    expect(lastSeen(dir), state).toBeUndefined();
  }
});

test("the time the user was last seen is the latest one noted", async () => {
  const dir = await data();
  expect(lastSeen(dir)).toBeUndefined();
  noteSeen(dir, T0);
  expect(lastSeen(dir)).toBe(T0);
  noteSeen(dir, T0 + HOUR);
  expect(lastSeen(dir)).toBe(T0 + HOUR);
});

test("the presence command turns statuses on and off by their trimmed names, shows them with the history, and tells of each change", async () => {
  const dir = await data();
  let told = 0;
  const ctx = { dataDir: dir, changed: async () => { told += 1; } };
  expect(await presenceCommand(ctx, {})).toEqual({ statuses: [], history: [] });
  expect(readState(dir, "presence.json")).toBeUndefined();

  setSystemTime(new Date(T0));
  expect(await presenceCommand(ctx, { on: ["  home ", "sick"] })).toEqual({ statuses: [{ status: "home", set_at: AT }, { status: "sick", set_at: AT }], history: ["home", "sick"] });
  expect(told).toBe(1);
  setSystemTime(new Date(T0 + HOUR));
  expect(await presenceCommand(ctx, { off: [" sick"], forget: [" sick "] })).toEqual({ statuses: [{ status: "home", set_at: AT }], history: ["home"] });
  expect(told).toBe(2);
  expect(await presenceCommand(ctx, { forget: ["home"] })).toEqual({ statuses: [{ status: "home", set_at: AT }], history: [] });
  expect(await presenceCommand(ctx, { on: ["home"] })).toEqual({ statuses: [{ status: "home", set_at: AT }], history: ["home"] });
  expect(told).toBe(2);
  expect(await presenceCommand(ctx, { clear: true })).toEqual({ statuses: [], history: ["home"] });
  expect(told).toBe(3);
  await presenceCommand(ctx, { clear: true });
  expect(told).toBe(3);

  expect(await presenceCommand({ dataDir: dir }, { on: ["🕯".repeat(80)] })).toEqual({ statuses: [{ status: "🕯".repeat(80), set_at: iso(T0 + HOUR) }], history: ["🕯".repeat(80), "home"] });
});

test("the presence command refuses a status that is empty, too long or more than one line, and one turned on and off at once, and changes nothing", async () => {
  const dir = await data();
  const ctx = { dataDir: dir, changed: async () => { throw new Error("nothing changed"); } };
  const shape = "can't be a status: a status is 1 to 80 characters, on one line";
  const refusals: [{ on: string[]; off?: string[] }, string][] = [
    [{ on: ["home", " "] }, `"" ${shape}`],
    [{ on: ["z".repeat(81)] }, `"${"z".repeat(81)}" ${shape}`],
    [{ on: ["two\nlines"] }, `"two\\nlines" ${shape}`],
    [{ on: ["tab\there"] }, `"tab\\there" ${shape}`],
    [{ on: ["home", " in bed"], off: ["in bed "] }, `"in bed" can't be turned on and off at once`],
  ];
  for (const [args, refusal] of refusals) {
    expect(String(await rejectionOf(presenceCommand(ctx, args)))).toContain(refusal);
  }
  expect(presenceState(dir)).toEqual({ presence: undefined, history: [] });
});

const status = (name: string, at: number) => ({ status: name, set_at: iso(at) });

test("a conversation is shown the statuses whenever they differ from the last it was shown, and a clearing only if it had been shown some", () => {
  const home: Presence = { statuses: [status("home", T0)], changed_at: AT };
  const both: Presence = { statuses: [status("home", T0), status("sick", T0 + HOUR)], changed_at: iso(T0 + HOUR) };
  const out: Presence = { statuses: [status("out", T0)], changed_at: AT };
  const again: Presence = { statuses: [status("home", T0 + 2 * HOUR)], changed_at: iso(T0 + 2 * HOUR) };
  const cleared: Presence = { statuses: [], changed_at: iso(T0 + 3 * HOUR) };
  expect(unshownPresence(undefined, [{}])).toBeUndefined();
  expect(unshownPresence(home, [])).toEqual(home);
  expect(unshownPresence(home, [{ presence: home }, {}])).toBeUndefined();
  expect(unshownPresence(both, [{ presence: home }, {}])).toEqual(both);
  expect(unshownPresence(home, [{ presence: home }, { presence: both }])).toEqual(home);
  expect(unshownPresence(home, [{ presence: both }, { presence: home }])).toBeUndefined();
  expect(unshownPresence(out, [{ presence: home }])).toEqual(out);
  expect(unshownPresence(again, [{ presence: home }])).toEqual(again);
  expect(unshownPresence(cleared, [{}, {}])).toBeUndefined();
  expect(unshownPresence(cleared, [])).toBeUndefined();
  expect(unshownPresence(cleared, [{ presence: home }, {}])).toEqual(cleared);
  expect(unshownPresence(cleared, [{ presence: home }, { presence: { statuses: [], changed_at: iso(T0 + HOUR) } }])).toBeUndefined();
});

test("statuses are told oldest first, each with how long it has been on, and a clearing with how long ago it was", () => {
  const at = T0 + 3 * 24 * HOUR;
  const statuses = [
    status("home", at - 129_600_000), status("not feeling great", at - 64_800_000), status("on the couch", at - 5_400_000),
    status("in bed", at - HOUR), status("reading", at - 10 * MINUTE), status("tea", at - MINUTE), status("just now", at), status("soon", at + HOUR),
  ];
  expect(presenceText({ statuses, changed_at: iso(at) }, at, "Their")).toBe(
    '[Their status: "home" for 2 days, "not feeling great" for about a day, "on the couch" for 2 hours, "in bed" for about an hour, "reading" for 10 minutes, "tea" for a minute, "just now" for a minute, "soon" for a minute]',
  );
  expect(presenceText({ statuses: [status("home", T0), status("sick", T0 + 5 * HOUR)], changed_at: AT }, T0 + 7 * HOUR, "eve's")).toBe('[eve\'s status: "home" for 7 hours, "sick" for 2 hours]');
  expect(presenceText({ statuses: [], changed_at: AT }, T0 + 2 * 24 * HOUR, "Their")).toBe("[Their status was cleared 2 days ago.]");
  expect(presenceText({ statuses: [], changed_at: AT }, T0 + 30 * MINUTE, "Their")).toBe("[Their status was cleared 30 minutes ago.]");
});

function said(id: string, text: string, at: number, extra: Partial<Message> = {}): Message {
  return { msg_id: id, role: "user", content: text, images: [], content_blocks: [{ type: "text", text }], alternatives: [], timestamp: iso(at), ...extra };
}

test("a message that arrived with changed statuses says so right above what the user wrote, after a running wake", () => {
  const home: Presence = { statuses: [status("home", T0)], changed_at: AT };
  const running = { started_at: iso(T0 + HOUR) };
  const prompt = assemblePrompt({
    character_name: "ada", display_name: "eve", has_prior_context: false, user_timestamp_mode: "never", sections: [],
    messages: [
      said("m1", "good morning", T0 + HOUR, { presence: home }),
      said("m2", "still there?", T0 + 2 * HOUR, { presence: { statuses: [], changed_at: iso(T0 + 90 * MINUTE) }, wake_running: running }),
      { ...said("m3", "and now", T0 + 2 * HOUR, { presence: home }), timestamp: "sometime" },
    ],
  }, "UTC");

  expect(prompt.messages.map((message) => message.content_blocks.map((block) => block.type === "text" ? block.text : ""))).toEqual([
    ['[Their status: "home" for about an hour]', "good morning"],
    [wakeRunningText(running, "UTC"), "[Their status was cleared 30 minutes ago.]", "still there?"],
    ["and now"],
  ]);
  expect(prompt.messages[0]?.content).toBe('[Their status: "home" for about an hour]\n\ngood morning');
});
