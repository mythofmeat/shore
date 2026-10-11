import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { toolGeneration } from "./support/tool_generation.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Message } from "../src/engine/types.ts";
import type { GenerateResponse } from "../src/llm/types.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { runIdleCompaction, type IdleCompactionDeps } from "../src/autonomy/idle_compaction.ts";
import { runCompaction, runCompactionPass, type CompactionRunDeps } from "../src/memory/compaction/run.ts";
import { CompactionPaused } from "../src/memory/compaction/types.ts";
import { loadCompactionCheckpoint } from "../src/memory/compaction/checkpoint.ts";
import { withConversation } from "../src/engine/lifecycle.ts";
import { threadDataDir } from "../src/config/dirs.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { testTmp } from "./support/tmp.ts";
import { setTestEnv, unsetTestEnv } from "./support/env.ts";
import { NO_MCP } from "./support/rebuild.ts";

const FIXTURE_MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_FIXTURE_API_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  maxToolIterations: 4,
} as never;

type Generate = (request: { messages?: unknown[] }) => Promise<GenerateResponse>;

function message(role: "user" | "assistant", id: string, text: string): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp: "2026-01-01T10:00:00-05:00",
  };
}

async function world(): Promise<{ config: LoadedConfig; dataDir: string; characterDir: string }> {
  const root = await mkdtemp(testTmp("shore-refusal-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  await mkdir(join(dirs.config, "characters", "ada", "workspace", "memory"), { recursive: true });

  const characterDir = join(dirs.data, "ada");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const messages = [
    message("user", "m_1", "morning"),
    message("assistant", "m_2", "morning to you"),
    message("user", "m_3", "tell me about boats"),
    message("assistant", "m_4", "they float"),
  ];
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.memory.compaction.keep_recent_turns = 0;
  app.tools.enabled_tools = ["bash"];
  const models = emptyCatalog();
  models.chat.set("chat.fixture", FIXTURE_MODEL);

  return {
    dataDir: dirs.data,
    characterDir,
    config: { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

function turn(finishReason: string, blocks: GenerateResponse["content_blocks"]): GenerateResponse {
  return {
    content: blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    content_blocks: blocks,
    finish_reason: finishReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    model: "claude-fixture",
  };
}

const WRITE_BOATS = turn("tool_use", [
  { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "mkdir -p memory && echo '- a thing that floats' > memory/boats.md" } },
]);
const REFUSED = turn("refusal", [{ type: "text", text: "I can't continue with this." }]);
const DONE = turn("end_turn", [{ type: "text", text: "done" }]);

function scripted(turns: GenerateResponse[], seen: unknown[][] = []): Generate & { calls: () => number } {
  let next = 0;
  const generate = async (request: { messages?: unknown[] }) => {
    seen.push(structuredClone(request.messages ?? []));
    const reply = turns[next++];
    if (reply === undefined) throw new Error("script exhausted");
    return reply;
  };
  return Object.assign(generate, { calls: () => next });
}

function runDeps(config: LoadedConfig, generate: Generate, notices: string[] = []): CompactionRunDeps {
  return {
    config,
    notify: (_title: string, body: string) => notices.push(body),
    generate: (request, _model, _character, _sink, tools, options) =>
      tools === undefined
        ? generate(request)
        : toolGeneration(async (call) => generate(call))(request, tools, undefined, options),
  };
}

function idleDeps(config: LoadedConfig, generate: Generate, notices: string[] = []): IdleCompactionDeps {
  const { config: _config, ...run } = runDeps(config, generate, notices);
  return { rebuild: NO_MCP, config, cache: new LastRequestCache(), run };
}

function withKey<T>(fn: () => Promise<T>): Promise<T> {
  setTestEnv("SHORE_FIXTURE_API_KEY", "sk-fixture");
  return fn().finally(() => {
    unsetTestEnv("SHORE_FIXTURE_API_KEY");
  });
}

function segments(dataDir: string): number {
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    return store.segmentCount("ada");
  } finally {
    store.close();
  }
}

async function refuseOnce(config: LoadedConfig, seen: unknown[][] = [], notices: string[] = []) {
  return await withKey(() => runIdleCompaction("ada", idleDeps(config, scripted([WRITE_BOATS, REFUSED], seen), notices)));
}

describe("a refused compaction", () => {
  test("pauses without archiving and without keeping the refused turn", async () => {
    const { config, dataDir, characterDir } = await world();
    const notices: string[] = [];
    const before = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");

    const result = await refuseOnce(config, [], notices);

    expect(result.failed).toContain("the model refused round 2");
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(before);
    expect(segments(dataDir)).toBe(0);
    const checkpoint = await loadCompactionCheckpoint(dataDir, "ada", "main");
    expect(checkpoint).toMatchObject({ state: "paused", pauseReason: "refusal" });
    expect(checkpoint?.loop.toolRounds).toBe(1);
    expect(checkpoint?.loop.pendingTurn).toBeUndefined();
    expect(JSON.stringify(checkpoint?.request.messages)).not.toContain("I can't continue");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Automatic compaction is on hold");
  });

  test("holds the idle timer and chat turns without calling the model again", async () => {
    const { config, dataDir } = await world();
    await refuseOnce(config);

    const idle = scripted([DONE]);
    const notices: string[] = [];
    const idleResult = await withKey(() => runIdleCompaction("ada", idleDeps(config, idle, notices)));
    expect(idleResult.failed).toContain("on hold");

    const turnModel = scripted([DONE]);
    const turnRun = await withKey(() => runCompaction("ada", runDeps(config, turnModel, notices), "turn")).catch((e: unknown) => e);
    expect(turnRun).toBeInstanceOf(CompactionPaused);

    expect(idle.calls()).toBe(0);
    expect(turnModel.calls()).toBe(0);
    expect(notices).toEqual([]);
    expect(segments(dataDir)).toBe(0);
    expect(await loadCompactionCheckpoint(dataDir, "ada", "main")).toMatchObject({ pauseReason: "refusal" });
  });

  test("a manual pass resends the request that was refused and finishes the pass", async () => {
    const { config, dataDir } = await world();
    const firstSeen: unknown[][] = [];
    await refuseOnce(config, firstSeen);

    const retrySeen: unknown[][] = [];
    const outcome = await withKey(() => runCompactionPass("ada", runDeps(config, scripted([DONE], retrySeen)), { trigger: "manual" }));

    expect(outcome).toMatchObject({ kind: "compacted", toolRounds: 1 });
    expect(retrySeen).toEqual([firstSeen[1] as unknown[]]);
    expect(segments(dataDir)).toBe(1);
    expect(await loadCompactionCheckpoint(dataDir, "ada", "main")).toBeUndefined();
    expect(existsSync(join(characterWorkspace(config, "ada").dir, "memory", "boats.md"))).toBe(true);
  });

  test("a refusal that the provider reports as an error afterwards is still a refusal", async () => {
    const { config, dataDir } = await world();
    const deps = runDeps(config, scripted([]));
    const outcome = await withKey(() => runCompactionPass("ada", {
      ...deps,
      generate: async (_request, _model, _character, _sink, tools) => {
        await tools?.onTurn?.(REFUSED);
        throw new Error("Claude Code returned an error result: API Error: safeguards flagged this session. Details: `[cyber]` Request ID: req_1");
      },
    }, { trigger: "idle" }));

    expect(outcome).toMatchObject({ kind: "paused", reason: "refusal" });
    expect(outcome?.kind === "paused" ? outcome.detail : "").toContain("Request ID: req_1");
    expect(segments(dataDir)).toBe(0);
  });
});

describe("a pass that runs after a chat turn", () => {
  test("stops with the turn and keeps its rounds instead of finishing and rolling back", async () => {
    const { config, dataDir, characterDir } = await world();
    const chatTurn = new AbortController();
    let round = 0;
    const generate: Generate = async () => {
      round += 1;
      if (round === 1) return WRITE_BOATS;
      chatTurn.abort();
      return DONE;
    };

    const outcome = await withKey(() =>
      withConversation(threadDataDir(dataDir, "ada", "main"), "turn", () =>
        runCompactionPass("ada", runDeps(config, generate), { trigger: "turn" }), chatTurn.signal));

    expect(outcome).toMatchObject({ kind: "paused", reason: "cancelled", detail: "the chat turn it ran after was cancelled" });
    expect(segments(dataDir)).toBe(0);
    expect(existsSync(join(characterWorkspace(config, "ada").dir, "memory", "boats.md"))).toBe(true);
    expect((await loadCompactionCheckpoint(dataDir, "ada", "main"))?.loop.toolRounds).toBe(1);
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toContain("tell me about boats");
  });
});
