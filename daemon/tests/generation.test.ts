import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { characterActiveJsonl, MAIN_THREAD } from "../src/config/dirs.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog, NO_CHAT_MODELS_MESSAGE } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { generationEngine, runGeneration, type GenerationDeps } from "../src/handler/generation.ts";
import type { ImageUpload } from "../src/handler/images.ts";
import { imageSupportFor } from "../src/llm/image_support.ts";
import { sentPicturesDir } from "../src/storage/sent_pictures.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";
import { recordedTurns, WorkspaceRecorder, workspaceTurnsFor, type WorkspaceTurns } from "../src/tools/workspace_turns.ts";
import { outcomeOf } from "./support/outcome.ts";
import { until } from "./support/until.ts";

afterAll(restoreTestEnv);

const MODEL_KEY_ENV = "SHORE_FIXTURE_API_KEY";

async function loadedConfig(withModel: boolean, tools: string[] = [], kept?: string): Promise<LoadedConfig> {
  const root = kept ?? await mkdtemp(testTmp("shore-gen-"));
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  const app = defaultAppConfig();
  app.tools.enabled = tools;
  app.chat.max_retries = 0;
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
      maxToolRounds: 4,
    });
    app.chat.model = "fixture";
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
  thread?: string;
  rid?: string;
  sent?: ServerMessage[];
  provider?: SidecarProvider;
  maxRetries?: number;
  twoKeys?: boolean;
  adjust?: (generation: GenerationDeps) => void;
  text?: string;
  pictures?: ImageUpload[];
  takesPictures?: boolean;
  accepted?: () => Promise<void>;
  signal?: AbortSignal;
  send?: (frame: ServerMessage) => Promise<void>;
  seen?: SidecarRequest[];
  root?: string;
}

const SPARE_KEY_ENV = "SHORE_FIXTURE_SPARE_API_KEY";

async function runTurn(turn: Turn): Promise<{ error?: string; dataDir: string }> {
  const loaded = await loadedConfig(true, turn.tools, turn.root);
  if (turn.maxRetries !== undefined) loaded.app.chat.max_retries = turn.maxRetries;
  const fixture = loaded.models.chat.get("chat.fixture");
  if (fixture !== undefined && turn.takesPictures !== undefined) fixture.supportsImages = turn.takesPictures;
  const config: LoadedConfig = turn.twoKeys === true
    ? { ...loaded, providers: ProviderRegistry.fromSection({ anthropic: { keys: [{ name: "primary", api_key_env: MODEL_KEY_ENV }, { name: "spare", api_key_env: SPARE_KEY_ENV }] } }) }
    : loaded;
  setTestEnv(MODEL_KEY_ENV, "fixture-key");
  setTestEnv(SPARE_KEY_ENV, "spare-key");
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "ada system prompt");
  await mkdir(join(config.dirs.data, "ada", "threads", "main"), { recursive: true });
  const turns = workspaceTurnsFor(config.dirs, "ada");
  await turn.seed?.(turns);
  if (turn.history.length > 0) {
    writeDurable(characterActiveJsonl(config.dirs.data, "ada", turn.thread ?? MAIN_THREAD), turn.history.map((m) => `${JSON.stringify(m)}\n`).join(""));
  }

  const provider: SidecarProvider = {
    async *stream(request) {
      turn.seen?.push(request);
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

  const engine = generationEngine(await ConversationEngine.load("ada", config.dirs.data, undefined, turn.thread ?? MAIN_THREAD));
  try {
    const generation = deps(config, engine, turn.provider ?? provider, []);
    turn.adjust?.(generation);
    if (turn.compaction !== undefined) {
      generation.compaction = turn.compaction;
      generation.autonomy = { ...generation.autonomy, shouldCompactNow: () => true };
    }
    await runGeneration(generation, {
      meta: { session: { clientId: 1, sessionId: 1, clientType: "test-client", clientName: "test-1", capabilities: ["streaming"], selectedCharacter: "ada" }, rid: turn.rid ?? null, kind: "message" } as never,
      body: { rid: turn.rid ?? null, text: turn.regen ? "" : turn.text ?? "Leave me a note", stream: true, images: [], image_data: turn.pictures ?? [] },
      regen: turn.regen,
      charName: "ada",
      rid: turn.rid ?? null,
      send: turn.send ?? (async (frame) => { turn.sent?.push(frame); }),
      signal: turn.signal ?? new AbortController().signal,
      ...(turn.accepted === undefined ? {} : { accepted: turn.accepted }),
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
  expect(await restarted.recoverInterruptedToolLoop("the daemon was restarted")).toBe(1);
  const recovered = restarted.messages();
  expect(recovered.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  expect(recovered[2]?.content_blocks).toEqual([{
    type: "tool_result",
    tool_use_id: "tool_interrupted",
    content: "the daemon was restarted",
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

test("a reply is offered Shore's tools that are on and the MCP tools the registry hands over, held to the model's max_tool_rounds, and with neither the request carries no tools and nothing is set up for them", async () => {
  const offered = async (tools: string[], mcp: { name: string; description: string; input_schema: Record<string, unknown> }[], capped = true): Promise<{ tools: string[] | undefined; setUps: number; rounds: number | undefined }> => {
    const config = await loadedConfig(true, tools);
    const model = config.models.chat.get("chat.fixture");
    if (model !== undefined && !capped) delete model.maxToolRounds;
    setTestEnv(MODEL_KEY_ENV, "fixture-key");
    const workspace = join(config.dirs.config, "characters", "ada", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), "ada system prompt");
    await mkdir(join(config.dirs.data, "ada", "threads", "main"), { recursive: true });
    const events: StreamEvent[] = [
      { type: "start", model: "claude-fixture" },
      { type: "text", text: "Hello." },
      { type: "done", content: "Hello.", finish_reason: "end_turn", usage, timing },
    ];
    const seen: SidecarRequest[] = [];
    const provider: SidecarProvider = {
      async *stream(request) { seen.push(request); yield* events; },
      async *streamWithTools(request) { seen.push(request); yield* events; },
      generate: () => { throw new Error("no turn here generates"); },
    };
    const engine = generationEngine(await ConversationEngine.load("ada", config.dirs.data, undefined));
    let setUps = 0;
    await runGeneration({
      ...deps(config, engine, provider, []),
      mcpRegistry: { toolDefsFiltered: () => mcp, call: async () => undefined },
      tools: () => { setUps += 1; return {}; },
    }, {
      meta: { session: { clientId: 1, sessionId: 1, clientType: "test-client", clientName: "test-1", capabilities: ["streaming"], selectedCharacter: "ada" }, rid: null, kind: "message" } as never,
      body: { rid: null, text: "hello", stream: true, images: [], image_data: [] },
      regen: false,
      charName: "ada",
      rid: null,
      send: async () => {},
      signal: new AbortController().signal,
    });
    return { tools: seen[0]?.tools?.map((tool) => tool.name), setUps, rounds: seen[0]?.max_tool_rounds };
  };
  const find = { name: "mcp__search__find", description: "finds", input_schema: { type: "object", properties: {} } };
  expect(await offered([], [])).toEqual({ tools: undefined, setUps: 0, rounds: undefined });
  expect(await offered([], [find])).toEqual({ tools: ["mcp__search__find"], setUps: 1, rounds: 4 });
  expect(await offered(["read"], [])).toEqual({ tools: ["read"], setUps: 1, rounds: 4 });
  expect(await offered(["read"], [find])).toEqual({ tools: ["read", "mcp__search__find"], setUps: 1, rounds: 4 });
  expect(await offered(["read"], [], false)).toEqual({ tools: ["read"], setUps: 1, rounds: undefined });
});

describe("a reply's turn", () => {
  const answered: StreamEvent[] = [
    { type: "start", model: "claude-fixture" },
    { type: "text", text: "Here you go." },
    { type: "done", content: "Here you go.", finish_reason: "end_turn", usage, timing },
  ];

  test("its frames, its tools' frames and the turn its tools are handed carry the id of the request that asked for it", async () => {
    const sent: ServerMessage[] = [];
    const handed: (string | undefined)[] = [];
    const run = await runTurn({
      history: [], regen: false, rid: "r-1", sent, events: answered,
      tools: ["read"],
      toolRound: [{ type: "tool_use", id: "tool_read", name: "read", input: { file_path: "SOUL.md" } }],
      adjust: (generation) => { generation.tools = (_character, turn) => { handed.push(turn.rid); return {}; }; },
    });
    expect(run.error).toBeUndefined();
    const tagged = sent.flatMap((frame) => "rid" in frame ? [[frame.type, frame.rid]] : []);
    expect(tagged).toContainEqual(["tool_call", "r-1"]);
    expect(tagged).toContainEqual(["stream_chunk", "r-1"]);
    expect(tagged.filter(([, rid]) => rid !== "r-1")).toEqual([]);
    expect(handed).toEqual(["r-1"]);
  });

  test("one that fails in a way worth another try waits out the backoff before trying again", async () => {
    let calls = 0;
    const waits: number[] = [];
    const run = await runTurn({
      history: [], regen: false, events: [], maxRetries: 1,
      provider: {
        async *stream() {
          calls += 1;
          if (calls === 1) throw new Error("overloaded_error");
          yield* answered;
        },
        generate: () => {
          throw new Error("no turn here generates");
        },
      },
      adjust: (generation) => { generation.sleep = async (ms) => { waits.push(ms); }; },
    });
    expect(run.error).toBeUndefined();
    expect([calls, waits.length]).toEqual([2, 1]);
  });

  test("its tools work in the thread the reply is in", async () => {
    const handed: (string | undefined)[] = [];
    const from: string[] = [];
    const run = await runTurn({
      history: [], regen: false, thread: "ring", events: answered,
      tools: ["wake_in_thread"],
      toolRound: [{ type: "tool_use", id: "tool_hand", name: "wake_in_thread", input: { thread: "garden", reason: "Carry on." } }],
      adjust: (generation) => {
        generation.tools = (_character, turn) => {
          handed.push(turn.thread);
          return { wakeInThread: (_name, thread) => { from.push(thread); return { kind: "queued", limitMs: undefined }; } };
        };
      },
    });
    expect(run.error).toBeUndefined();
    expect(handed).toEqual(["ring"]);
    expect(from).toEqual(["ring"]);
  });

  test("a round its first key started before refusing the call is not kept when the spare key answers", async () => {
    let calls = 0;
    const run = await runTurn({
      history: [], regen: false, events: [], tools: ["read"], twoKeys: true,
      provider: {
        async *stream() {
          yield* [];
          throw new Error("a tool reply streams with its tools");
        },
        generate: () => {
          throw new Error("no turn here generates");
        },
        async *streamWithTools(_request, phase) {
          calls += 1;
          if (calls === 1) {
            await phase.recordTurn("assistant", [{ type: "tool_use", id: "tool_lost", name: "read", input: { file_path: "SOUL.md" } }]);
            throw { kind: "http_status", status: 401, body: "unauthorized" };
          }
          yield* answered;
        },
      },
    });
    expect([run.error, calls]).toEqual([undefined, 2]);
    expect((await readBack(run.dataDir)).map((message) => [message.role, message.content])).toEqual([["user", "Leave me a note"], ["assistant", "Here you go."]]);
  });
});

describe("what a reply checks before it runs and leaves behind after", () => {
  const answered: StreamEvent[] = [
    { type: "start", model: "claude-fixture" },
    { type: "text", text: "Here you go." },
    { type: "done", content: "Here you go.", finish_reason: "end_turn", usage, timing },
  ];
  const question: Message = {
    msg_id: "m_question", role: "user", content: "Leave me a note", images: [],
    content_blocks: [{ type: "text", text: "Leave me a note" }], timestamp: "2025-12-31T10:00:00-05:00",
  };
  const answer: Message = {
    msg_id: "m_answer", role: "assistant", content: "Done.", images: [],
    content_blocks: [{ type: "text", text: "Done." }], timestamp: "2025-12-31T10:00:01-05:00", version: "mv_old",
  };
  const read: ContentBlock[] = [{ type: "tool_use", id: "tool_read", name: "read", input: { file_path: "SOUL.md" } }];
  const NOT_SENT = "chat.fixture does not accept images, so the attachment was not sent. Switch to a vision-capable model and send again.";
  const lamp = async (): Promise<ImageUpload> => ({ filename: "lamp.png", mime_type: "image/png", data: (await sizedImage(8, 8)).toString("base64") });

  test("the one who sent a message is told once it is kept", async () => {
    let told = 0;
    const run = await runTurn({ history: [], regen: false, events: answered, accepted: async () => { told += 1; } });
    expect(run.error).toBeUndefined();
    expect(told).toBe(1);
  });

  test("a model said not to take pictures refuses a message with one before anything is kept, takes a message without, and one said to take them is sent them and told it may be", async () => {
    const refused = await runTurn({ history: [], regen: false, events: answered, takesPictures: false, pictures: [await lamp()] });
    expect(refused.error).toBe(NOT_SENT);
    expect(await readBack(refused.dataDir)).toEqual([]);

    const plain = await runTurn({ history: [], regen: false, events: answered, takesPictures: false });
    expect(plain.error).toBeUndefined();

    const seen: SidecarRequest[] = [];
    const taken = await runTurn({ history: [], regen: false, events: answered, takesPictures: true, pictures: [await lamp()], seen });
    expect(taken.error).toBeUndefined();
    expect(seen.map((request) => request.supports_images)).toEqual([true]);
    expect((await readBack(taken.dataDir)).map((message) => [message.role, message.images.length])).toEqual([["user", 1], ["assistant", 0]]);
  });

  test("a model that turns pictures down when sent one is remembered as taking none, whatever it was said to take, and the sender is told the picture wasn't sent", async () => {
    const turnsDown = (): SidecarProvider => ({
      async *stream() {
        yield* [];
        throw new Error("this model does not support image input");
      },
      generate: () => {
        throw new Error("no turn here generates");
      },
    });
    const learned = (dataDir: string): boolean | undefined => imageSupportFor({ providerKey: "anthropic", modelId: "claude-fixture" }, join(dataDir, "..", "cache"));
    const unknown = await runTurn({ history: [], regen: false, events: [], provider: turnsDown(), pictures: [await lamp()] });
    expect(unknown.error).toBe(NOT_SENT);
    expect(learned(unknown.dataDir)).toBe(false);

    const declared = await runTurn({ history: [], regen: false, events: [], provider: turnsDown(), takesPictures: true, pictures: [await lamp()] });
    expect(declared.error).toBe(NOT_SENT);
  });

  test("a model that turns a picture down while it has its tools is remembered as taking none too", async () => {
    const run = await runTurn({
      history: [], regen: false, events: [], tools: ["read"], pictures: [await lamp()],
      provider: {
        async *stream() {
          yield* [];
          throw new Error("a tool reply streams with its tools");
        },
        generate: () => {
          throw new Error("no turn here generates");
        },
        async *streamWithTools() {
          yield* [];
          throw new Error("this model does not support image input");
        },
      },
    });
    expect(run.error).toBe(NOT_SENT);
    expect(imageSupportFor({ providerKey: "anthropic", modelId: "claude-fixture" }, join(run.dataDir, "..", "cache"))).toBe(false);
  });

  test("once a model is remembered as taking no pictures, its later requests say so", async () => {
    const root = await mkdtemp(testTmp("shore-gen-"));
    const refused = await runTurn({
      root, history: [], regen: false, events: [], pictures: [await lamp()],
      provider: {
        async *stream() {
          yield* [];
          throw new Error("this model does not support image input");
        },
        generate: () => {
          throw new Error("no turn here generates");
        },
      },
    });
    expect(refused.error).toBe(NOT_SENT);

    const seen: SidecarRequest[] = [];
    const later = await runTurn({ root, history: [], regen: false, events: answered, seen });
    expect(later.error).toBeUndefined();
    expect(seen.map((request) => request.supports_images)).toEqual([false]);

    const fresh: SidecarRequest[] = [];
    const never = await runTurn({ history: [], regen: false, events: answered, seen: fresh });
    expect(never.error).toBeUndefined();
    expect(fresh.map((request) => "supports_images" in request)).toEqual([false]);
  });

  test("a reply asked for again says which messages it takes the place of, and isn't taken for the user arriving after a pause", async () => {
    const sent: ServerMessage[] = [];
    let refreshed = 0;
    const run = await runTurn({
      history: [question, answer], regen: true, events: answered, sent,
      adjust: (generation) => { generation.compaction = { ...generation.compaction, applyDeferredEdits: async () => { refreshed += 1; } }; },
    });
    expect(run.error).toBeUndefined();
    expect(sent.flatMap((frame) => frame.type === "stream_start" ? [[frame.regen, frame.replaces]] : [])).toEqual([[true, ["m_answer"]]]);
    expect(refreshed).toBe(0);
  });

  test("a side thread's files are read afresh for a message after a long pause there, and not for a reply asked for to what is already there", async () => {
    const pause = async (history: Message[], text?: string): Promise<number> => {
      let refreshed = 0;
      const run = await runTurn({
        history, regen: false, thread: "ring", events: answered, ...(text === undefined ? {} : { text }),
        adjust: (generation) => { generation.compaction = { ...generation.compaction, applyDeferredEdits: async () => { refreshed += 1; } }; },
      });
      expect(run.error).toBeUndefined();
      return refreshed;
    };
    expect(await pause([question, answer])).toBe(1);
    expect(await pause([question], "")).toBe(0);
  });

  test("a reply stopped while it was using a tool keeps none of the round it was on", async () => {
    const stop = new AbortController();
    const provider: SidecarProvider = {
      async *stream() {
        yield* [];
        throw new Error("a tool reply streams with its tools");
      },
      async *streamWithTools(_request, phase) {
        stop.abort(new Error("stopped by the user"));
        await phase.recordTurn("assistant", read);
        yield* answered;
      },
      generate: () => {
        throw new Error("no turn here generates");
      },
    };
    const run = await runTurn({ history: [], regen: false, events: [], tools: ["read"], provider, signal: stop.signal });
    expect(run.error).toBeDefined();
    expect((await readBack(run.dataDir)).map((message) => message.role)).toEqual(["user"]);
  });

  test("a reply stopped before it was kept isn't kept, even when the model had already answered, and no picture in it is put with the ones sent", async () => {
    const shows: StreamEvent[] = [
      { type: "start", model: "claude-fixture" },
      { type: "text", text: "The lamp: ![[lamp.png]]" },
      { type: "done", content: "The lamp: ![[lamp.png]]", finish_reason: "end_turn", usage, timing },
    ];
    const sent = (dataDir: string): number => existsSync(sentPicturesDir(dataDir, "ada")) ? readdirSync(sentPicturesDir(dataDir, "ada")).length : 0;
    const drawn = async (turns: WorkspaceTurns): Promise<void> => { await writeFile(join(turns.workspace, "lamp.png"), await sizedImage(8, 8)); };

    const kept = await runTurn({ history: [], regen: false, events: shows, seed: drawn });
    expect(kept.error).toBeUndefined();
    expect(sent(kept.dataDir)).toBe(1);

    const stop = new AbortController();
    const run = await runTurn({ history: [], regen: false, events: shows, seed: drawn, signal: stop.signal, during: async () => { stop.abort(new Error("stopped by the user")); } });
    expect(run.error).toBeDefined();
    expect((await readBack(run.dataDir)).map((message) => message.role)).toEqual(["user"]);
    expect(sent(run.dataDir)).toBe(0);
  });

  test("what a reply leaves for keeping its cache warm holds the round its tool was called in and the id of the request that asked for it, and the user is told how long the reply took", async () => {
    const kept: Record<string, unknown>[] = [];
    const told: unknown[][] = [];
    let asked = 0;
    const run = await runTurn({
      history: [], regen: false, rid: "r-1", events: answered, tools: ["read"], toolRound: read,
      adjust: (generation) => {
        generation.autonomy = { ...generation.autonomy, notifyLastRequest: (_character, request) => { kept.push(request as unknown as Record<string, unknown>); } };
        generation.notifier = { notifyMessageComplete: (...args: unknown[]) => { told.push(args); } } as unknown as GenerationDeps["notifier"];
        generation.monotonicMs = () => {
          asked += 1;
          return asked === 1 ? 1_000 : 1_700;
        };
      },
    });
    expect(run.error).toBeUndefined();
    expect(kept.map((request) => request["rid"])).toEqual(["r-1"]);
    const sentOn = kept[0]?.["messages"] as { role: string; content: { type: string }[] }[];
    expect(sentOn.map((message) => [message.role, message.content.map((block) => block.type)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["tool_use"]],
      ["assistant", ["text"]],
    ]);
    expect(told.map((args) => args[2])).toEqual([700]);
  });

  test("a reply whose last frame can't be delivered fails there, kept as it is, before Shore asks whether to compact the thread", async () => {
    let asked = 0;
    const run = await runTurn({
      history: [], regen: false, events: answered,
      send: async (frame) => {
        if (frame.type === "stream_end") throw new Error("the client went away");
      },
      adjust: (generation) => {
        generation.autonomy = { ...generation.autonomy, shouldCompactNow: () => {
          asked += 1;
          return false;
        } };
      },
    });
    expect(run.error).toBe("failed to deliver one or more generation frames");
    expect(asked).toBe(0);
    expect((await readBack(run.dataDir)).map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("after a reply Shore asks whether to compact its thread, unless that thread's compaction is off", async () => {
    const asks = async (compaction: boolean): Promise<number> => {
      let asked = 0;
      const run = await runTurn({
        history: [], regen: false, events: answered,
        adjust: (generation) => {
          generation.autonomy = { ...generation.autonomy, shouldCompactNow: () => {
            asked += 1;
            return false;
          } };
          generation.registry = { ...generation.registry, listThreads: () => [{ id: "main", created_at: "2026-09-03T00:00:00.000Z", compaction }] };
        },
      });
      expect(run.error).toBeUndefined();
      return asked;
    };
    expect([await asks(true), await asks(false)]).toEqual([1, 0]);
  });

  test("a reply that fails with nothing of it kept, after a tool had already changed a file, is over only once Shore has finished looking at what the tool changed", async () => {
    const root = await mkdtemp(testTmp("shore-gen-"));
    const workspace = join(root, "config", "characters", "ada", "workspace");
    const run = CharacterWorkspace.prototype.run.bind(new CharacterWorkspace(workspace));
    const held = Promise.withResolvers<void>();
    let holding = false;
    let running = 0;
    const watched = spyOn(CharacterWorkspace.prototype, "run").mockImplementation(async (command, args, options) => {
      running += 1;
      try {
        if (command === "git" && !holding && existsSync(join(workspace, "note.md"))) {
          holding = true;
          await Promise.race([held.promise, new Promise<void>((resolve) => { setTimeout(resolve, 1_000); })]);
        }
        return await run(command, args, options);
      } finally {
        running -= 1;
      }
    });
    try {
      const failed = await runTurn({
        root, history: [], regen: false, events: [], tools: ["bash"],
        provider: {
          async *stream() {
            yield* [];
            throw new Error("a tool reply streams with its tools");
          },
          generate: () => {
            throw new Error("no turn here generates");
          },
          async *streamWithTools(_request, phase) {
            yield* [];
            await phase.runTool({ id: "tool_write", name: "bash", input: { command: "printf 'half done' > note.md" } });
            throw new Error("provider down");
          },
        },
      });
      expect(failed.error).toContain("provider down");
      expect([holding, running]).toEqual([true, 0]);
      expect(readFileSync(join(workspace, "note.md"), "utf8")).toBe("half done");
      expect((await readBack(failed.dataDir)).map((message) => message.role)).toEqual(["user"]);
    } finally {
      held.resolve();
      await until(() => running === 0, "what Shore was still looking at to finish");
      watched.mockRestore();
    }
  });

  test("a reply that lands puts away what Shore kept to undo a reply that is no longer in the thread", async () => {
    const run = await runTurn({
      history: [question, answer], regen: false, events: answered,
      seed: async (turns) => {
        const recorder = new WorkspaceRecorder(turns);
        await recorder.track(async () => await writeFile(join(turns.workspace, "gone.md"), "from a reply since deleted\n"));
        await recorder.settle("main", "mv_gone");
        expect(await recordedTurns(turns, "main", ["mv_gone"])).toEqual(["mv_gone"]);
      },
    });
    expect(run.error).toBeUndefined();
    const turns = workspaceTurnsFor({ config: join(run.dataDir, "..", "config"), cache: join(run.dataDir, "..", "cache") }, "ada");
    expect(await recordedTurns(turns, "main", ["mv_gone"])).toEqual([]);
  });
});
