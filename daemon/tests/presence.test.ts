import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { lastSeen, noteSeen, presence, setPresence, unshownPresence } from "../src/autonomy/presence.ts";
import { loadConfig } from "../src/config/loader.ts";
import { configSchema } from "../src/config/schema.ts";
import { rejectionOf } from "./support/outcome.ts";
import { assemblePrompt, DIARY_FOR_CHAT, diaryText, heartbeatRunningText, presenceText } from "../src/engine/prompt.ts";
import type { Message } from "../src/engine/types.ts";
import { writeState } from "../src/storage/store.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 9, 30, 12);
const AT = "2026-10-30T12:00:00.000Z";

async function data(): Promise<string> {
  return await mkdtemp(testTmp("shore-presence-"));
}

test("a status is kept as written, without the space around it, with when it was set, until another replaces it", async () => {
  const dir = await data();
  expect(presence(dir)).toBeUndefined();
  expect(setPresence(dir, "  asleep ", T0)).toEqual({ status: "asleep", set_at: AT });
  expect(presence(dir)).toEqual({ status: "asleep", set_at: AT });
  expect(setPresence(dir, "", T0 + HOUR)).toEqual({ status: "", set_at: "2026-10-30T13:00:00.000Z" });
  expect(presence(dir)).toEqual({ status: "", set_at: "2026-10-30T13:00:00.000Z" });
});

test("the statuses the user can set are a list in their config, each 1 to 80 characters, with no repeats", async () => {
  const root = await mkdtemp(testTmp("shore-presence-config-"));
  const read = async (toml: string): Promise<string[]> => {
    await Bun.write(join(root, "config.toml"), toml);
    return loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} }).app.behavior.presence.statuses;
  };
  expect(await read('[chat]\ndisplay_name = "eve"\n')).toEqual(["asleep", "busy", "away"]);
  expect(await read(`[presence]\nstatuses = ["at work", "${"🕯".repeat(80)}"]\n`)).toEqual(["at work", "🕯".repeat(80)]);
  expect(await read("[presence]\nstatuses = []\n")).toEqual([]);

  const refused = async (toml: string): Promise<string> => String(await rejectionOf(read(toml)));
  const shape = "a status is 1 to 80 characters with no space at either end";
  expect(await refused('[presence]\nstatuses = ["asleep", ""]\n')).toContain(`presence.statuses has ""; ${shape}`);
  expect(await refused('[presence]\nstatuses = [" asleep"]\n')).toContain(`presence.statuses has " asleep"; ${shape}`);
  expect(await refused(`[presence]\nstatuses = ["${"z".repeat(81)}"]\n`)).toContain(`presence.statuses has "${"z".repeat(81)}"; ${shape}`);
  expect(await refused('[presence]\nstatuses = ["asleep", "busy", "asleep"]\n')).toContain('presence.statuses lists "asleep" twice');

  const described = configSchema({ instancesAt: () => [] }).find((entry) => entry.key === "presence.statuses")?.description ?? "";
  expect(described).toStartWith("The statuses you can set for yourself with shore presence");
});

test("a stored status or last-seen time that can't be read counts as none", async () => {
  const dir = await data();
  for (const state of ["{not json", "null", "[]", JSON.stringify({ status: 5, set_at: AT }), JSON.stringify({ status: "asleep" }), JSON.stringify({ status: "asleep", set_at: "last Tuesday" }), JSON.stringify({ status: "asleep", set_at: T0 })]) {
    writeState(dir, "presence.json", state);
    expect(presence(dir), state).toBeUndefined();
  }
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

test("a conversation is shown a status once: when it is new to it, and a cleared one only if it had been shown one", () => {
  const asleep = { status: "asleep", set_at: AT };
  const cleared = { status: "", set_at: "2026-10-30T13:00:00.000Z" };
  expect(unshownPresence(undefined, [{}])).toBeUndefined();
  expect(unshownPresence(asleep, [])).toEqual(asleep);
  expect(unshownPresence(asleep, [{}, { presence: { status: "busy", set_at: "2026-10-30T09:00:00.000Z" } }])).toEqual(asleep);
  expect(unshownPresence(asleep, [{}, { presence: asleep }])).toBeUndefined();
  expect(unshownPresence(cleared, [{}, {}])).toBeUndefined();
  expect(unshownPresence(cleared, [])).toBeUndefined();
  expect(unshownPresence(cleared, [{ presence: asleep }, {}])).toEqual(cleared);
  expect(unshownPresence(cleared, [{ presence: asleep }, { presence: cleared }])).toBeUndefined();
});

test("a status is told with how long ago it was set, and a cleared one with how long ago it was cleared", () => {
  const asleep = { status: "asleep", set_at: AT };
  expect(presenceText(asleep, T0 + 3 * HOUR, "Their")).toBe('[Their status, set 3 hours ago: "asleep"]');
  expect(presenceText(asleep, T0 + 10 * MINUTE, "eve's")).toBe('[eve\'s status, set 10 minutes ago: "asleep"]');
  expect(presenceText(asleep, T0 - HOUR, "Their")).toBe('[Their status, set a minute ago: "asleep"]');
  expect(presenceText({ status: "", set_at: AT }, T0 + 2 * 24 * HOUR, "Their")).toBe("[Their status was cleared 2 days ago.]");
});

function said(id: string, text: string, at: number, extra: Partial<Message> = {}): Message {
  return { msg_id: id, role: "user", content: text, images: [], content_blocks: [{ type: "text", text }], alternatives: [], timestamp: new Date(at).toISOString(), ...extra };
}

test("a message that arrived with a new status says so right above what the user wrote, after the diary and a running heartbeat", () => {
  const asleep = { status: "asleep", set_at: AT };
  const left = [{ id: "d1", at: AT, thread: "heartbeat", source: "heartbeat" as const, text: "The lamp is lit." }];
  const heartbeat = { started_at: new Date(T0 + HOUR).toISOString() };
  const prompt = assemblePrompt({
    character_name: "ada", display_name: "eve", has_prior_context: false, user_timestamp_mode: "never",
    messages: [
      said("m1", "good morning", T0 + HOUR, { presence: asleep }),
      said("m2", "still there?", T0 + 2 * HOUR, { presence: { status: "", set_at: new Date(T0 + 90 * MINUTE).toISOString() }, diary: left, heartbeat_running: heartbeat }),
      { ...said("m3", "and now", T0 + 2 * HOUR, { presence: asleep }), timestamp: "sometime" },
    ],
  }, "UTC");

  expect(prompt.messages.map((message) => message.content_blocks.map((block) => block.type === "text" ? block.text : ""))).toEqual([
    ['[Their status, set about an hour ago: "asleep"]', "good morning"],
    [diaryText(left, DIARY_FOR_CHAT, "UTC"), heartbeatRunningText(heartbeat, "UTC"), "[Their status was cleared 30 minutes ago.]", "still there?"],
    ["and now"],
  ]);
  expect(prompt.messages[0]?.content).toBe('[Their status, set about an hour ago: "asleep"]\n\ngood morning');
});
