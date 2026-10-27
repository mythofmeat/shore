import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { characterActiveJsonl, MAIN_THREAD } from "../src/config/dirs.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog, NO_CHAT_MODELS_MESSAGE } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { SidecarProvider, StreamEvent } from "../src/llm/types.ts";
import { generationEngine, runGeneration, type GenerationDeps } from "../src/handler/generation.ts";
import { testTmp } from "./support/tmp.ts";
import { recordedTurns, WorkspaceRecorder, workspaceTurnsFor, type WorkspaceTurns } from "../src/tools/workspace_turns.ts";
import { outcomeOf } from "./support/outcome.ts";
import { until } from "./support/until.ts";

afterAll(restoreTestEnv);

const MODEL_KEY_ENV = "SHORE_FIXTURE_API_KEY";

async function loadedConfig(withModel: boolean, tools: string[] = []): Promise<LoadedConfig> {
  const root = await mkdtemp(testTmp("shore-gen-"));
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  const app = defaultAppConfig();
  app.tools.enabled_tools = tools;
  app.advanced.max_retries = 0;
  const models = emptyCatalog();
  if (withModel) {
    models.chat.set("chat.fixture", {
      name: "fixture",
      qualifiedName: "chat.fixture",
      category: "chat",
      providerKey: "anthropic",
      sdk: "anthropic",
      modelId: "claude-fixture",
      apiKeyEnv: MODEL_KEY_ENV,
      maxContextTokens: 200_000,
      maxOutputTokens: 4096,
      maxToolIterations: 4,
    });
    app.defaults.model = "fixture";
  }
  return { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
}

function deps(config: LoadedConfig, engine: ReturnType<typeof generationEngine>, provider: SidecarProvider, emitted: ServerMessage[]): GenerationDeps {
  return {
    registry: {
      getOrCreate: async () => engine,
      effectiveConfig: () => config,
      listThreads: () => [{ id: "main", created_at: "2026-09-03T00:00:00.000Z", compaction: true }],
    },
    dataDir: config.dirs.data,
    providers: { anthropic: provider },
    autonomy: {
      ensureState: () => false,
      needsActivityBackfill: () => false,
      backfillActivity: () => {},
      onUserMessage: () => {},
      shouldCompactNow: () => false,
      onCompactionComplete: () => {},
      onCompactionFailed: () => {},
      notifyLastRequest: () => {},
      notifyAssistantMessage: () => {},
    },
    notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
    diagnostics: { key_fallbacks: { push: () => {} } },
    emitEvent: (m) => emitted.push(m),
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => ({ kind: "completed", retained: 0 }), applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
    newlyCrossedPlanLimitWarnings: async () => [],
    now: () => "2026-01-01T00:00:00-05:00",
    newMessageId: () => `m_${crypto.randomUUID()}`,
    monotonicMs: () => 0,
    sleep: async () => {},
  };
}

interface Turn {
  history: Message[];
  regen: boolean;
  events: StreamEvent[];
  tools?: string[];
  toolRound?: ContentBlock[];
  seed?: (turns: WorkspaceTurns) => Promise<void>;
  during?: (turns: WorkspaceTurns) => Promise<void>;
  compaction?: GenerationDeps["compaction"];
}

async function runTurn(turn: Turn): Promise<{ error?: string; dataDir: string }> {
  const config = await loadedConfig(true, turn.tools);
  setTestEnv(MODEL_KEY_ENV, "fixture-key");
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "ada system prompt");
  await mkdir(join(config.dirs.data, "ada", "threads", "main"), { recursive: true });
  const turns = workspaceTurnsFor(config.dirs, "ada");
  await turn.seed?.(turns);
  if (turn.history.length > 0) {
    writeDurable(characterActiveJsonl(config.dirs.data, "ada", MAIN_THREAD), turn.history.map((m) => `${JSON.stringify(m)}\n`).join(""));
  }

  const provider: SidecarProvider = {
    async *stream() {
      await turn.during?.(turns);
      yield* turn.events;
    },
    generate: () => {
      throw new Error("no turn here generates");
    },
  };
  const round = turn.toolRound;
  if (round !== undefined) {
    provider.streamWithTools = async function* (_req, phase) {
      await turn.during?.(turns);
      await phase.recordTurn("assistant", round);
      for (const block of round) {
        if (block.type === "tool_use") await phase.runTool({ id: block.id, name: block.name, input: block.input });
      }
      yield* turn.events;
    };
  }

  const engine = generationEngine(await ConversationEngine.load("ada", config.dirs.data, undefined));
  try {
    const generation = deps(config, engine, provider, []);
    if (turn.compaction !== undefined) {
      generation.compaction = turn.compaction;
      generation.autonomy = { ...generation.autonomy, shouldCompactNow: () => true };
    }
    await runGeneration(generation, {
      meta: { session: { clientId: 1, sessionId: 1, clientType: "test-client", clientName: "test-1", capabilities: ["streaming"], selectedCharacter: "ada" }, rid: null, kind: "message" } as never,
      body: { rid: null, text: turn.regen ? "" : "Leave me a note", stream: true, images: [], image_data: [] },
      regen: turn.regen,
      charName: "ada",
      rid: null,
      send: async () => {},
      signal: new AbortController().signal,
    });
    return { dataDir: config.dirs.data };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), dataDir: config.dirs.data };
  }
}

async function readBack(dataDir: string): Promise<readonly Message[]> {
  return (await ConversationEngine.load("ada", dataDir, undefined)).messages();
}

const usage = { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 };
const timing = { total_ms: 10, time_to_first_token_ms: 2 };

describe("workspace turns", () => {
  const question: Message = {
    msg_id: "m_question", role: "user", content: "Leave me a note", images: [],
    content_blocks: [{ type: "text", text: "Leave me a note" }], timestamp: "2026-01-01T10:00:00-05:00",
  };
  const answer: Message = {
    msg_id: "m_answer", role: "assistant", content: "Done.", images: [],
    content_blocks: [{ type: "text", text: "Done." }], timestamp: "2026-01-01T10:00:01-05:00", version: "mv_old",
  };
  const reply: StreamEvent[] = [
    { type: "start", model: "claude-fixture" },
    { type: "text", text: "Here you go." },
    { type: "done", content: "Here you go.", finish_reason: "end_turn", usage, timing },
  ];
  const seedOldNote = async (turns: WorkspaceTurns): Promise<void> => {
    const recorder = new WorkspaceRecorder(turns);
    await recorder.track(async () => await writeFile(join(turns.workspace, "note.md"), "from the old reply\n"));
    await recorder.settle("main", "mv_old");
  };

  test("a regenerate undoes the old reply's files before the new reply runs", async () => {
    let sawOldNote: boolean | undefined;
    let workspace = "";
    const run = await runTurn({
      history: [question, answer],
      regen: true,
      events: reply,
      seed: seedOldNote,
      tools: ["bash"],
      toolRound: [{ type: "tool_use", id: "tool_write", name: "bash", input: { command: "printf 'from the new reply' > other.md" } }],
      during: async (turns) => {
        workspace = turns.workspace;
        sawOldNote = existsSync(join(turns.workspace, "note.md"));
      },
    });
    expect(run.error).toBeUndefined();
    expect(sawOldNote).toBe(false);
    expect(existsSync(join(workspace, "note.md"))).toBe(false);
    expect(existsSync(join(workspace, "other.md"))).toBe(true);
    const turns = workspaceTurnsFor({ config: join(run.dataDir, "..", "config"), cache: join(run.dataDir, "..", "cache") }, "ada");
    const version = String((await readBack(run.dataDir)).filter((message) => message.role === "assistant").at(-1)?.version);
    expect(await recordedTurns(turns, "main", ["mv_old", version])).toEqual(["mv_old", version]);
  });

  test("a regenerate that fails puts the old reply's files back", async () => {
    let workspace = "";
    const run = await runTurn({
      history: [question, answer],
      regen: true,
      events: reply,
      seed: seedOldNote,
      during: async (turns) => {
        workspace = turns.workspace;
        throw new Error("provider down");
      },
    });
    expect(run.error).toContain("provider down");
    expect(readFileSync(join(workspace, "note.md"), "utf8")).toBe("from the old reply\n");
    expect((await readBack(run.dataDir)).map((message) => message.msg_id)).toEqual(["m_question", "m_answer"]);
  });
});

test("a failed tool loop is durable before the final answer and repaired after restart", async () => {
  const run = await runTurn({
    history: [],
    regen: false,
    tools: ["*"],
    toolRound: [{ type: "tool_use", id: "tool_interrupted", name: "activity", input: {} }],
    events: [
      { type: "start", model: "claude-fixture" },
      { type: "error", message: "daemon connection dropped", usage: { ...usage, output_tokens: 1 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } },
    ],
  });

  expect(run.error).toBeDefined();
  const raw = await readFile(characterActiveJsonl(run.dataDir, "ada", MAIN_THREAD), "utf8");
  const durable = raw.trim().split("\n").map((line) => JSON.parse(line) as Message);
  expect(durable.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(durable[1]?.content_blocks).toEqual([{ type: "tool_use", id: "tool_interrupted", name: "activity", input: {} }]);

  const restarted = await ConversationEngine.load("ada", run.dataDir, undefined);
  expect(await restarted.recoverInterruptedToolLoop()).toBe(1);
  const recovered = restarted.messages();
  expect(recovered.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  expect(recovered[2]?.content_blocks).toEqual([{
    type: "tool_result",
    tool_use_id: "tool_interrupted",
    content: "Tool execution was interrupted by a Shore daemon restart before it returned a result.",
    is_error: true,
  }]);
});

test("a turn with no model configured leaves the conversation untouched", async () => {
  const config = await loadedConfig(false);
  await mkdir(join(config.dirs.data, "ada"), { recursive: true });
  const engine = generationEngine(await ConversationEngine.load("ada", config.dirs.data, undefined));
  const unreachable = () => {
    throw new Error("a turn with no model must not reach a provider");
  };
  const emitted: ServerMessage[] = [];
  const sent: ServerMessage[] = [];

  const run = runGeneration(deps(config, engine, { stream: unreachable, generate: unreachable }, emitted), {
    meta: { session: { sessionId: 1 } } as never,
    body: { rid: null, text: "hello", stream: true, images: [], image_data: [] },
    regen: false,
    charName: "ada",
    rid: null,
    send: async (m) => {
      sent.push(m);
    },
    signal: new AbortController().signal,
  });

  expect(await outcomeOf(run)).toThrow(NO_CHAT_MODELS_MESSAGE);
  expect(existsSync(characterActiveJsonl(config.dirs.data, "ada", MAIN_THREAD))).toBe(false);
  expect(engine.messages()).toEqual([]);
  expect(emitted).toEqual([]);
  expect(sent).toEqual([]);
});

test("a reply finishes without waiting for the compaction it starts", async () => {
  const pass = Promise.withResolvers<void>();
  const started: string[] = [];
  const run = await runTurn({
    history: [],
    regen: false,
    events: [
      { type: "start", model: "claude-fixture" },
      { type: "text", text: "Here you go." },
      { type: "done", content: "Here you go.", finish_reason: "end_turn", usage, timing },
    ],
    compaction: {
      run: async (_character, _config, thread) => {
        started.push(thread ?? "");
        await pass.promise;
        return { kind: "completed", retained: 1 };
      },
      applyDeferredEdits: async () => {},
    },
  });
  expect(run.error).toBeUndefined();
  await until(() => started.length === 1, "the compaction to start");
  expect(started).toEqual(["main"]);
  expect((await readBack(run.dataDir)).map((message) => message.role)).toEqual(["user", "assistant"]);
  pass.resolve();
});
