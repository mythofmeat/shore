import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localWallClock } from "../src/autonomy/activity.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { Message } from "../src/engine/types.ts";
import { ensureAndBackfillAutonomy } from "../src/handler/turn.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { createRuntime } from "../src/runtime.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { eventsForResponse } from "./support/stream.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(restoreTestEnv);

const KEY_ENV = "SHORE_ACTIVITY_TEST_KEY";
setTestEnv(KEY_ENV, "fixture-key");
const DAY = 86_400_000;

function message(role: "user" | "assistant", id: string, at: number): Message {
  return {
    msg_id: id,
    role,
    content: "hello",
    content_blocks: [{ type: "text", text: "hello" }],
    images: [],
    alternatives: [],
    timestamp: new Date(at).toISOString(),
  };
}

function heatmapProvider(seen: SidecarRequest[]): SidecarProvider {
  const reply = (request: SidecarRequest): GenerateResponse => {
    seen.push(structuredClone(request));
    const last = request.messages.at(-1)?.content;
    const completed = Array.isArray(last) && last.some((block) => block.type === "tool_result");
    const blocks: GenerateResponse["content_blocks"] = completed
      ? [{ type: "text", text: "HEARTBEAT_OK" }]
      : [1, 7, 30].map((days) => ({
          type: "tool_use", id: `heatmap_${days}`, name: "activity_heatmap", input: { days },
        }));
    return {
      content: completed ? "HEARTBEAT_OK" : "",
      content_blocks: blocks,
      finish_reason: completed ? "end_turn" : "tool_use",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
      model: request.model,
    };
  };
  return { generate: async (request) => reply(request), stream: (request) => eventsForResponse(reply(request)) };
}

test("heartbeat heatmaps use persisted and live user activity for the requested character and window", async () => {
  const root = await mkdtemp(testTmp("shore-runtime-activity-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = ["activity_heatmap"];
  app.behavior.autonomy.enabled = true;
  app.behavior.autonomy.heartbeat.enabled = true;
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV,
    maxContextTokens: 200_000, maxOutputTokens: 4096, maxToolIterations: 3,
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const now = Date.now();
  const histories = { ada: [40, 10, 3, 0.5], bo: [0.25], empty: [] };
  for (const character of Object.keys(histories)) {
    const workspace = join(config.dirs.config, "characters", character, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), `# ${character}`);
  }
  const seen: SidecarRequest[] = [];
  const options = { config, providers: { anthropic: heatmapProvider(seen) } };
  let runtime = await createRuntime(options);
  try {
    for (const [character, days] of Object.entries(histories)) {
      const engine = await runtime.registry.getOrCreate(character);
      for (const age of days) {
        await engine.appendMessage(message("user", `user_${age}`, now - age * DAY));
        await engine.appendMessage(message("assistant", `reply_${age}`, now - age * DAY + 1000));
      }
      if (days.length === 0) await engine.appendMessage(message("assistant", "hello", now - 1000));
    }
    await runtime.shutdown();
    runtime = await createRuntime(options);
    const bridge = new TurnAutonomyBridge(runtime.autonomy);
    for (const character of Object.keys(histories)) {
      const engine = await runtime.registry.getOrCreate(character);
      await ensureAndBackfillAutonomy({ autonomy: bridge }, engine, character, config);
      await bridge.settled(character);
    }

    expect(runtime.autonomy.activityStats("ada", localWallClock(now))?.messageCount).toBe(4);
    expect(runtime.autonomy.activityStats("bo", localWallClock(now))?.messageCount).toBe(1);

    for (const character of Object.keys(histories)) {
      runtime.autonomy.forceHeartbeatNow(character);
      await runtime.autonomy.tick();
      const calls = seen.filter((request) => request.context?.character === character);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.tools?.some((tool) => tool.name === "activity_heatmap")).toBe(true);
      const results = calls[1]?.messages.flatMap((entry) => typeof entry.content === "string" ? [] : entry.content)
        .filter((block) => block.type === "tool_result") ?? [];
      expect(results).toHaveLength(3);
      for (const [i, days] of [1, 7, 30].entries()) {
        const report = runtime.autonomy.activityStats(character, localWallClock(now), days);
        expect(report).toBeDefined();
        const result = results[i];
        expect(result?.is_error).not.toBe(true);
        expect(result?.content).toContain(`${report?.stats.windowMessageCount} messages (${report?.messageCount} total)`);
      }
    }

    seen.length = 0;
    const engine = await runtime.registry.getOrCreate("ada");
    await engine.appendMessage(message("user", "live_user", now));
    bridge.onUserMessage("ada", engine.turnCount());
    await bridge.settled("ada");
    await engine.appendMessage(message("assistant", "live_reply", now + 1000));
    runtime.autonomy.forceHeartbeatNow("ada");
    await runtime.autonomy.tick();
    expect(JSON.stringify(seen.at(-1))).toContain("2 messages (5 total)");
  } finally {
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
