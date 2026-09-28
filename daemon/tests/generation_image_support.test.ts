import { writeDurable } from "../src/storage/files.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { recordImageRejection } from "../src/llm/image_support.ts";
import {
  generationEngine,
  runGeneration,
  type GenerationDeps,
} from "../src/handler/generation.ts";
import { ImagesUnsupportedError } from "../src/handler/setup.ts";
import type { TurnAutonomy } from "../src/handler/turn.ts";

afterAll(restoreTestEnv);

const MODEL_KEY_ENV = "SHORE_IMAGE_FIXTURE_KEY";
const NOW = "2026-08-16T05:54:32.000Z";

const DONE: StreamEvent[] = [
  { type: "start", model: "glm-5.3" },
  { type: "text", text: "ok" },
  {
    type: "done",
    content: "ok",
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  },
];

function model(supportsImages: boolean | undefined): ResolvedModel {
  return {
    name: "fixture",
    qualifiedName: "chat.fixture",
    category: "chat",
    providerKey: "opencode-go",
    sdk: "anthropic",
    modelId: "glm-5.3",
    apiKeyEnv: MODEL_KEY_ENV,
    maxContextTokens: 200_000,
    maxOutputTokens: 4096,
    ...(supportsImages === undefined ? {} : { supportsImages }),
  };
}

async function loadedConfig(root: string, supportsImages: boolean | undefined): Promise<LoadedConfig> {
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const app: AppConfig = defaultAppConfig();
  app.tools.enabled_tools = [];
  const models = emptyCatalog();
  models.chat.set("chat.fixture", model(supportsImages));
  app.defaults.model = "fixture";

  return { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
}

interface RunOutcome {
  requests: SidecarRequest[];
  error: unknown;
  history: readonly Message[];
  cacheDir: string;
}

interface RunInputs {
  supportsImages?: boolean | undefined;
  history?: Message[];
  text: string;
  imagePaths?: string[];
  learnRejection?: boolean;
  streamThrows?: unknown;
}

async function run(inputs: RunInputs): Promise<RunOutcome> {
  const root = await mkdtemp(testTmp("shore-imgsup-"));
  const config = await loadedConfig(root, inputs.supportsImages);
  setTestEnv(MODEL_KEY_ENV, "fixture-key");

  await mkdir(join(config.dirs.config, "characters", "ada", "workspace"), { recursive: true });
  await writeFile(join(config.dirs.config, "characters", "ada", "workspace", "SOUL.md"), "ada");
  const charDir = join(config.dirs.data, "ada");
  await mkdir(join(charDir, "threads", "main"), { recursive: true });

  if (inputs.learnRejection === true) {
    recordImageRejection(config.dirs.cache, "opencode-go", "glm-5.3");
  }

  const history = inputs.history ?? [];
  if (history.length > 0) {
    writeDurable(join(charDir, "threads", "main", "active.jsonl"), history.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }

  const requests: SidecarRequest[] = [];
  const provider: SidecarProvider = {
    async *stream(req) {
      requests.push(req);
      if (inputs.streamThrows !== undefined) throw inputs.streamThrows;
      yield* DONE;
    },
    generate: () => {
      throw new Error("unused");
    },
  };

  const autonomy: TurnAutonomy & GenerationDeps["autonomy"] = {
    ensureState: () => false,
    needsActivityBackfill: () => false,
    backfillActivity: () => {},
    onUserMessage: () => {},
    shouldCompactNow: () => false,
    onCompactionComplete: () => {},
    onCompactionFailed: () => {},
    notifyLastRequest: () => {},
    notifyAssistantMessage: () => {},
  };

  const engine = generationEngine(
    await ConversationEngine.load("ada", config.dirs.data, undefined),
  );

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
    emitEvent: () => {},
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => ({ kind: "completed", retained: 0 }), applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
    newlyCrossedPlanLimitWarnings: async () => [],
    now: () => NOW,
    newMessageId: () => `m_${crypto.randomUUID()}`,
    monotonicMs: () => 0,
    sleep: async () => {},
  };

  const sent: ServerMessage[] = [];
  let error: unknown;
  try {
    await runGeneration(deps, {
      meta: {
        session: {
          clientId: 1,
          sessionId: 1,
          clientType: "test",
          clientName: "test",
          capabilities: ["streaming"],
          selectedCharacter: "ada",
        },
        rid: null,
        kind: "message",
      } as never,
      body: {
        rid: null,
        text: inputs.text,
        stream: true,
        images: inputs.imagePaths ?? [],
        image_data: await Promise.all((inputs.imagePaths ?? []).map(async (path) => ({ filename: basename(path), data: (await readFile(path)).toString("base64") }))),
      },
      regen: false,
      charName: "ada",
      rid: null,
      send: async (m) => {
        sent.push(m);
      },
      signal: new AbortController().signal,
    });
  } catch (e) {
    error = e;
  }

  return {
    requests,
    error,
    history: (await ConversationEngine.load("ada", config.dirs.data, undefined)).messages(),
    cacheDir: config.dirs.cache,
  };
}

async function pngAt(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, Buffer.from("89504e470d0a1a0a", "hex"));
  return path;
}

function userTurnWithImage(): Message {
  return {
    msg_id: "m_old",
    role: "user",
    content: "look at this",
    images: [],
    content_blocks: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "look at this" },
    ],
    alternatives: [],
    timestamp: "2026-08-16T05:40:00.000Z",
  };
}

function assistantTurn(): Message {
  return {
    msg_id: "m_reply",
    role: "assistant",
    content: "sure",
    images: [],
    content_blocks: [{ type: "text", text: "sure" }],
    alternatives: [],
    timestamp: "2026-08-16T05:41:00.000Z",
  };
}

function imageBlocksIn(request: SidecarRequest | undefined): number {
  if (request === undefined) return 0;
  let n = 0;
  for (const m of request.messages) {
    for (const b of m.content) if (b.type === "image") n += 1;
  }
  return n;
}

describe("sending new images to a model that cannot read them", () => {
  test("the turn is refused before anything reaches the provider", async () => {
    const dir = await mkdtemp(testTmp("shore-img-"));
    const out = await run({
      supportsImages: false,
      text: "what is this",
      imagePaths: [await pngAt(dir, "a.png")],
    });

    expect(out.error).toBeInstanceOf(ImagesUnsupportedError);
    expect(out.requests).toHaveLength(0);
  });

  test("the refusal names the model and says what to do", async () => {
    const dir = await mkdtemp(testTmp("shore-img-"));
    const out = await run({
      supportsImages: false,
      text: "what is this",
      imagePaths: [await pngAt(dir, "a.png"), await pngAt(dir, "b.png")],
    });

    const message = (out.error as Error).message;
    expect(message).toContain("chat.fixture");
    expect(message).toContain("2 attachments");
    expect(message).toContain("vision-capable");
  });

  test("the unsent turn is not left in history", async () => {
    const dir = await mkdtemp(testTmp("shore-img-"));
    const out = await run({
      supportsImages: false,
      text: "what is this",
      imagePaths: [await pngAt(dir, "a.png")],
    });

    expect(out.history).toHaveLength(0);
  });

  test("what shore learned from an earlier refusal refuses the next one too", async () => {
    const dir = await mkdtemp(testTmp("shore-img-"));
    const out = await run({
      learnRejection: true,
      text: "what is this",
      imagePaths: [await pngAt(dir, "a.png")],
    });

    expect(out.error).toBeInstanceOf(ImagesUnsupportedError);
    expect(out.requests).toHaveLength(0);
  });

  test("a vision-capable model takes them", async () => {
    const dir = await mkdtemp(testTmp("shore-img-"));
    const out = await run({
      supportsImages: true,
      text: "what is this",
      imagePaths: [await pngAt(dir, "a.png")],
    });

    expect(out.error).toBeUndefined();
    expect(imageBlocksIn(out.requests[0])).toBe(1);
  });

  test("an unknown model is still tried rather than pre-emptively refused", async () => {
    const dir = await mkdtemp(testTmp("shore-img-"));
    const out = await run({
      text: "what is this",
      imagePaths: [await pngAt(dir, "a.png")],
    });

    expect(out.error).toBeUndefined();
    expect(imageBlocksIn(out.requests[0])).toBe(1);
  });
});

describe("switching to a text-only model after images are already in history", () => {
  test("the old images are dropped instead of failing the turn", async () => {
    const out = await run({
      supportsImages: false,
      history: [userTurnWithImage(), assistantTurn()],
      text: "still there?",
    });

    expect(out.error).toBeUndefined();
    expect(out.requests).toHaveLength(1);
    expect(imageBlocksIn(out.requests[0])).toBe(0);
  });

  test("a notice stands in for each dropped image", async () => {
    const out = await run({
      supportsImages: false,
      history: [userTurnWithImage(), assistantTurn()],
      text: "still there?",
    });

    const text = JSON.stringify(out.requests[0]?.messages);
    expect(text).toContain("image omitted");
    expect(text).toContain("opencode-go/glm-5.3 does not accept images");
    expect(text).toContain("look at this");
  });

  test("a vision-capable model keeps them", async () => {
    const out = await run({
      supportsImages: true,
      history: [userTurnWithImage(), assistantTurn()],
      text: "still there?",
    });

    expect(imageBlocksIn(out.requests[0])).toBe(1);
  });
});

describe("a provider that refuses images shore thought were fine", () => {
  test("the refusal is remembered so the next turn does not repeat it", async () => {
    const dir = await mkdtemp(testTmp("shore-img-"));
    const out = await run({
      text: "what is this",
      imagePaths: [await pngAt(dir, "a.png")],
      streamThrows: {
        kind: "http_status",
        status: 400,
        body: `{"error":{"code":"1210","message":"messages.content.type is invalid, allowed values: ['text']"}}`,
      },
    });

    expect(out.error).toBeInstanceOf(ImagesUnsupportedError);
    expect(
      JSON.parse(
        await Bun.file(
          join(out.cacheDir, "providers", "opencode-go", "image_support.json"),
        ).text(),
      ),
    ).toEqual({ version: 1, models: { "glm-5.3": false } });
  });

  test("an unrelated failure teaches shore nothing", async () => {
    const dir = await mkdtemp(testTmp("shore-img-"));
    const out = await run({
      text: "what is this",
      imagePaths: [await pngAt(dir, "a.png")],
      streamThrows: new Error("rate limit exceeded"),
    });

    expect(out.error).not.toBeInstanceOf(ImagesUnsupportedError);
    expect(
      await Bun.file(join(out.cacheDir, "providers", "opencode-go", "image_support.json")).exists(),
    ).toBe(false);
  });
});
