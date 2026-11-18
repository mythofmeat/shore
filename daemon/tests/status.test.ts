import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { AutonomyService } from "../src/autonomy/service.ts";
import { status, type StatusContext } from "../src/commands/status.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = Date.UTC(2026, 10, 18, 12);

async function context(known: boolean, mcpServers?: StatusContext["mcpServers"]): Promise<StatusContext> {
  const root = await mkdtemp(testTmp("shore-status-"));
  const autonomy = {
    activityStats: () => known
      ? { stats: { hourHistogram: Array.from({ length: 24 }, () => 0), hourClassifications: [], hasSufficientHeatmap: false, engagementScore: 0.5, sessionsPerDay: 1 }, messageCount: 3 }
      : undefined,
    status: () => known
      ? { character: "ada", state: "Active", wakes_without_user: 1, max_idle_wakes: 10, max_silent_ms: 4 * 3_600_000, recent_events: [] }
      : undefined,
    keepaliveHalts: () => [],
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
  expect([report.autonomy, report.activity, "mcp" in report, report.sections.includes("mcp")]).toEqual([null, null, false, false]);
});

test("status reports the wake runner, the activity and the MCP servers it has", async () => {
  const report = await status(await context(true, []));
  expect(report.autonomy).toMatchObject({ state: "Active", wakes_without_user: 1, dormant_after_wakes: 10 });
  expect(report.activity).toMatchObject({ message_count: 3, engagement_score: 0.5, sessions_per_day: 1 });
  expect(report.mcp).toEqual({ configured: 0, connected: 0, unavailable: 0, servers: [] });
  expect(report.sections).toContain("mcp");
});
