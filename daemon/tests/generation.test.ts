import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { characterActiveJsonl, MAIN_THREAD } from "../src/config/dirs.ts";
import type { Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { emptyCatalog, NO_CHAT_MODELS_MESSAGE } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { type LoadedConfig } from "../src/config/loader.ts";
import type { ResolvedModel } from "../src/config/models.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import { generationEngine, runGeneration, type GenerationDeps } from "../src/handler/generation.ts";
import type { TurnAutonomy } from "../src/handler/turn.ts";
import { testTmp } from "./support/tmp.ts";
import { recordedTurns, recordTurn, snapshotTree, workspaceTurnsFor, type WorkspaceTurns } from "../src/tools/workspace_turns.ts";
import { outcomeOf } from "./support/outcome.ts";

afterAll(restoreTestEnv);

const MINTED_TS = "2026-01-01T00:00:00-05:00";

interface Knobs {
  tools_enabled?: string[] | null;
  subagent?: string | null;
  image_generation?: string | null;
  max_retries?: number | null;
  with_model?: boolean;
}

interface ToolStep {
  input?: unknown;
  kind: string;
  messages?: { content_blocks: ContentBlock[]; role: Message["role"] }[];
  name?: string;
  tool_id?: string;
}

interface GenerationInput {
  body: { guidance?: string; image_data?: unknown[]; images?: string[]; text: string };
  events: StreamEvent[];
  history: Message[];
  max_retries: number | null;
  regen: boolean;
  rid: string | null;
  subagent: string | null;
  tool_steps: ToolStep[];
  tools_enabled: string[] | null;
}

interface GenerationCase {
  input: GenerationInput;
  output: Record<string, unknown>;
}

function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

async function loadedConfig(root: string, knobs: Knobs): Promise<LoadedConfig> {
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const app: AppConfig = defaultAppConfig();
  if (present(knobs.tools_enabled)) app.tools.enabled_tools = [...knobs.tools_enabled];
  if (present(knobs.subagent)) {
    app.subagents.set(knobs.subagent, {
      description: `the ${knobs.subagent} sub-agent`,
      prompt: "you are a sub-agent",
      tools: [],
      model: "anthropic:claude-x",
      max_iterations: undefined,
      timeout: undefined,
    });
  }
  if (present(knobs.image_generation)) app.defaults.image_generation = knobs.image_generation;
  if (present(knobs.max_retries)) app.advanced.max_retries = knobs.max_retries;

  const models = emptyCatalog();
  if (knobs.with_model === true) {
    models.chat.set("chat.fixture", model());
    app.defaults.model = "fixture";
  }
  if (present(knobs.image_generation)) {
    models.imageGeneration.set(knobs.image_generation, { size: "512x512" });
  }

  let providers = ProviderRegistry.empty();
  if (present(knobs.image_generation)) {
    setTestEnv(IMAGE_KEY_ENV, "fixture-key");
    providers = ProviderRegistry.fromSection({
      openai: { keys: [{ name: "default", env: IMAGE_KEY_ENV }] },
    });
  }

  return { app, models, providers, dirs, rawTable: undefined };
}

const IMAGE_KEY_ENV = "SHORE_FIXTURE_IMAGE_KEY";
const MODEL_KEY_ENV = "SHORE_FIXTURE_API_KEY";

function model(): ResolvedModel {
  return {
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
  };
}

async function tempRoot(name: string): Promise<string> {
  return await mkdtemp(testTmp(`shore-gen-${name}-`));
}

interface Run {
  direct: ServerMessage[];
  broadcast: ServerMessage[];
  requests: SidecarRequest[];
  lastRequest: unknown;
  error?: string;
  compactionCheckedAfter: number;
  autonomyCalls: string[];
  dataDir: string;
  turnCount: number;
}

async function* scriptedLoop(
  steps: readonly ToolStep[],
  events: readonly StreamEvent[],
  phase: ToolPhase,
): AsyncIterable<StreamEvent> {
  for (const step of steps) {
    if (step["kind"] === "messages") {
      for (const m of step["messages"] as { role: string; content_blocks: ContentBlock[] }[]) {
        await phase.recordTurn(m.role as Message["role"], m.content_blocks);
      }
    } else {
      await phase.runTool({
        id: step["tool_id"] as string,
        name: step["name"] as string,
        input: step["input"],
      });
    }
  }
  yield* events;
}

interface ReplayHooks {
  seed?: (turns: WorkspaceTurns) => Promise<void>;
  during?: (turns: WorkspaceTurns) => Promise<void>;
}

async function replayTurn(c: GenerationCase, hooks: ReplayHooks = {}): Promise<Run> {
  const turnInput = c.input;
  const root = await tempRoot("run");
  const config = await loadedConfig(root, {
    with_model: true,
    tools_enabled: turnInput["tools_enabled"],
    subagent: turnInput["subagent"],
    ...(turnInput["max_retries"] === undefined
      ? {}
      : { max_retries: turnInput["max_retries"] }),
  });
  setTestEnv(MODEL_KEY_ENV, "fixture-key");

  await mkdir(join(config.dirs.config, "characters", "ada", "workspace"), { recursive: true });
  await writeFile(join(config.dirs.config, "characters", "ada", "workspace", "SOUL.md"), "ada system prompt");
  const charDir = join(config.dirs.data, "ada");
  await mkdir(join(charDir, "threads", "main"), { recursive: true });
  const turns = workspaceTurnsFor(config.dirs, "ada");
  await hooks.seed?.(turns);

  const history = turnInput.history;
  if (history.length > 0) {
    writeDurable(join(charDir, "threads", "main", "active.jsonl"), history.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }

  const direct: ServerMessage[] = [];
  const broadcast: ServerMessage[] = [];
  const requests: SidecarRequest[] = [];
  const steps = turnInput.tool_steps;
  const events = turnInput.events.map((event) => {
    if (!("timing" in event)) return event;
    const timing = event.timing as typeof event.timing & { ttft_ms?: number };
    return {
      ...event,
      timing: {
        total_ms: timing.total_ms,
        time_to_first_token_ms: timing.time_to_first_token_ms ?? timing.ttft_ms ?? 0,
      },
    };
  });

  const provider: SidecarProvider = {
    async *stream(req) {
      requests.push(req);
      await hooks.during?.(turns);
      yield* events;
    },
    generate: () => {
      throw new Error("no case generates");
    },
  };

  let lastRequest: unknown;
  let compactionCheckedAfter = -1;
  const autonomyCalls: string[] = [];
  const autonomy: TurnAutonomy & GenerationDeps["autonomy"] = {
    ensureState: () => {
      autonomyCalls.push("ensureState");
      return false;
    },
    needsActivityBackfill: () => false,
    backfillActivity: () => {},
    onUserMessage: () => {
      autonomyCalls.push("onUserMessage");
    },
    shouldCompactNow: () => {
      autonomyCalls.push("shouldCompactNow");
      compactionCheckedAfter = direct.length;
      return false;
    },
    onCompactionComplete: () => {},
    onCompactionFailed: () => {},
    notifyLastRequest: (_c, request) => {
      autonomyCalls.push("notifyLastRequest");
      lastRequest = request;
    },
    notifyAssistantMessage: () => {
      autonomyCalls.push("notifyAssistantMessage");
    },
  };

  const engine = generationEngine(
    await ConversationEngine.load("ada", config.dirs.data, undefined),
  );

  if (steps.length > 0) {
    provider.streamWithTools = (req, phase) => {
      requests.push(req);
      return scriptedLoop(steps, events, phase);
    };
  }

  const deps: GenerationDeps = {
    registry: {
      getOrCreate: async () => engine,
      effectiveConfig: () => config,
      listThreads: () => [{ id: "main", created_at: "2026-09-03T00:00:00.000Z", compaction: true }],
    },
    dataDir: config.dirs.data,
    providers: { anthropic: provider },
    autonomy,
    notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
    diagnostics: { key_fallbacks: { push: () => {} } },
    emitEvent: (m) => broadcast.push(m),
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => ({ kind: "completed", retained: 0 }), applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
    newlyCrossedPlanLimitWarnings: async () => [],
    now: () => MINTED_TS,
    newMessageId: () => `m_${crypto.randomUUID()}`,
    monotonicMs: () => 0,
    sleep: async () => {},

  };

  let error: string | undefined;
  try {
    await runGeneration(deps, {
      meta: {
        session: {
          clientId: 1,
          sessionId: 1,
          clientType: "test-client",
          clientName: "test-1",
          capabilities: ["streaming"],
          selectedCharacter: "ada",
        },
        rid: turnInput["rid"],
        kind: "message",
      } as never,
      body: {
        rid: turnInput["rid"] ?? null,
        text: turnInput["body"]["text"],
        stream: true,
        images: turnInput["body"]["images"] ?? [],
        image_data: turnInput["body"]["image_data"] ?? [],
        ...(turnInput["body"]["guidance"] === undefined
          ? {}
          : { guidance: turnInput["body"]["guidance"] }),
      },
      regen: turnInput.regen,
      charName: "ada",
      rid: turnInput["rid"] ?? null,
      send: async (m) => {
        direct.push(m);
      },
      signal: new AbortController().signal,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    if (process.env["SHORE_DEBUG_REPLAY"] === "1") console.error("REPLAY ERROR:", e);
  }

  return {
    direct,
    broadcast,
    requests,
    lastRequest,
    ...(error === undefined ? {} : { error }),
    compactionCheckedAfter,
    autonomyCalls,
    dataDir: config.dirs.data,
    turnCount: engine.turnCount(),
  };
}

async function readBack(dataDir: string): Promise<readonly Message[]> {
  const engine = await ConversationEngine.load("ada", dataDir, undefined);
  return engine.messages();
}

describe("workspace turns", () => {
  const question: Message = {
    msg_id: "m_question", role: "user", content: "Leave me a note", images: [],
    content_blocks: [{ type: "text", text: "Leave me a note" }], timestamp: "2026-01-01T10:00:00-05:00",
  };
  const answer: Message = {
    msg_id: "m_answer", role: "assistant", content: "Done.", images: [],
    content_blocks: [{ type: "text", text: "Done." }], timestamp: "2026-01-01T10:00:01-05:00", version: "mv_old",
  };
  const reply = (text: string): StreamEvent[] => [
    { type: "start", model: "claude-fixture" },
    { type: "text", text },
    {
      type: "done", content: text, finish_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 10, time_to_first_token_ms: 2 },
    },
  ];
  const turn = (regen: boolean, history: Message[]): GenerationCase => ({
    input: {
      history, body: { text: regen ? "" : "Leave me a note" }, regen, rid: null, max_retries: 0,
      subagent: null, tools_enabled: null, tool_steps: [], events: reply("Here you go."),
    },
    output: {},
  });
  const seedOldNote = async (turns: WorkspaceTurns): Promise<void> => {
    const before = await snapshotTree(turns);
    await writeFile(join(turns.workspace, "note.md"), "from the old reply\n");
    await recordTurn(turns, "main", "mv_old", before);
  };
  const newestVersion = async (dataDir: string): Promise<string> =>
    String((await readBack(dataDir)).filter((message) => message.role === "assistant").at(-1)?.version);

  test("a regenerate undoes the old reply's files before the new reply runs", async () => {
    let sawOldNote: boolean | undefined;
    let workspace = "";
    const run = await replayTurn(turn(true, [question, answer]), {
      seed: seedOldNote,
      during: async (turns) => {
        workspace = turns.workspace;
        sawOldNote = existsSync(join(turns.workspace, "note.md"));
        await writeFile(join(turns.workspace, "other.md"), "from the new reply\n");
      },
    });
    expect(run.error).toBeUndefined();
    expect(sawOldNote).toBe(false);
    expect(existsSync(join(workspace, "note.md"))).toBe(false);
    expect(existsSync(join(workspace, "other.md"))).toBe(true);
    const turns = workspaceTurnsFor({ config: join(run.dataDir, "..", "config"), cache: join(run.dataDir, "..", "cache") }, "ada");
    const version = await newestVersion(run.dataDir);
    expect(await recordedTurns(turns, "main", ["mv_old", version])).toEqual(["mv_old", version]);
  });

  test("a regenerate that fails puts the old reply's files back", async () => {
    let workspace = "";
    const run = await replayTurn(turn(true, [question, answer]), {
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
  const run = await replayTurn({
    input: {
      history: [],
      body: { text: "look this up", images: [] },
      regen: false,
      rid: "r-interrupted-tool",
      max_retries: 0,
      subagent: null,
      tools_enabled: ["*"],
      tool_steps: [{
        kind: "messages",
        messages: [{
          role: "assistant",
          content_blocks: [{ type: "tool_use", id: "tool_interrupted", name: "activity", input: {} }],
        }],
      }],
      events: [
        { type: "start", model: "claude-fixture" },
        {
          type: "error",
          message: "daemon connection dropped",
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          timing: { total_ms: 1, time_to_first_token_ms: 1 },
        },
      ],
    },
    output: {},
  });

  expect(run.error).toBeDefined();
  const raw = await readFile(characterActiveJsonl(run.dataDir, "ada", MAIN_THREAD), "utf8");
  const durable = raw.trim().split("\n").map((line) => JSON.parse(line) as Message);
  expect(durable.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(durable[1]?.content_blocks).toEqual([
    { type: "tool_use", id: "tool_interrupted", name: "activity", input: {} },
  ]);

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
  const root = await tempRoot("nomodel");
  const config = await loadedConfig(root, {});
  await mkdir(join(config.dirs.data, "ada"), { recursive: true });

  const engine = generationEngine(
    await ConversationEngine.load("ada", config.dirs.data, undefined),
  );
  const broadcast: ServerMessage[] = [];
  const direct: ServerMessage[] = [];

  const run = runGeneration(
    {
      registry: {
      getOrCreate: async () => engine,
      effectiveConfig: () => config,
      listThreads: () => [{ id: "main", created_at: "2026-09-03T00:00:00.000Z", compaction: true }],
    },
      dataDir: config.dirs.data,
      providers: {
        anthropic: {
          stream: () => {
            throw new Error("a turn with no model must not reach a provider");
          },
          generate: () => {
            throw new Error("a turn with no model must not reach a provider");
          },
        },
      },
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
      emitEvent: (m) => broadcast.push(m),
      mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
      compaction: { run: async () => ({ kind: "completed", retained: 0 }), applyDeferredEdits: async () => {} },
      newlyCrossedUsageBudgetWarnings: async () => [],
      newlyCrossedPlanLimitWarnings: async () => [],
      now: () => MINTED_TS,
      newMessageId: () => `m_${crypto.randomUUID()}`,
      monotonicMs: () => 0,
      sleep: async () => {},
    },
    {
      meta: { session: { sessionId: 1 } } as never,
      body: { rid: null, text: "hello", stream: true, images: [], image_data: [] },
      regen: false,
      charName: "ada",
      rid: null,
      send: async (m) => {
        direct.push(m);
      },
      signal: new AbortController().signal,
    },
  );

  expect(await outcomeOf(run)).toThrow(NO_CHAT_MODELS_MESSAGE);

  expect(existsSync(characterActiveJsonl(config.dirs.data, "ada", MAIN_THREAD))).toBe(false);
  expect(engine.messages()).toEqual([]);
  expect(broadcast).toEqual([]);
  expect(direct).toEqual([]);
});
