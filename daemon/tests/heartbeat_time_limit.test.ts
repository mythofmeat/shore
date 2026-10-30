import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HeartbeatEvent } from "../src/autonomy/heartbeat_log.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { Message } from "../src/engine/types.ts";
import { buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { createRuntime } from "../src/runtime.ts";
import { required } from "../src/util/required.ts";
import { eventsForResponse } from "./support/stream.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const KEY_ENV = "SHORE_HEARTBEAT_TIME_LIMIT_KEY";

afterAll(restoreTestEnv);
afterEach(() => { jest.useRealTimers(); });

interface Round {
  minutes: number;
  blocks: GenerateResponse["content_blocks"];
}

type Script = (request: SidecarRequest, heartbeat: number) => Round;

const READ_SOUL: Round["blocks"] = [{ type: "tool_use", id: "read", name: "read", input: { file_path: "SOUL.md" } }];

function textOf(request: SidecarRequest): string {
  return request.messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : [])).join("\n");
}

function instructionsOf(request: SidecarRequest): string {
  const instructions = request.messages.findLast((message) => message.role === "system");
  return instructions?.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") ?? "";
}

function nudged(request: SidecarRequest): boolean {
  return request.messages.at(-1)?.content.some((block) => block.type === "text" && block.text.startsWith("[System nudge")) === true;
}

function slowProvider(script: Script, seen: SidecarRequest[]): SidecarProvider {
  let heartbeats = 0;
  const response = (request: SidecarRequest, blocks: Round["blocks"]): GenerateResponse => ({
    model: request.model,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    content_blocks: blocks,
    finish_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  });
  return {
    generate: async (request) => response(request, [{ type: "text", text: "hello" }]),
    stream: async function* (request, signal) {
      if (request.context?.call_type.startsWith("heartbeat") !== true) {
        yield* eventsForResponse(response(request, [{ type: "text", text: "hello" }]));
        return;
      }
      if (request.context.call_type === "heartbeat") heartbeats += 1;
      seen.push(structuredClone(request));
      const round = script(request, heartbeats);
      jest.advanceTimersByTime(round.minutes * MINUTE);
      signal?.throwIfAborted();
      yield* eventsForResponse(response(request, round.blocks));
    },
  };
}

interface Heartbeats {
  run: () => Promise<void>;
  log: () => HeartbeatEvent[];
  messages: () => Promise<readonly Message[]>;
}

async function afterOneChat(script: Script, seen: SidecarRequest[], heartbeats: (h: Heartbeats) => Promise<void>): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await mkdtemp(testTmp("shore-heartbeat-time-limit-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = ["read", "set_next_wake"];
  app.behavior.autonomy.enabled = true;
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV,
    maxContextTokens: 200_000, maxOutputTokens: 4096,
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  const env = { [KEY_ENV]: "fixture-key" };
  const runtime = await createRuntime({ config, providers: { anthropic: slowProvider(script, seen) }, env });
  try {
    const autonomy = new TurnAutonomyBridge(runtime.autonomy);
    const deps = buildGenerationDeps({
      runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: () => {},
    });
    await runGeneration(deps, {
      meta: {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main" },
        rid: "chat", kind: "message",
      },
      body: { rid: "chat", text: "hello", stream: true, images: [], image_data: [] },
      charName: "ada", regen: false, rid: "chat", signal: new AbortController().signal, send: async () => {},
    });
    await autonomy.settled("ada");
    jest.useFakeTimers();
    await heartbeats({
      run: async () => {
        expect(runtime.autonomy.forceHeartbeatNow("ada")).toBeDefined();
        await runtime.autonomy.tick();
      },
      log: () => runtime.autonomy.log("ada", 100),
      messages: async () => (await runtime.registry.getOrCreate("ada", "main")).messages(),
    });
  } finally {
    jest.useRealTimers();
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
  }
}

test("a heartbeat still busy at 25 minutes is told how long it has left, and its wrap-up runs before the 30-minute limit", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(
    (request) => {
      if (nudged(request)) return { minutes: 0.5, blocks: READ_SOUL };
      if (textOf(request).includes("[System nudge")) {
        return { minutes: 0.5, blocks: [{ type: "text", text: "<sendMessage>I'll finish this next time.</sendMessage>" }] };
      }
      return { minutes: 7, blocks: READ_SOUL };
    },
    seen,
    async ({ run, log, messages }) => {
      await run();
      const nudges = seen.filter(nudged);
      expect(nudges).toHaveLength(1);
      expect(textOf(required(nudges[0]))).toContain("about 2 minutes");
      expect((await messages()).at(-1)?.content).toBe("I'll finish this next time.");
      const kinds = log().map((event) => event.kind);
      expect(kinds).toContain("message_sent");
      expect(kinds).not.toContain("timeout");
      expect(kinds).not.toContain("call_failed");
    },
  );
});

test("a heartbeat stopped at its 30-minute limit is logged as such, and only the next heartbeat is told", async () => {
  const seen: SidecarRequest[] = [];
  await afterOneChat(
    (_request, heartbeat) => heartbeat === 1
      ? { minutes: 7, blocks: READ_SOUL }
      : { minutes: 0, blocks: [{ type: "text", text: "HEARTBEAT_OK" }] },
    seen,
    async ({ run, log, messages }) => {
      await run();
      const stopped = log().filter((event) => event.kind === "timeout");
      expect(stopped).toHaveLength(1);
      expect(stopped[0]?.detail).toContain("30-minute limit");
      expect(log().map((event) => event.kind)).not.toContain("call_failed");
      expect((await messages()).filter((message) => message.origin === "autonomous")).toEqual([]);

      await run();
      await run();
      const opening = seen.filter((request) => request.context?.call_type === "heartbeat");
      expect(opening).toHaveLength(3);
      const told = instructionsOf(required(opening[1]));
      expect(told).toContain("reached its 30-minute limit");
      expect(told).toContain("after 4 rounds");
      expect(told).toContain("Nothing from it was sent");
      expect(instructionsOf(required(opening[2]))).not.toContain("30-minute limit and was stopped");
    },
  );
});
