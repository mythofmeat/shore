import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { AutonomyService } from "../src/autonomy/service.ts";
import type { TriggersView, TriggerView } from "../src/autonomy/trigger_loop.ts";
import { parseTriggers } from "../src/autonomy/triggers.ts";
import { status, type StatusContext } from "../src/commands/status.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { testTmp } from "./support/tmp.ts";
import { Texts } from "../src/texts/texts.ts";

const NOW = Date.UTC(2026, 10, 18, 12);
const HOUR = 3_600_000;

async function context(known: boolean, mcpServers?: StatusContext["mcpServers"], state = "Active", view?: TriggersView): Promise<StatusContext> {
  const root = await mkdtemp(testTmp("shore-status-"));
  const autonomy = {
    activityStats: () => known
      ? { stats: { hourHistogram: Array.from({ length: 24 }, () => 0), hourClassifications: [], hasSufficientHeatmap: false, engagementScore: 0.5, sessionsPerDay: 1 }, messageCount: 3 }
      : undefined,
    status: () => known
      ? { character: "ada", state, wakes_without_user: 1, max_idle_wakes: 10, max_silent_ms: 4 * 3_600_000, recent_events: [] }
      : undefined,
    keepaliveHalts: () => [],
    triggers: async () => view,
  } as unknown as AutonomyService;
  return {
    characterName: "ada", turnCount: 2, activeModel: "anthropic:fixture",
    config: { app: { defaults: { model: undefined } }, dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") } },
    conversationTokens: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
    autonomy, diagnostics: new Diagnostics(), now: () => NOW, localNow: () => NOW,
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

test("status leaves out what it doesn't know: no wake runner yet, no activity, no MCP servers", async () => {
  const report = await status(await context(false));
  expect([report.autonomy, report.activity, "mcp" in report, report.sections.includes("mcp"), "triggers" in report, report.sections.includes("triggers")]).toEqual([null, null, false, false, false, false]);
});

test("status reports the wake runner, the activity and the MCP servers it has", async () => {
  const report = await status(await context(true, []));
  expect(report.autonomy).toMatchObject({ state: "Active", wakes_without_user: 1, dormant_after_wakes: 10 });
  expect(report.activity).toMatchObject({ message_count: 3, engagement_score: 0.5, sessions_per_day: 1 });
  expect(report.mcp).toEqual({ configured: 0, connected: 0, unavailable: 0, servers: [] });
  expect(report.sections).toContain("mcp");
});

const FILE = [
  '[tide]\nevery = "10m"\ncheck = "tide.sh"\nwake = false',
  '[lamp]\nevery = "1h"\nreason = "Trim the lamp."',
  '[ferry]\nwhen = "user_quiet"\nafter = "2h"\nreason = "Gone a while."\nthread = "garden"\ncooldown = "0m"',
  '[bell]\nat = "18:00"\nreason = "Ring it."',
  '[gong]\nat = "18:00"\nreason = "Strike it."',
  '[kite]\nevery = "1h"\nreason = "Fly it."',
  '[late]\nat = "Sat 20:00"\nreason = "r"',
  '[broken]\nevery = "1h"',
].join("\n\n");

function triggers(enabled = true): TriggersView {
  const parsed = parseTriggers(new Texts(), FILE, HOUR);
  const next: Record<string, Partial<TriggerView>> = {
    tide: { nextAt: NOW + 10 * 60_000 },
    lamp: { nextAt: NOW + HOUR, fired: 2, lastFiredAt: NOW - HOUR },
    ferry: {},
    bell: { nextAt: NOW + 6 * HOUR },
    gong: { nextAt: NOW + 6 * HOUR },
    kite: { nextAt: NOW + 30 * 60_000, off: true },
    late: { nextAt: NOW + 30 * HOUR },
  };
  return {
    enabled,
    problems: parsed.problems,
    triggers: parsed.triggers.map((trigger) => ({
      trigger, off: false, problem: undefined, fired: 0, lastFiredAt: undefined, checkedAt: undefined, nextAt: undefined, ...next[trigger.name],
    })),
    asked: [],
  };
}

test("status lists the character's triggers as the user reads them, and names the soonest due that wakes it and isn't switched off", async () => {
  const report = await status(await context(true, undefined, "Active", triggers()));
  expect(report.triggers).toEqual({
    enabled: true,
    next_wake: { trigger: "lamp", at: "2026-11-18T13:00:00+00:00" },
    triggers: [
      { name: "tide", does: "every 10m, runs `tide.sh`, never wakes ada", status: "next Wednesday 2026-11-18 · 12:10 PM · never fired · its check hasn't run yet" },
      { name: "lamp", does: 'every 1h, wakes ada, "Trim the lamp.", at most every 1h', status: "next Wednesday 2026-11-18 · 1:00 PM · fired 2 times, last Wednesday 2026-11-18 · 11:00 AM" },
      { name: "ferry", does: 'when you have been quiet for 2h, wakes ada in "garden", "Gone a while."', status: "never fired" },
      { name: "bell", does: 'every day at 18:00, wakes ada, "Ring it.", at most every 1h', status: "next Wednesday 2026-11-18 · 6:00 PM · never fired" },
      { name: "gong", does: 'every day at 18:00, wakes ada, "Strike it.", at most every 1h', status: "next Wednesday 2026-11-18 · 6:00 PM · never fired" },
      { name: "kite", does: 'every 1h, wakes ada, "Fly it.", at most every 1h', status: "next Wednesday 2026-11-18 · 12:30 PM · never fired · switched off by you" },
      { name: "late", does: 'Sat at 20:00, wakes ada, "r", at most every 1h', status: "next Thursday 2026-11-19 · 6:00 PM · never fired" },
    ],
    not_running: ["`broken` isn't running: it needs a `reason` to show you when it fires, or a `check` whose output is the reason"],
    asked: [],
  });
  expect(report.sections).toContain("triggers");

  const later = triggers();
  later.triggers = later.triggers.filter((each) => !["tide", "lamp", "kite"].includes(each.trigger.name));
  expect((await status(await context(true, undefined, "Active", later))).triggers?.next_wake).toEqual({ trigger: "bell", at: "2026-11-18T18:00:00+00:00" });
});

test("status lists the wakes the character asked for that haven't started, and names one as next when it starts before any trigger", async () => {
  const ring = { name: "", from: "main", reason: "Tell part two.", at: NOW - HOUR, thread: "ring", startsAt: NOW + 30 * 60_000 };
  const garden = { name: "", from: "ring", reason: "Water them.", at: NOW - 60_000, thread: "garden" };
  const later = { name: "", from: "main", reason: "Later.", at: NOW - HOUR, thread: "shed", startsAt: NOW + 2 * HOUR };
  const report = async (asked: TriggersView["asked"], state = "Active") => (await status(await context(true, undefined, state, { ...triggers(), asked }))).triggers;

  expect((await report([ring]))?.next_wake).toStrictEqual({ trigger: "", thread: "ring", at: "2026-11-18T12:30:00+00:00" });
  expect((await report([later]))?.next_wake).toStrictEqual({ trigger: "lamp", at: "2026-11-18T13:00:00+00:00" });
  const both = await report([ring, garden]);
  expect(both?.next_wake).toStrictEqual({ trigger: "", thread: "garden", at: "2026-11-18T11:59:00+00:00" });
  expect(both?.asked).toEqual([
    { thread: "ring", does: 'asked for from "main" at Wednesday 2026-11-18 · 11:00 AM: Tell part two.', status: "starts Wednesday 2026-11-18 · 12:30 PM" },
    { thread: "garden", does: 'asked for from "ring" at Wednesday 2026-11-18 · 11:59 AM: Water them.', status: "starts as soon as it can" },
  ]);
  const dormant = await report([ring], "Dormant");
  expect([dormant?.next_wake, dormant?.asked.map((each) => each.thread)]).toEqual([undefined, ["ring"]]);
});

test("status names no trigger as next while triggers are switched off, or the character is dormant or hasn't started, and still lists them", async () => {
  const off = await status(await context(true, undefined, "Active", triggers(false)));
  const dormant = await status(await context(true, undefined, "Dormant", triggers()));
  const unstarted = await status(await context(false, undefined, "Active", triggers()));
  expect([off, dormant, unstarted].map((report) => [report.triggers?.enabled, report.triggers?.next_wake, report.triggers?.triggers.length])).toEqual([
    [false, undefined, 7], [true, undefined, 7], [true, undefined, 7],
  ]);
});
