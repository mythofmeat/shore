/**
 * Running an autonomy action in this process rather than asking the daemon to.
 *
 * The three actions are pinned on their own, so what is left here is the
 * wiring — and the wiring is where the decisions that look like plumbing live:
 *
 * - **`set_next_wake` goes through the runner's clock, not the executor's.**
 *   The clock belongs to `CharacterAutonomy`, which is also what calls this, so
 *   the scheduling function arrives per tick. The model is told the hour it
 *   actually got, because the clamp happens on the way through.
 * - **`max_turns` compaction is refused here.** It fires inline from the turn
 *   that crossed the threshold, under that turn's config. Running it from the
 *   loop as well is the same conversation compacted twice.
 * - **The covered turn count is passed, not re-read.** It picks between a free
 *   file archive and a paid model call, and two copies of that number drifting
 *   is a bill.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  InProcessAutonomyExecutor,
  type InProcessExecutorDeps,
} from "../src/autonomy/in_process.ts";
import { LastRequestCache } from "../src/autonomy/last_request.ts";
import type { TickHooks } from "../src/autonomy/runner.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";

// ── harness ─────────────────────────────────────────────────────────────

const KEY_ENV = "SHORE_INPROC_KEY";
process.env[KEY_ENV] = "secret";

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
  const root = await mkdtemp(join(tmpdir(), "shore-inproc-"));
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

/** A registry stub — the two accessors the executor actually reaches for. */
function registryFor(config: LoadedConfig, appended: Message[] = []) {
  return {
    effectiveConfig: () => config,
    getOrCreate: async () => ({
      appendMessage: async (msg: Message) => void appended.push(msg),
      currentRevision: () => 3,
    }),
  } as unknown as InProcessExecutorDeps["registry"];
}

/** An adapter that plays out the given rounds and records the requests it saw. */
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

// ── the heartbeat ───────────────────────────────────────────────────────

describe("running a heartbeat", () => {
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

    // The first call is the tick; everything after is its loop. The ledger
    // reads these to tell a heartbeat's own cost from its tool rounds'.
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
      // The real clock clamps to 48; this stands in for that.
      scheduleNextWake: (hours, reason) => {
        asked.push({ hours, reason });
        return Math.min(hours, 48);
      },
    });

    expect(asked).toEqual([{ hours: 900, reason: "the essay" }]);
    // The model is told the hour it actually got, not the one it asked for —
    // otherwise it plans around a wake that will never happen.
    const results = seen[1]?.messages.at(-1)?.content ?? [];
    const output = (results[0] as { content: string }).content;
    expect(output).toBe("Scheduled next moment in 48.0 hours.");
  });

  test("a failed model call ends the tick without throwing", async () => {
    const config = await world();
    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      // No rounds scripted at all, so the very first call throws.
      providers: { anthropic: scriptedProvider([]) },
    });

    const result = await executor.runHeartbeatTick("ada", NO_HOOKS);

    // A heartbeat that cannot reach its model is a quiet tick, not a thrown
    // one: the next attempt is an hour away at worst.
    expect(result.events).toEqual([
      { kind: "message_skipped", detail: "Tick completed — no message sent" },
    ]);
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

    // The model has to know the tool failed, or it treats the error text as the
    // file's contents and carries on reasoning from it.
    const results = seen[1]?.messages.at(-1)?.content ?? [];
    expect(results[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(JSON.parse(rows[0]?.entry_json ?? "{}").tool_calls[0].is_error).toBe(true);
  });

  test("an image the tick generated rides out on the message it sends", async () => {
    const config = await world();
    const appended: Message[] = [];
    // The tool refuses before it ever calls the generator without a profile,
    // so the value this test is about would never be produced.
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
        // The generator answers with a URL; the *tool* downloads it, saves it
        // and answers with the path. That path is what has to reach the loop,
        // and it only does because `dispatch` hands the value back beside the
        // rendered output.
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
    cache.set("ada", {
      sdk: "anthropic",
      model: "claude-fixture",
      api_key: "secret",
      provider_key: "anthropic",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 1024,
      replay_prior_thinking: "off",
      context: {
        ledger: "/tmp/does-not-exist/ledger.db",
        character: "ada",
        call_type: "message",
        thinking_enabled: false,
      },
    } as never);

    const executor = new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache,
      providers: {
        anthropic: scriptedProvider([response([{ type: "text", text: "ok" }])], seen),
      },
    });

    await executor.runHeartbeatTick("ada", NO_HOOKS);

    // The call type is rewritten per round; everything else the chat turn put
    // there — the ledger path above all — has to come through, or the tick
    // records nothing at all.
    expect(seen[0]?.context?.ledger).toBe("/tmp/does-not-exist/ledger.db");
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

// ── compaction and the archive ──────────────────────────────────────────

describe("the other two actions", () => {
  function executorFor(config: LoadedConfig): InProcessAutonomyExecutor {
    return new InProcessAutonomyExecutor({
      registry: registryFor(config),
      cache: new LastRequestCache(),
      providers: { anthropic: scriptedProvider([]) },
    });
  }

  test("a max_turns compaction is refused rather than run twice", async () => {
    const result = await executorFor(await world()).runCompaction("ada", "max_turns");

    // It fires inline from the turn that crossed the threshold, under that
    // turn's own config. Running it here as well compacts the same
    // conversation twice and bills for both.
    expect(result.failed).toContain("not the autonomy loop's to run");
    expect(result.events).toEqual([]);
  });

  test("an idle compaction is this executor's to run", async () => {
    const result = await executorFor(await world()).runCompaction("ada", "idle");

    // It reached the pass rather than being refused at the door — the pass
    // itself is pinned by `idle_compaction.test.ts`.
    expect(result.failed).not.toContain("not the autonomy loop's to run");
  });

  test("the deep archive takes the coverage count it is given", async () => {
    // Every user turn already covered, so the cheap arm runs: a pure file
    // archive with no model call at all. The scripted provider has no rounds,
    // so a pass that reached for a model would fail instead.
    const result = await executorFor(await world()).runDeepArchive("ada", 1);

    expect(result.failed).toBeUndefined();
    expect(result.deepArchiveDone).toBe(true);
  });
});
