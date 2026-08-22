import { expandShared } from "./support/shared_subtrees.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import rawFixture from "./handler_captures/generation.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);
import { ConversationEngine } from "../src/engine/conversation.ts";
import { characterActiveJsonl } from "../src/config/dirs.ts";
import type { Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import {
  defaultAppConfig,
  defaultSearchConfig,
  type AppConfig,
  type RetrievalMode,
} from "../src/config/app.ts";
import { emptyCatalog, NO_CHAT_MODELS_MESSAGE } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ResolvedModel } from "../src/config/models.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  ToolDefinition,
  WireMessage,
} from "../src/llm/types.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import {
  applyIntermediateMessages,
  generationEngine,
  runGeneration,
  type GenerationDeps,
} from "../src/handler/generation.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import type { TurnAutonomy } from "../src/handler/turn.ts";
import { testTmp } from "./support/tmp.ts";
import { recordedValue } from "./support/rerecord.ts";

const CAPTURE = "tests/handler_captures/generation.json";

afterAll(restoreTestEnv);

const MINTED_TS = "2026-01-01T00:00:00-05:00";
const MINTED_ID_RE = /^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let seededTimestamps = new Set<string>();

function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "msg_id" && typeof val === "string" && MINTED_ID_RE.test(val)) {
        out[k] = "<minted_id>";
      } else if (
        k === "timestamp" &&
        typeof val === "string" &&
        !seededTimestamps.has(val)
      ) {
        out[k] = "<minted_timestamp>";
      } else if (k === "api_key") {
        out[k] = "<redacted>";
      } else if (k === "total_ms" || k === "ttft_ms") {
        out[k] = "<ms>";
      } else {
        out[k] = normalise(val);
      }
    }
    return out;
  }
  return v;
}

function pruned(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruned);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined || val === null) continue;
      if (Array.isArray(val) && val.length === 0 && (k === "alternatives" || k === "images")) {
        continue;
      }
      out[k] = pruned(val);
    }
    return out;
  }
  return v;
}

const shaped = (v: unknown): unknown => pruned(normalise(v));

function stripRoot(s: string, root: string): string {
  return s.startsWith(root) ? `<root>${s.slice(root.length)}` : s;
}

interface Knobs {
  tools_enabled?: string[] | null;
  subagent?: string | null;
  image_generation?: string | null;
  embedding?: string | null;
  embedding_key_set?: boolean;
  search_depth?: string | null;
  max_retries?: number | null;
  with_model?: boolean;
}

interface BuildToolContextOutput {
  active_prompt_snapshot: string[];
  character_data_dir: string;
  character_name: string;
  config_dir: string;
  embedder: boolean;
  image_dir: string;
  image_gen_config: null | {
    api_key_present: boolean;
    model_id: string;
    provider: string;
    size: string;
  };
  mcp_registry: boolean;
  memory_index_path: string;
  memory_retrieval_config: { max_file_bytes: number; mode: RetrievalMode };
  subagent_runtime: boolean;
  workspace_dir: string;
}

interface ToolStep {
  input?: unknown;
  kind: string;
  messages?: { content_blocks: ContentBlock[]; role: Message["role"] }[];
  name?: string;
  tool_id?: string;
}

interface GenerationInput {
  body: { image_data?: unknown[]; images?: string[]; text: string };
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
  if (present(knobs.embedding)) app.defaults.embedding = knobs.embedding;
  if (present(knobs.search_depth)) app.tools.web_search.search_depth = knobs.search_depth;
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
  if (present(knobs.image_generation) || knobs.embedding_key_set === true) {
    const env = present(knobs.image_generation) ? IMAGE_KEY_ENV : EMBED_KEY_ENV;
    setTestEnv(env, "fixture-key");
    providers = ProviderRegistry.fromSection({
      openai: { keys: [{ name: "default", env }] },
    });
  }

  return { app, models, providers, dirs, rawTable: undefined };
}

const IMAGE_KEY_ENV = "SHORE_FIXTURE_IMAGE_KEY";
const EMBED_KEY_ENV = "SHORE_FIXTURE_EMBED_KEY";
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

describe("applyIntermediateMessages", () => {
  for (const c of fixture.apply_intermediate_messages) {
    test(c.name, () => {
      const caseInput = c.input as {
        messages: Message[];
        provider_key: string | null;
        result_model: string;
      };
      seededTimestamps = new Set(caseInput.messages.map((m) => m.timestamp));

      const base: WireMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
      const request = {
        model: "claude-fixture",
        messages: [base],
        ...(caseInput["provider_key"] === null ? {} : { provider_key: caseInput["provider_key"] }),
      } as SidecarRequest;

      applyIntermediateMessages(
        request,
        caseInput.messages,
        caseInput["result_model"],
      );

      expect(shaped(request.messages)).toEqual(shaped(c.output.messages));
    });
  }
});

describe("buildToolContext", () => {
  for (const c of fixture.build_tool_context) {
    test(c.name, async () => {
      const caseInput = c.input as Knobs & { prompt_files: string[] };
      const out = c.output as BuildToolContextOutput;
      const root = await tempRoot("tc");
      const config = await loadedConfig(root, caseInput);

      await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });
      const workspace = join(config.dirs.config, "characters", "ada", "workspace");
      await mkdir(workspace, { recursive: true });
      for (const name of caseInput.prompt_files) {
        await writeFile(join(workspace, name), `# ${name}`);
      }
      await mkdir(join(config.dirs.data, "ada"), { recursive: true });

      const ctx = await buildToolContext(config, config.dirs.data, "ada", {
        mcpRegistry: { call: async () => undefined },
        runSubagent: () => async () => undefined,
      });

      expect(stripRoot(ctx.imageDir, root)).toBe(out["image_dir"]);
      expect(stripRoot(ctx.workspaceDir, root)).toBe(out["workspace_dir"]);
      expect(stripRoot(ctx.characterDataDir, root)).toBe(out["character_data_dir"]);
      expect(stripRoot(ctx.configDir, root)).toBe(out["config_dir"]);
      expect(ctx.characterName).toBe(out["character_name"]);
      expect(stripRoot(ctx.memoryIndexPath ?? "", root)).toBe(
        out.memory_index_path.replace(/workspace_index\.json$/, "workspace_index.db"),
      );
      expect(ctx.embedder !== undefined).toBe(out["embedder"]);
      expect(ctx.mcpCall !== undefined).toBe(out["mcp_registry"]);
      expect(ctx.runSubagent !== undefined).toBe(out["subagent_runtime"]);

      if (out["image_gen_config"] === null) {
        expect(ctx.imageGenConfig).toBeUndefined();
      } else {
        const cfg = out.image_gen_config;
        expect(ctx.imageGenConfig?.provider).toBe(cfg.provider);
        expect(ctx.imageGenConfig?.model_id).toBe(cfg.model_id);
        expect((ctx.imageGenConfig?.api_key ?? "") !== "").toBe(cfg.api_key_present);
        expect(ctx.imageGenConfig?.size).toBe(cfg.size);
      }

      expect(ctx.searchConfig.search_depth).toBe(
        caseInput.search_depth ?? defaultSearchConfig().search_depth,
      );
      expect(ctx.searchConfig.result_limit).toBe(defaultSearchConfig().result_limit);
      expect(ctx.retrievalConfig.maxFileBytes).toBe(
        out["memory_retrieval_config"]["max_file_bytes"],
      );
      expect(ctx.retrievalMode).toBe(out["memory_retrieval_config"]["mode"]);

      const snapshot = readdirSync(join(config.dirs.data, "ada", "active_prompt")).sort();
      expect(snapshot).toEqual(out.active_prompt_snapshot);
    });
  }
});

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
        phase.recordTurn(m.role as Message["role"], m.content_blocks);
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

async function replayTurn(c: GenerationCase): Promise<Run> {
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

  await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });
  await writeFile(join(config.dirs.config, "characters", "ada", "character.md"), "ada system prompt");
  const charDir = join(config.dirs.data, "ada");
  await mkdir(charDir, { recursive: true });

  const history = turnInput.history;
  seededTimestamps = new Set(history.map((m) => m.timestamp));
  if (history.length > 0) {
    await writeFile(
      join(charDir, "active.jsonl"),
      history.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
  }

  const direct: ServerMessage[] = [];
  const broadcast: ServerMessage[] = [];
  const requests: SidecarRequest[] = [];
  const steps = turnInput.tool_steps;
  const events = turnInput.events;

  const provider: SidecarProvider = {
    // eslint-disable-next-line require-yield
    async *stream(req) {
      requests.push(req);
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

  const deps: GenerationDeps = {
    registry: {
      getOrCreate: async () => engine,
      effectiveConfig: () => config,
    },
    dataDir: config.dirs.data,
    providers: { anthropic: provider },
    autonomy,
    notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
    diagnostics: { key_fallbacks: { push: () => {} } },
    emitEvent: (m) => broadcast.push(m),
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => 0, applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
    now: () => MINTED_TS,
    newMessageId: () => `m_${crypto.randomUUID()}`,
    monotonicMs: () => 0,
    sleep: async () => {},
    ...(steps.length === 0
      ? {}
      : {
          loopEvents: (_p, req, phase) => {
            requests.push(req);
            return scriptedLoop(steps, events, phase);
          },
        }),
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

function expectCachedIsTheSentRequestPlusTheReply(
  run: { lastRequest?: unknown; requests: unknown[] },
  out: Record<string, unknown>,
): void {
  const sent = run.requests.at(-1) as Record<string, unknown> | undefined;

  if (run.lastRequest === undefined) {
    expect(
      out["result"],
      "a turn caches nothing for the next one only when it did not finish",
    ).not.toEqual({ ok: true });
    return;
  }

  const cached = { ...(run.lastRequest as Record<string, unknown>) };
  delete cached["rid"];
  expect(sent, "something was cached, so something was sent").toBeDefined();

  const {
    context: _context,
    max_tool_iterations: _iterations,
    ...withoutContext
  } = (sent ?? {}) as Record<string, unknown> & {
    context?: unknown;
    max_tool_iterations?: unknown;
  };

  const sentMessages = (withoutContext["messages"] ?? []) as unknown[];
  const cachedMessages = (cached["messages"] ?? []) as unknown[];

  expect(
    shaped({ ...cached, messages: undefined }),
    "the cached request is the one that was sent, minus its call context",
  ).toEqual(shaped({ ...withoutContext, messages: undefined }));

  expect(
    shaped(cachedMessages.slice(0, sentMessages.length)),
    "with everything that was sent still in front",
  ).toEqual(shaped(sentMessages));

  expect(
    cachedMessages.length,
    "and the turn's own replies appended, so the next turn extends the same prefix",
  ).toBeGreaterThan(sentMessages.length);

  expect(
    Object.hasOwn(cached, "max_tool_iterations"),
    "a keepalive ping replays this prefix, and must not drive a tool loop doing it",
  ).toBe(false);
}

function input(c: unknown): GenerationInput {
  return (c as GenerationCase).input;
}

async function readBack(dataDir: string): Promise<readonly Message[]> {
  const engine = await ConversationEngine.load("ada", dataDir, undefined);
  return engine.messages();
}

describe("runGeneration", () => {
  for (const [index, c] of fixture.handle_generation.entries()) {
    test(c.name, async () => {
      const run = await replayTurn(c as unknown as GenerationCase);
      const out = c.output as Record<string, unknown>;

      recordedValue(CAPTURE, ["handle_generation", index, "output", "direct_frames"], shaped(run.direct));
      expect(shaped(run.direct)).toEqual(shaped(out["direct_frames"]));

      const expectedBroadcast = (out["broadcast_events"] as Record<string, unknown>[]).filter(
        (m) => m["type"] === "new_message",
      );
      expect(shaped(run.broadcast)).toEqual(shaped(expectedBroadcast));

      const expectedRequests = (out["sidecar_requests"] as Record<string, unknown>[]).map(
        ({ tool_rpc: _hop, ...rest }) => rest,
      );
      const offered = run.requests.map((r) => (r as { tools?: ToolDefinition[] }).tools);
      expect(
        offered.map((tools) => tools?.map((t) => t.name)),
        `${c.name}: the tools offered to the model`,
      ).toEqual(expectedRequests.map((r) => r["tools"] as string[] | undefined));
      for (const tools of offered) {
        for (const tool of tools ?? []) {
          expect(
            typeof tool.description === "string" && tool.description !== "",
            `${tool.name} tells the model what it is for`,
          ).toBe(true);
          expect(
            (tool.input_schema as { type?: string } | undefined)?.type,
            `${tool.name} takes an object`,
          ).toBe("object");
        }
      }
      expect(
        shaped(run.requests.map(({ tools: _defs, ...rest }) => rest)),
        `${c.name}: what was sent to the provider`,
      ).toEqual(shaped(expectedRequests.map(({ tools: _names, ...rest }) => rest)));

      const conversation = await readBack(run.dataDir);
      recordedValue(CAPTURE, ["handle_generation", index, "output", "conversation"], shaped(conversation));
      recordedValue(CAPTURE, ["handle_generation", index, "output", "turn_count"], run.turnCount);
      expect(shaped(conversation)).toEqual(shaped(out["conversation"]));
      expect(run.turnCount).toBe(out["turn_count"] as number);

      expectCachedIsTheSentRequestPlusTheReply(run, out);

      const expectedCalls = ["ensureState"];
      const body = input(c).body;
      const fresh =
        !input(c).regen &&
        (body.text !== "" || (body.images?.length ?? 0) > 0);
      if (fresh) expectedCalls.push("onUserMessage");
      if ((out["result"] as Record<string, unknown>)["error"] === undefined) {
        expectedCalls.push("notifyLastRequest", "notifyAssistantMessage", "shouldCompactNow");
      }
      expect(run.autonomyCalls).toEqual(expectedCalls);

      const expectedError = (out["result"] as Record<string, unknown>)["error"];
      if (expectedError === undefined) {
        expect(run.error).toBeUndefined();
        expect(run.compactionCheckedAfter).toBe(run.direct.length);
        expect(run.direct.at(-1)?.type).toBe("stream_end");
      } else {
        expect(run.error).toBeDefined();
        expect(run.compactionCheckedAfter).toBe(-1);
      }
    });
  }
});

test("a sampler preference set for the character reaches the outgoing request", async () => {
  const root = await tempRoot("overlay");
  const config = await loadedConfig(root, { with_model: true });
  setTestEnv(MODEL_KEY_ENV, "fixture-key");

  await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });
  await writeFile(join(config.dirs.config, "characters", "ada", "character.md"), "ada");
  await mkdir(join(config.dirs.data, "ada", "preferences"), { recursive: true });
  await writeFile(
    join(config.dirs.data, "ada", "preferences", "models.toml"),
    '[models."anthropic:claude-fixture"]\ntemperature = 0.25\n',
  );

  const requests: SidecarRequest[] = [];
  const answer: StreamEvent[] = [
    { type: "start", model: "claude-fixture" },
    {
      type: "done",
      content: "ok",
      finish_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    },
  ];
  const provider: SidecarProvider = {
    async *stream(req) {
      requests.push(req);
      yield* answer;
    },
    generate: () => {
      throw new Error("unused");
    },
  };

  const engine = generationEngine(
    await ConversationEngine.load("ada", config.dirs.data, undefined),
  );

  await runGeneration(
    {
      registry: { getOrCreate: async () => engine, effectiveConfig: () => config },
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
      emitEvent: () => {},
      mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
      compaction: { run: async () => 0, applyDeferredEdits: async () => {} },
      newlyCrossedUsageBudgetWarnings: async () => [],
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
      send: async () => {},
      signal: new AbortController().signal,
    },
  );

  expect(requests[0]?.temperature).toBe(0.25);
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
      registry: { getOrCreate: async () => engine, effectiveConfig: () => config },
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
      compaction: { run: async () => 0, applyDeferredEdits: async () => {} },
      newlyCrossedUsageBudgetWarnings: async () => [],
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

  expect(run).rejects.toThrow(NO_CHAT_MODELS_MESSAGE);

  expect(existsSync(characterActiveJsonl(config.dirs.data, "ada"))).toBe(false);
  expect(engine.messages()).toEqual([]);
  expect(broadcast).toEqual([]);
  expect(direct).toEqual([]);
});
