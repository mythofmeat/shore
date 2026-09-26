import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { fakeAgent } from "../src/testing/fake_agent_query.ts";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  compactionGenerate,
  InProcessAutonomyExecutor,
  type InProcessExecutorDeps,
} from "../src/autonomy/in_process.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { rebuildRequestFromDisk } from "../src/cache/rebuild.ts";
import type { TickHooks } from "../src/autonomy/runner.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { Ledger } from "../src/ledger/store.ts";
import { testTmp } from "./support/tmp.ts";
import { eventsForResponse } from "./support/stream.ts";
import { interpretResult } from "../src/mcp/client.ts";
import { carryToolMedia } from "../src/tools/media.ts";

beforeEach(() => {
  setTestEnv(KEY_ENV, "secret");
});

afterAll(restoreTestEnv);

const KEY_ENV = "SHORE_INPROC_KEY";

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
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), [message("user", "m_1", "hi"), message("assistant", "m_2", "hello")]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n");

  const app = defaultAppConfig();
  app.tools.enabled_tools = ["bash", "read", "edit", "apply_patch", "generate_image", "mcp__*"];
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  const models = emptyCatalog();
  models.chat.set("chat.fixture", structuredClone(MODEL));

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
  const nextTurn = (req: SidecarRequest): GenerateResponse => {
    seen.push(JSON.parse(JSON.stringify(req)) as SidecarRequest);
    const next = rounds[round++];
    if (next === undefined) throw { kind: "provider", message: "out of scripted rounds" };
    return next;
  };
  return {
    generate: (req: SidecarRequest) => Promise.resolve(nextTurn(req)),
    stream: (req: SidecarRequest) => eventsForResponse(nextTurn(req)),
  };
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
  test("a tick uses the home model and provider key despite a cached side model", async () => {
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
    expect(seen[0]?.model).toBe("claude-fixture");
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

  test("a cold-cache tick advertises enabled MCP tools", async () => {
    const config = await world();
    config.app.tools.enabled_tools = ["mcp__notes__search"];
    const seen: SidecarRequest[] = [];
    const filteredBy: string[][] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: {
        anthropic: scriptedProvider([response([{ type: "text", text: "quiet tick" }])], seen),
      },
      rebuild: {
        mcpRegistry: {
          toolDefsFiltered: (patterns) => {
            filteredBy.push([...patterns]);
            return [
              {
                name: "mcp__notes__search",
                description: "search notes",
                input_schema: { type: "object", properties: {} },
              },
            ];
          },
        },
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    expect(filteredBy).toEqual([["mcp__notes__search"]]);
    expect(seen[0]?.tools?.map((tool) => tool.name)).toContain("mcp__notes__search");
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
              [{ type: "tool_use", id: "t1", name: "bash", input: { command: "cat a.md" } }],
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

  test("a tool's media payload is attached the way chat attaches it", async () => {
    const config = await world();
    const seen: SidecarRequest[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      rebuild: { mcpRegistry: { toolDefsFiltered: () => ["shot", "slow"].map((name) => ({ name: `mcp__srv__${name}`, description: "fixture", input_schema: { type: "object" } })) } },
      tools: {
        mcpRegistry: {
          call: () =>
            Promise.resolve(
              carryToolMedia(
                interpretResult({
                  content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
                }),
              ),
            ),
        },
      },
      providers: {
        anthropic: scriptedProvider(
          [
            response(
              [{ type: "tool_use", id: "t1", name: "mcp__srv__shot", input: {} }],
              "tool_use",
            ),
            response([{ type: "text", text: "done" }]),
          ],
          seen,
        ),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    const results = (seen[1]?.messages ?? [])
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(1);

    const content = results[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as ContentBlock[];
    expect(blocks[0]?.type).toBe("text");
    expect((blocks[0] as { text: string }).text).toContain("[image/png, 5 bytes attached, saved to");
    expect(blocks[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
  });

  test("a heartbeat tool obeys the configured deadline, as chat does", async () => {
    const config = await world();
    config.app.tools.timeout = ConfigDuration.fromMillis(40);
    const seen: SidecarRequest[] = [];
    let released = false;

    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      rebuild: { mcpRegistry: { toolDefsFiltered: () => ["shot", "slow"].map((name) => ({ name: `mcp__srv__${name}`, description: "fixture", input_schema: { type: "object" } })) } },
      tools: {
        mcpRegistry: {
          call: async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, 5_000);
            });
            released = true;
            return interpretResult({ content: [{ type: "text", text: "too late" }] });
          },
        },
      },
      providers: {
        anthropic: scriptedProvider(
          [
            response(
              [{ type: "tool_use", id: "t1", name: "mcp__srv__slow", input: {} }],
              "tool_use",
            ),
            response([{ type: "text", text: "done" }]),
          ],
          seen,
        ),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    const results = (seen[1]?.messages ?? [])
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(String((results[0] as { content: unknown }).content)).toContain("timed out");
    expect(released).toBe(false);
  });

  test("a heartbeat tool call with bad arguments is rejected before it runs", async () => {
    const config = await world();
    config.app.tools.enabled_tools = ["web_search"];
    const seen: SidecarRequest[] = [];

    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: {
        anthropic: scriptedProvider(
          [
            response(
              [{ type: "tool_use", id: "t1", name: "web_search", input: { query: 7 } }],
              "tool_use",
            ),
            response([{ type: "text", text: "done" }]),
          ],
          seen,
        ),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    const results = (seen[1]?.messages ?? [])
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result");
    expect(results[0]).toMatchObject({ is_error: true });
    expect(String((results[0] as { content: unknown }).content)).toContain(
      "was not run because",
    );
    expect(String((results[0] as { content: unknown }).content)).toContain(
      "Nothing was executed and no state changed",
    );
  });

  test("set_next_wake goes to the runner's clock and quotes what it got", async () => {
    const config = await world();
    config.app.tools.enabled_tools.push("set_next_wake");
    config.app.behavior.autonomy.enabled = true;
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
                },
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

  test("set_next_wake left off the allowlist is refused, and the clock stays put", async () => {
    const config = await world();
    config.app.behavior.autonomy.enabled = true;
    const asked: number[] = [];
    const seen: SidecarRequest[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: {
        anthropic: scriptedProvider(
          [
            response(
              [{ type: "tool_use", id: "t1", name: "set_next_wake", input: { hours_from_now: 6, reason: "the essay" } }],
              "tool_use",
            ),
            response([{ type: "text", text: "ok" }]),
          ],
          seen,
        ),
      },
    });

    await executor.runHeartbeatTick("ada", {
      scheduleNextWake: (hours) => {
        asked.push(hours);
        return hours;
      },
    });

    expect(seen[0]?.tools?.map((tool) => tool.name)).not.toContain("set_next_wake");
    expect(asked).toEqual([]);
    expect((seen[1]?.messages.at(-1)?.content ?? [])[0]).toMatchObject({ is_error: true });
  });

  test("a tick declares exactly the tools a chat turn would, and nothing heartbeat-only", async () => {
    const config = await world();
    config.app.tools.enabled_tools.push("set_next_wake");
    config.app.behavior.autonomy.enabled = true;
    const seen: SidecarRequest[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: {
        anthropic: scriptedProvider([response([{ type: "text", text: "HEARTBEAT_OK" }])], seen),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    const chat = await rebuildRequestFromDisk("ada", config.dirs.data, config, { thread: "main" });
    expect(chat?.request.tools?.map((tool) => tool.name)).toContain("set_next_wake");
    expect(seen[0]?.tools).toEqual(chat?.request.tools);
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
      callStore: {
        recordTranscript: (r) => {
          rows.push(r);
          return 1;
        },
      },
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
                },
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
    const entry = JSON.parse(rows[0]?.entry_json ?? "{}") as {
      tool_calls: { is_error: boolean }[];
    };
    expect(entry.tool_calls[0]?.is_error).toBe(true);
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
              },
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

  test("the configured ledger replaces the cached ledger for a heartbeat", async () => {
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

    expect(seen[0]?.context?.ledger).toBe(join(config.dirs.data, "shore.db"));
    expect(seen[0]?.context?.call_type).toBe("heartbeat");
  });

  test("writes one transcript row per round", async () => {
    const config = await world();
    const rows: { call_type?: string | null }[] = [];
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      callStore: {
        recordTranscript: (r) => {
          rows.push(r);
          return 1;
        },
      },
      providers: {
        anthropic: scriptedProvider([
          response(
            [{ type: "tool_use", id: "t1", name: "bash", input: { command: "cat a.md" } }],
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
    Ledger.create(join(config.dirs.data, "shore.db")).close();
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
      ledger: join(config.dirs.data, "shore.db"),
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

    expect(compacted).toEqual(["Shore - ada"]);
    expect(spoke).toEqual([]);
  });
});


test("Claude SDK heartbeats execute workspace tools, schedule a wake, and deliver a message", async () => {
  const config = await world();
  const model = config.models.chat.get("chat.fixture");
  if (model === undefined) throw new Error("missing fixture model");
  model.sdk = "claude_agent";
  model.providerKey = "claude-agent";
  config.app.tools.enabled_tools = ["bash", "set_next_wake"];
  config.app.behavior.autonomy.enabled = true;
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await writeFile(join(workspace, "HEARTBEAT.md"), "Before");
  const agent = fakeAgent({
    rounds: [
      { blocks: [], toolCalls: [{ name: "bash", input: { command: "cat HEARTBEAT.md" } }] },
      { blocks: [], toolCalls: [{ name: "bash", input: { command: "mkdir -p . && printf %s After > HEARTBEAT.md" } }] },
      { blocks: [], toolCalls: [{ name: "set_next_wake", input: { hours_from_now: 2, reason: "follow up" } }] },
      { blocks: [{ kind: "text", text: "<sendMessage>I updated my notes.</sendMessage>" }] },
    ],
  });
  const appended: Message[] = [];
  const wakes: [number, string][] = [];
  const transcripts: unknown[] = [];
  const executor = new InProcessAutonomyExecutor({
    registry: registryFor(config, appended),
    cache: new LastRequestCache(),
    providers: {
      claude_agent: new ClaudeAgentProvider({
        runQuery: agent.query,
        bookPath: () => join(config.dirs.data, "sdk-sessions.json"),
      }),
    },
    callStore: { recordTranscript: (entry) => transcripts.push(entry) },
  });
  const result = await executor.runHeartbeatTick("ada", {
    scheduleNextWake: (hours, reason) => { wakes.push([hours, reason]); return hours; },
  });
  expect(agent.calls).toHaveLength(1);
  expect(agent.toolOutcomes.map((outcome) => outcome.allowed)).toEqual([true, true, true]);
  expect(await readFile(join(workspace, "HEARTBEAT.md"), "utf8")).toBe("After");
  expect(wakes).toEqual([[2, "follow up"]]);
  expect(appended.map((entry) => entry.content)).toEqual(["I updated my notes."]);
  expect(transcripts).toHaveLength(4);
  expect(result.events.some((event) => event.kind === "message_sent")).toBe(true);
});

test("an SDK heartbeat cannot move the clock when set_next_wake is left off the allowlist", async () => {
  const config = await world();
  const model = config.models.chat.get("chat.fixture");
  if (model === undefined) throw new Error("missing fixture model");
  model.sdk = "claude_agent";
  model.providerKey = "claude-agent";
  config.app.tools.enabled_tools = ["bash"];
  config.app.behavior.autonomy.enabled = true;
  const agent = fakeAgent({
    rounds: [
      { blocks: [], toolCalls: [{ name: "set_next_wake", input: { hours_from_now: 2, reason: "later" } }] },
      { blocks: [{ kind: "text", text: "HEARTBEAT_OK" }] },
    ],
  });
  const wakes: number[] = [];
  const executor = new InProcessAutonomyExecutor({
    registry: registryFor(config),
    cache: new LastRequestCache(),
    providers: {
      claude_agent: new ClaudeAgentProvider({
        runQuery: agent.query,
        bookPath: () => join(config.dirs.data, "sdk-sessions.json"),
      }),
    },
  });
  await executor.runHeartbeatTick("ada", {
    scheduleNextWake: (hours) => { wakes.push(hours); return hours; },
  });
  expect(wakes).toEqual([]);
  expect(agent.toolOutcomes.some((outcome) => outcome.allowed && outcome.isError !== true)).toBe(false);
});

test.each([false, true])("SDK heartbeat preserves completed work on SDK failure (stream throws: %s)", async (streamThrows) => {
  const config = await world();
  const model = config.models.chat.get("chat.fixture");
  if (model === undefined) throw new Error("missing fixture model");
  model.sdk = "claude_agent";
  model.providerKey = "claude-agent";
  config.app.tools.enabled_tools = ["bash"];
  const agent = fakeAgent({
    rounds: [
      {
        blocks: [{ kind: "text", text: "<sendMessage>Still here.</sendMessage>" }],
        toolCalls: [{ name: "bash", input: { command: "cat missing-file.md" } }],
      },
      ...(streamThrows ? [] : [{ blocks: [{ kind: "text" as const, text: "HEARTBEAT_OK" }] }]),
    ],
    ...(streamThrows ? { throwOn: new Error("SDK disconnected") } : { subtype: "error_max_turns" }),
  });
  const appended: Message[] = [];
  const executor = new InProcessAutonomyExecutor({
    registry: registryFor(config, appended),
    cache: new LastRequestCache(),
    providers: {
      claude_agent: new ClaudeAgentProvider({
        runQuery: agent.query,
        bookPath: () => join(config.dirs.data, "sdk-sessions.json"),
      }),
    },
  });
  const result = await executor.runHeartbeatTick("ada", NO_HOOKS);
  expect(agent.toolOutcomes[0]?.allowed).toBe(true);
  expect(agent.toolOutcomes[0]?.isError).toBe(true);
  expect(appended.map((entry) => entry.content)).toEqual(["Still here."]);
  expect(result.events.some((event) => event.kind === "call_failed")).toBe(true);
  expect(result.events.some((event) => event.kind === "message_skipped")).toBe(false);
});

test("SDK heartbeat respects the configured tool round budget", async () => {
  const config = await world();
  const model = config.models.chat.get("chat.fixture");
  if (model === undefined) throw new Error("missing fixture model");
  model.sdk = "claude_agent";
  model.providerKey = "claude-agent";
  model.maxToolIterations = 1;
  config.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds = 0;
  config.app.tools.enabled_tools.push("set_next_wake");
  config.app.behavior.autonomy.enabled = true;
  const agent = fakeAgent({
    rounds: [
      { blocks: [], toolCalls: [{ name: "set_next_wake", input: { hours_from_now: 2, reason: "first" } }] },
      { blocks: [], toolCalls: [{ name: "set_next_wake", input: { hours_from_now: 3, reason: "denied" } }] },
      { blocks: [{ kind: "text", text: "HEARTBEAT_OK" }] },
    ],
  });
  const appended: Message[] = [];
  const wakes: number[] = [];
  const executor = new InProcessAutonomyExecutor({
    registry: registryFor(config, appended),
    cache: new LastRequestCache(),
    providers: {
      claude_agent: new ClaudeAgentProvider({
        runQuery: agent.query,
        bookPath: () => join(config.dirs.data, "sdk-sessions.json"),
      }),
    },
  });
  await executor.runHeartbeatTick("ada", {
    scheduleNextWake: (hours) => { wakes.push(hours); return hours; },
  });
  expect(wakes).toEqual([2]);
  expect(agent.toolOutcomes.map((outcome) => outcome.allowed)).toEqual([true]);
  expect(appended).toHaveLength(0);
});

test.each([false, true])("SDK compaction preserves writes across a paused run (%s)", async (pause) => {
  const { runCompactionPass } = await import("../src/memory/compaction/run.ts");
  const { HistoryStore, HISTORY_DB_FILE } = await import("../src/engine/history_store.ts");
  const config = await world();
  const model = config.models.chat.get("chat.fixture");
  if (model === undefined) throw new Error("missing fixture model");
  model.sdk = "claude_agent";
  model.providerKey = "claude-agent";
  config.app.tools.enabled_tools = ["bash"];
  config.app.memory.compaction.write_memory = true;
  config.app.memory.git_push = false;
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await writeFile(join(workspace, "MEMORY.md"), "Old context");
  const agent = fakeAgent({
    rounds: [
      { blocks: [], toolCalls: [{ name: "bash", input: { command: "cat MEMORY.md" } }] },
      { blocks: [], toolCalls: [{ name: "bash", input: { command: "mkdir -p . && printf %s 'Ready for the next conversation.' > MEMORY.md" } }] },
      { blocks: [{ kind: "text", text: "Updated the active context." }] },
    ],
  });
  if (pause) model.maxToolIterations = 2;
  const { withCallCapture } = await import("../src/llm/capture.ts");
  const records: unknown[] = [];
  const provider = withCallCapture(new ClaudeAgentProvider({
    runQuery: agent.query,
    bookPath: () => join(config.dirs.data, "sdk-sessions.json"),
  }), { recordCall: (record) => { records.push(record); return records.length; } });
  let outcome = await runCompactionPass("ada", {
    config,
    generate: compactionGenerate({ config, providers: { claude_agent: provider } }),
  }, { keepTurnsOverride: 0 });
  if (pause) {
    expect(outcome?.kind).toBe("paused");
    expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe("Ready for the next conversation.");
    const pending = HistoryStore.open(join(config.dirs.data, HISTORY_DB_FILE));
    expect(pending.segmentCount("ada")).toBe(0);
    pending.close();
    const resumedAgent = fakeAgent({ rounds: [{ blocks: [{ kind: "text", text: "Memory maintenance is complete." }] }] });
    const resumedProvider = new ClaudeAgentProvider({ runQuery: resumedAgent.query, bookPath: () => join(config.dirs.data, "sdk-sessions.json") });
    outcome = await runCompactionPass("ada", {
      config, generate: compactionGenerate({ config, providers: { claude_agent: resumedProvider } }),
    }, { keepTurnsOverride: 0 });
    expect(resumedAgent.toolOutcomes).toEqual([]);
  }
  expect(records).toHaveLength(1);
  expect(outcome?.kind).toBe("compacted");
  expect(agent.calls).toHaveLength(1);
  expect(agent.toolOutcomes.map((tool) => tool.allowed)).toEqual([true, true]);
  expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe("Ready for the next conversation.");
  const history = HistoryStore.open(join(config.dirs.data, HISTORY_DB_FILE));
  try {
    expect(history.segmentCount("ada")).toBe(1);
  } finally {
    history.close();
  }
});

test("compaction edits files throughout the workspace through the normal tools", async () => {
  const { runCompactionPass } = await import("../src/memory/compaction/run.ts");
  const config = await world();
  config.app.memory.git_push = false;
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  const paths = [
    "notes.md", "projects/work.md", "journal/today.md", "DREAMS.md",
    "memory/dreams.md", "memory/.dreams/entry.md", "memory/dreaming/entry.md",
    "memory/fact.md",
  ];
  await writeFile(join(workspace, "notes.md"), "old context");
  const seen: SidecarRequest[] = [];
  const provider = scriptedProvider([
    response(paths.map((path, i) => ({
      type: "tool_use", id: `edit-${String(i)}`, name: path === "notes.md" ? "edit" : "bash",
      input: path === "notes.md"
        ? { file_path: path, old_string: "old context", new_string: "current context" }
        : { command: `mkdir -p "$(dirname '${path}')" && printf 'current context' > '${path}'` },
    })), "tool_use"),
    response([{ type: "text", text: "Updated the workspace." }]),
  ], seen);

  const outcome = await runCompactionPass("ada", {
    config, generate: compactionGenerate({ config, providers: { anthropic: provider } }),
  }, { keepTurnsOverride: 0 });

  expect(outcome?.kind).toBe("compacted");
  const results = seen.at(-1)?.messages.flatMap((m) => typeof m.content === "string" ? [] : m.content)
    .filter((b) => b.type === "tool_result") ?? [];
  expect(results).toHaveLength(paths.length);
  expect(results.map((b) => b.is_error ?? false)).toEqual(paths.map(() => false));
  for (const path of paths) {
    expect(await readFile(join(workspace, path.replace(/^workspace\//, "")), "utf8")).toBe("current context");
  }
});

test.each([false, true])("compaction uses Bash deletion and keeps dry runs inert (%s)", async (dryRun) => {
  const { runCompactionPass } = await import("../src/memory/compaction/run.ts");
  const config = await world();
  config.app.memory.git_push = false;
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  const trash = join(config.dirs.data, "ada", "trash");
  await mkdir(join(workspace, "projects"));
  await writeFile(join(workspace, "projects/obsolete.md"), "old context");
  const seen: SidecarRequest[] = [];
  const provider = scriptedProvider([
    response([
      { type: "tool_use", id: "delete", name: "bash", input: { command: "rm projects/obsolete.md" } },
      { type: "tool_use", id: "edit", name: "bash", input: { command: "mkdir -p projects && printf %s 'current context' > projects/current.md" } },
      { type: "tool_use", id: "git", name: "bash", input: { command: "git status --short" } },
    ], "tool_use"),
    response([{ type: "text", text: "Finished." }]),
  ], seen);
  const outcome = await runCompactionPass("ada", {
    config, generate: compactionGenerate({ config, providers: { anthropic: provider } }),
  }, { keepTurnsOverride: 0, dryRun });

  expect(outcome?.kind).toBe(dryRun ? "dry_run" : "compacted");
  const results = seen.at(-1)?.messages.flatMap((m) => typeof m.content === "string" ? [] : m.content)
    .filter((b) => b.type === "tool_result") ?? [];
  expect(results.map((b) => b.is_error ?? false)).toEqual([dryRun, dryRun, dryRun]);
  if (outcome?.kind === "dry_run") {
    expect(outcome.fileOpsPreview).toEqual([]);
    expect(await readFile(join(workspace, "projects/obsolete.md"), "utf8")).toBe("old context");
    expect(readFile(join(workspace, "projects/current.md"))).rejects.toThrow();
    expect(readdir(trash)).rejects.toThrow();
    expect(readdir(join(workspace, ".git"))).rejects.toThrow();
  } else {
    expect(readFile(join(workspace, "projects/obsolete.md"))).rejects.toThrow();
    expect(await readFile(join(workspace, "projects/current.md"), "utf8")).toBe("current context");
    expect(readdir(trash)).rejects.toThrow();
  }
});

test("compaction rejects retired workspace tools without executing them", async () => {
  const { runCompactionPass } = await import("../src/memory/compaction/run.ts");
  const config = await world();
  config.app.memory.git_push = false;
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  const outside = join(config.dirs.data, "outside.md");
  await writeFile(outside, "outside context");
  await symlink(config.dirs.data, join(workspace, "linked"));
  await writeFile(join(workspace, "MEMORY.md"), "active context");
  const calls: ContentBlock[] = [".git/config", "../escape.md", outside, "linked/outside.md"].flatMap((path, i) => [
    { type: "tool_use", id: `edit-${String(i)}`, name: "edit", input: { path, content: "overwritten" } },
    { type: "tool_use", id: `delete-${String(i)}`, name: "delete", input: { path } },
  ]);
  calls.push({ type: "tool_use", id: "delete-prompt", name: "delete", input: { path: "workspace/MEMORY.md" } });
  const seen: SidecarRequest[] = [];
  const provider = scriptedProvider([
    response(calls, "tool_use"), response([{ type: "text", text: "Finished." }]),
  ], seen);
  const outcome = await runCompactionPass("ada", {
    config, generate: compactionGenerate({ config, providers: { anthropic: provider } }),
  }, { keepTurnsOverride: 0 });

  expect(outcome?.kind).toBe("compacted");
  const results = seen.at(-1)?.messages.flatMap((m) => typeof m.content === "string" ? [] : m.content)
    .filter((b) => b.type === "tool_result") ?? [];
  expect(results.map((b) => b.is_error)).toEqual(calls.map(() => true));
  expect(await readFile(outside, "utf8")).toBe("outside context");
  expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe("active context");
});

test.each([false, true])("compaction resumes a deletion without repeating it and detects recreation (%s)", async (recreate) => {
  const { runCompactionPass } = await import("../src/memory/compaction/run.ts");
  const config = await world();
  config.app.memory.git_push = false;
  const model = config.models.chat.get("chat.fixture");
  if (model === undefined) throw new Error("missing fixture model");
  model.maxToolIterations = 1;
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  const path = join(workspace, "notes.md");
  await writeFile(path, "old context");
  const firstProvider = scriptedProvider([
    response([{ type: "tool_use", id: "delete", name: "bash", input: { command: "rm notes.md && printf deleted >> operations" } }], "tool_use"),
  ]);
  const first = await runCompactionPass("ada", {
    config, generate: compactionGenerate({ config, providers: { anthropic: firstProvider } }),
  }, { keepTurnsOverride: 0 });
  expect(first?.kind).toBe("paused");
  expect(readFile(path)).rejects.toThrow();
  const operations = join(workspace, "operations");
  const before = await readFile(operations, "utf8");
  if (recreate) await writeFile(path, "new user context");
  model.maxToolIterations = 3;
  const seen: SidecarRequest[] = [];
  const nextProvider = scriptedProvider([response([{ type: "text", text: "Finished." }])], seen);
  const second = await runCompactionPass("ada", {
    config, generate: compactionGenerate({ config, providers: { anthropic: nextProvider } }),
  }, { keepTurnsOverride: 0 });
  expect(second?.kind).toBe(recreate ? "paused" : "compacted");
  expect(seen).toHaveLength(recreate ? 0 : 1);
  expect(await readFile(operations, "utf8")).toEqual(before);
  if (recreate) {
    expect(second).toMatchObject({ reason: "workspace_conflict", detail: "notes.md" });
    expect(await readFile(path, "utf8")).toBe("new user context");
  }
});

test("compaction delivers structured read images to the next model round", async () => {
  const { runCompactionPass } = await import("../src/memory/compaction/run.ts");
  const config = await world();
  config.app.memory.git_push = false;
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await writeFile(join(workspace, "image.png"), Buffer.from(png, "base64"));
  const seen: SidecarRequest[] = [];
  const provider = scriptedProvider([
    response([{ type: "tool_use", id: "read-image", name: "read", input: { file_path: "image.png" } }], "tool_use"),
    response([{ type: "text", text: "nothing to save" }]),
  ], seen);
  const outcome = await runCompactionPass("ada", {
    config, generate: compactionGenerate({ config, providers: { anthropic: provider } }),
  }, { keepTurnsOverride: 0 });
  expect(outcome?.kind).toBe("compacted");
  const result = seen.at(-1)?.messages.flatMap((turn) => turn.content).find((block) => block.type === "tool_result" && block.tool_use_id === "read-image");
  expect(result).toMatchObject({ type: "tool_result", is_error: false });
  if (result?.type !== "tool_result" || !Array.isArray(result.content)) throw new Error("image result was flattened");
  expect(result.content.find((block) => block.type === "image")).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png } });
});
