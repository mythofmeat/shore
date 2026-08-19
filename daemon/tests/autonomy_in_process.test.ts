import { afterAll, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  compactionGenerate,
  InProcessAutonomyExecutor,
  type InProcessExecutorDeps,
} from "../src/autonomy/in_process.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import type { TickHooks } from "../src/autonomy/runner.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { Ledger } from "../src/ledger/store.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(restoreTestEnv);

const KEY_ENV = "SHORE_INPROC_KEY";
setTestEnv(KEY_ENV, "secret");

const MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: KEY_ENV,
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  maxToolIterations: 3,
} as never;

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

async function world(): Promise<LoadedConfig> {
  const root = await mkdtemp(testTmp("shore-inproc-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  await mkdir(join(dirs.config, "characters", "ada", "workspace", "memory"), { recursive: true });

  const characterDir = join(dirs.data, "ada");
  await mkdir(characterDir, { recursive: true });
  await writeFile(
    join(characterDir, "active.jsonl"),
    [message("user", "m_1", "hi"), message("assistant", "m_2", "hello")]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n",
  );

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", MODEL);

  return { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
}

function response(blocks: ContentBlock[], finishReason = "end_turn"): GenerateResponse {
  return {
    content: blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    content_blocks: blocks,
    finish_reason: finishReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    model: "claude-fixture",
  };
}

function registryFor(config: LoadedConfig, appended: Message[] = []) {
  return {
    effectiveConfig: () => config,
    getOrCreate: async () => ({
      appendMessage: async (msg: Message) => void appended.push(msg),
      currentRevision: () => 3,
    }),
  } as unknown as InProcessExecutorDeps["registry"];
}

function scriptedProvider(rounds: GenerateResponse[], seen: SidecarRequest[] = []): SidecarProvider {
  let round = 0;
  return {
    generate: async (req: SidecarRequest) => {
      seen.push(JSON.parse(JSON.stringify(req)) as SidecarRequest);
      const next = rounds[round++];
      if (next === undefined) throw { kind: "provider", message: "out of scripted rounds" };
      return next;
    },
    stream: () => {
      throw new Error("not used");
    },
  } as unknown as SidecarProvider;
}

const NO_HOOKS: TickHooks = { scheduleNextWake: () => 1 };

function cachedChatRequest(): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "discovered-opus",
    api_key: "",
    provider_key: "anthropic",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 1024,
    replay_prior_thinking: "off",
  } as unknown as SidecarRequest;
}

describe("running a heartbeat", () => {
  test("a tick on the cached chat request calls the provider with a key", async () => {
    const config = await world();
    config.providers = ProviderRegistry.fromSection({
      anthropic: { api_key_env: KEY_ENV },
    });
    const cache = new LastRequestCache();
    cache.set("ada", cachedChatRequest(), undefined);

    const seen: SidecarRequest[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache,
      providers: {
        anthropic: scriptedProvider([response([{ type: "text", text: "quiet tick" }])], seen),
      },
      env: { [KEY_ENV]: "secret" },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    expect(seen.length).toBe(1);
    expect(seen[0]?.model).toBe("discovered-opus");
    expect(seen[0]?.api_key).toBe("secret");
  });

  test("delivers what the tick asked to say", async () => {
    const config = await world();
    const appended: Message[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config, appended),
      cache: new LastRequestCache(),
      providers: {
        anthropic: scriptedProvider([
          response([{ type: "text", text: "<sendMessage>the tide is out</sendMessage>" }]),
        ]),
      },
    });

    const result = await executor.runHeartbeatTick("ada", NO_HOOKS);

    expect(appended.length).toBe(1);
    expect(appended[0]?.content).toBe("the tide is out");
    expect(result.events).toEqual([
      { kind: "message_sent", detail: "Autonomous message sent: the tide is out" },
    ]);
  });

  test("labels the ledger context per round", async () => {
    const config = await world();
    const seen: SidecarRequest[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: {
        anthropic: scriptedProvider(
          [
            response(
              [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.md" } } as ContentBlock],
              "tool_use",
            ),
            response([{ type: "text", text: "done" }]),
          ],
          seen,
        ),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    expect(seen.map((r) => r.context?.call_type)).toEqual(["heartbeat", "heartbeat_tool_loop"]);
    expect(seen.every((r) => r.context?.character === "ada")).toBe(true);
  });

  test("set_next_wake goes to the runner's clock and quotes what it got", async () => {
    const config = await world();
    const asked: { hours: number; reason: string }[] = [];
    const seen: SidecarRequest[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: {
        anthropic: scriptedProvider(
          [
            response(
              [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "set_next_wake",
                  input: { hours_from_now: 900, reason: "the essay" },
                } as ContentBlock,
              ],
              "tool_use",
            ),
            response([{ type: "text", text: "ok" }]),
          ],
          seen,
        ),
      },
    });

    await executor.runHeartbeatTick("ada", {
      scheduleNextWake: (hours, reason) => {
        asked.push({ hours, reason });
        return Math.min(hours, 48);
      },
    });

    expect(asked).toEqual([{ hours: 900, reason: "the essay" }]);
    const results = seen[1]?.messages.at(-1)?.content ?? [];
    const output = (results[0] as { content: string }).content;
    expect(output).toBe("Scheduled next moment in 48.0 hours.");
  });

  test("a failed model call ends the tick without throwing, and is logged as a failure", async () => {
    const config = await world();
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: { anthropic: scriptedProvider([]) },
    });

    const result = await executor.runHeartbeatTick("ada", NO_HOOKS);

    expect(result.events.length).toBe(1);
    expect(result.events[0]?.kind).toBe("call_failed");
    expect(result.failed).toBeUndefined();
  });

  test("a tool that fails is reported to the model as an error, not a success", async () => {
    const config = await world();
    const rows: { entry_json: string }[] = [];
    const seen: SidecarRequest[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      callStore: { recordTranscript: (r) => (rows.push(r as never), 1) },
      providers: {
        anthropic: scriptedProvider(
          [
            response(
              [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "read",
                  input: { path: "../../etc/passwd" },
                } as ContentBlock,
              ],
              "tool_use",
            ),
            response([{ type: "text", text: "ah" }]),
          ],
          seen,
        ),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    const results = seen[1]?.messages.at(-1)?.content ?? [];
    expect(results[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(JSON.parse(rows[0]?.entry_json ?? "{}").tool_calls[0].is_error).toBe(true);
  });

  test("an image the tick generated rides out on the message it sends", async () => {
    const config = await world();
    const appended: Message[] = [];
    config.app.defaults.image_generation = "anthropic:img-fixture";
    config.models.imageGeneration.set("anthropic:img-fixture", {
      providerKey: "anthropic",
      modelId: "img-fixture",
      apiKeyEnv: KEY_ENV,
      size: "1024x1024",
    } as never);
    config.providers = ProviderRegistry.fromSection({
      anthropic: { api_key_env: KEY_ENV },
    });
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config, appended),
      cache: new LastRequestCache(),
      tools: {
        imageGenerator: (async () => ({
          url: "data:image/png;base64,iVBORw0KGgo=",
          timing: { total_ms: 1, time_to_first_token_ms: 1 },
        })) as never,
      },
      providers: {
        anthropic: scriptedProvider([
          response(
            [
              {
                type: "tool_use",
                id: "t1",
                name: "generate_image",
                input: { prompt: "a boat" },
              } as ContentBlock,
            ],
            "tool_use",
          ),
          response([{ type: "text", text: "<sendMessage>made you this</sendMessage>" }]),
        ]),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    expect(appended.length).toBe(1);
    expect(appended[0]?.images.length).toBe(1);
    expect(appended[0]?.images[0]?.path).toContain("generated");
  });

  test("the cached body's ledger path survives into every round", async () => {
    const config = await world();
    const cache = new LastRequestCache();
    const seen: SidecarRequest[] = [];
    const ledgerPath = join(config.dirs.data, "cached-ledger.db");
    Ledger.create(ledgerPath).close();
    cache.set("ada", {
      sdk: "anthropic",
      model: "claude-fixture",
      api_key: "secret",
      provider_key: "anthropic",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 1024,
      replay_prior_thinking: "off",
      context: {
        ledger: ledgerPath,
        character: "ada",
        call_type: "message",
        thinking_enabled: false,
      },
    } as never, undefined);

    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache,
      providers: {
        anthropic: scriptedProvider([response([{ type: "text", text: "ok" }])], seen),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    expect(seen[0]?.context?.ledger).toBe(ledgerPath);
    expect(seen[0]?.context?.call_type).toBe("heartbeat");
  });

  test("writes one transcript row per round", async () => {
    const config = await world();
    const rows: { call_type?: string | null }[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      callStore: { recordTranscript: (r) => (rows.push(r), 1) },
      providers: {
        anthropic: scriptedProvider([
          response(
            [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.md" } } as ContentBlock],
            "tool_use",
          ),
          response([{ type: "text", text: "done" }]),
        ]),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    expect(rows.map((r) => r.call_type)).toEqual(["heartbeat", "heartbeat_tool_loop"]);
  });
});

describe("the other two actions", () => {
  test("a compaction call cannot shed its ledger and budget labels", async () => {
    const config = await world();
    config.app.usage.budgets.push({
      name: "monthly",
      period: "month",
      cost_usd: 100,
      limit: "block",
    } as never);
    Ledger.create(join(config.dirs.data, "ledger.db")).close();
    const seen: SidecarRequest[] = [];
    const send = compactionGenerate({
      config,
      providers: {
        anthropic: scriptedProvider([response([{ type: "text", text: "done" }])], seen),
      },
    });
    const request: SidecarRequest = {
      sdk: "anthropic",
      provider_key: "anthropic",
      model: "claude-fixture",
      api_key: "",
      messages: [{ role: "user", content: [{ type: "text", text: "compact" }] }],
      max_tokens: 100,
      replay_prior_thinking: "all",
      provider_options: { thinking_enabled: true, cache_ttl: "1h" },
    };

    await send(request, { provider_key: "anthropic", api_key_env: KEY_ENV }, "ada");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.context).toMatchObject({
      ledger: join(config.dirs.data, "ledger.db"),
      character: "ada",
      call_type: "compaction",
      thinking_enabled: true,
      cache_ttl: "1h",
    });
    expect(seen[0]?.context?.usage?.budgets?.[0]?.name).toBe("monthly");
  });

  function executorFor(
    config: LoadedConfig,
    notifications: {
      notifyAutonomousMessage?: (title: string, body: string) => void;
      notifyCompactionComplete?: (title: string, body: string) => void;
    } = {},
  ): InProcessAutonomyExecutor {
    return new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: { anthropic: scriptedProvider([]) },
      ...notifications,
    });
  }

  test("a max_turns compaction is refused rather than run twice", async () => {
    const result = await executorFor(await world()).runCompaction("ada", "max_turns");

    expect(result.failed).toContain("not the autonomy loop's to run");
    expect(result.events).toEqual([]);
  });

  test("an idle compaction is this executor's to run", async () => {
    const result = await executorFor(await world()).runCompaction("ada", "idle");

    expect(result.failed).not.toContain("not the autonomy loop's to run");
  });

  test("the deep archive takes the coverage count it is given", async () => {
    const result = await executorFor(await world()).runDeepArchive("ada", 1);

    expect(result.failed).toBeUndefined();
    expect(result.deepArchiveDone).toBe(true);
  });

  test("the deep archive notifies as a compaction, not as an autonomous message", async () => {
    const spoke: string[] = [];
    const compacted: string[] = [];
    await executorFor(await world(), {
      notifyAutonomousMessage: (title) => spoke.push(title),
      notifyCompactionComplete: (title) => compacted.push(title),
    }).runDeepArchive("ada", 1);

    expect(compacted).toEqual(["Shore — ada"]);
    expect(spoke).toEqual([]);
  });
});
