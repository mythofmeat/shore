import { Ledger } from "../src/ledger/store.ts";
import { writeDurable } from "../src/storage/files.ts";
import { toolGeneration } from "./support/tool_generation.ts";
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  persistHeartbeatMessage,
  runHeartbeatTick,
  type HeartbeatEngine,
  type HeartbeatTickDeps,
} from "../src/autonomy/heartbeat_tick.ts";
import type { HeartbeatLoopResult } from "../src/autonomy/heartbeat_loop.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { BudgetBlocked } from "../src/llm/generate.ts";
import type { BudgetBlock } from "../src/ledger/budget.ts";
import { openLedger } from "./support/ledger_fixture.ts";
import { testTmp } from "./support/tmp.ts";

beforeEach(() => {
  setTestEnv(KEY_ENV, "secret");
});

const cleanups: Array<() => void> = [];

afterAll(() => {
  restoreTestEnv();
  closeLedgers();
  for (const c of cleanups) c();
});

afterEach(() => {
  setSystemTime();
});

const KEY_ENV = "SHORE_HB_TICK_KEY";

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
  maxToolIterations: 4,
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

async function world(
  messages: Message[] = [message("user", "m_1", "hi"), message("assistant", "m_2", "hello")],
): Promise<LoadedConfig> {
  const root = await mkdtemp(testTmp("shore-hbtick-"));
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
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length === 0 ? "" : "\n"));

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

function recordingEngine(appended: Message[], revision = 7): HeartbeatEngine {
  return {
    appendMessage: async (msg) => {
      appended.push(msg);
    },
    currentRevision: () => revision,
  };
}

function tickDeps(over: Partial<Omit<HeartbeatTickDeps, "generate">> & { generate?: () => Promise<GenerateResponse | undefined> } = {}): HeartbeatTickDeps {
  return {
    cache: new LastRequestCache(),
    dispatch: async () => ({ output: "ok", isError: false }),
    newId: () => "m_fixed",
    nowIso: () => "2026-07-30T13:00:00.000Z",
    now: () => Date.parse("2026-07-30T13:00:00Z"),
    timeZone: "UTC",
    ...over,
    generate: toolGeneration(over.generate ?? (async () => response([{ type: "text", text: "HEARTBEAT_OK" }]))),
  };
}

describe("delivering what a tick asked to say", () => {
  const request = (): SidecarRequest =>
    ({ model: "claude-opus-bg", provider_key: "anthropic", messages: [] }) as never;

  test("persists the message, pushes it, notifies, and logs it", async () => {
    const appended: Message[] = [];
    const pushed: { revision: number; msg: Message }[] = [];
    const notified: { title: string; body: string }[] = [];
    const notes: { kind: string; detail: string }[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: "I read that paper you left open", images: [] },
      {
        engine: async () => recordingEngine(appended),
        emit: (_c, revision, msg) => pushed.push({ revision, msg }),
        notify: (title, body) => notified.push({ title, body }),
        newId: () => "m_fixed",
        nowIso: () => "2026-07-30T13:00:00.000Z",
      },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(appended.length).toBe(1);
    expect(appended[0]).toMatchObject({
      msg_id: "m_fixed",
      role: "assistant",
      origin: "autonomous",
      content: "I read that paper you left open",
      model: "claude-opus-bg",
      provider_key: "anthropic",
    });
    expect(pushed).toEqual([{ revision: 7, msg: appended[0] as Message }]);
    expect(notified).toEqual([
      { title: "Shore - ada", body: "I read that paper you left open" },
    ]);
    expect(notes).toEqual([
      { kind: "message_sent", detail: "Autonomous message sent: I read that paper you left open" },
    ]);
  });

  test("an image-only tick delivers the image with no empty text block", async () => {
    const appended: Message[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: undefined, images: [{ path: "images/boat.png", caption: "a boat" }] },
      { engine: async () => recordingEngine(appended), newId: () => "m_fixed", nowIso: () => "t" },
      () => {},
    );

    expect(appended.length).toBe(1);
    expect(appended[0]?.content_blocks).toEqual([]);
    expect(appended[0]?.content).toBe("");
    expect(appended[0]?.images).toEqual([{ path: "images/boat.png", caption: "a boat" }]);
  });

  test("a caption-less image carries no caption key at all", async () => {
    const appended: Message[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: "look", images: [{ path: "images/x.png", caption: undefined }] },
      { engine: async () => recordingEngine(appended), newId: () => "m", nowIso: () => "t" },
      () => {},
    );

    expect(appended[0]?.images[0]).toEqual({ path: "images/x.png" });
    expect(Object.keys(appended[0]?.images[0] ?? {})).toEqual(["path"]);
  });

  test("a tick with nothing to say records a skip and delivers nothing", async () => {
    const appended: Message[] = [];
    const notified: unknown[] = [];
    const notes: { kind: string; detail: string }[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: undefined, images: [] },
      {
        engine: async () => recordingEngine(appended),
        notify: () => notified.push(1),
      },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(appended).toEqual([]);
    expect(notified).toEqual([]);
    expect(notes).toEqual([
      { kind: "message_skipped", detail: "Tick completed — no message sent" },
    ]);
  });

  test("a failed call says so instead of passing for a quiet tick", async () => {
    const notes: { kind: string; detail: string }[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: undefined, images: [], failedRound: 0 },
      { engine: async () => recordingEngine([]) },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(notes.length).toBe(1);
    expect(notes[0]?.kind).toBe("call_failed");
    expect(notes[0]?.detail).toContain("round 0");
  });

  test("a budget stop is a pause naming the budget, not a call failure", async () => {
    const notes: { kind: string; detail: string }[] = [];
    const pace: BudgetBlock = {
      budget_name: "brainwife",
      action: "pause_heartbeat",
      current_cost: 1.371,
      cost_limit: 2.08,
      period: "day",
      reset_at: "2026-08-23T07:00:00+00:00",
      scope: "pace",
      warn_threshold: 0.65,
      message: "the long form nobody wants in a log line",
      summary:
        'budget "brainwife" day pace reached 65% ($1.37/$2.08); resets 2026-08-23 05:00 PM',
    };

    await persistHeartbeatMessage(
      "ada",
      request(),
      {
        sendMessageText: undefined,
        images: [],
        failedRound: 0,
        failure: BudgetBlocked.from(pace),
      },
      { engine: async () => recordingEngine([]) },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(notes.length).toBe(1);
    expect(notes[0]?.kind).toBe("budget_paused");
    expect(notes[0]?.detail).toBe(
      'Heartbeat paused on round 0 — budget "brainwife" day pace reached 65% ' +
        "($1.37/$2.08); resets 2026-08-23 05:00 PM",
    );
  });

  test("a budget stop wrapped by the retry chain is still read as a pause", async () => {
    const notes: { kind: string; detail: string }[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      {
        sendMessageText: undefined,
        images: [],
        failedRound: 3,
        failure: new Error("Failed after 3 attempts", {
          cause: new BudgetBlocked('Shore usage budget "brainwife" is over limit', "budget"),
        }),
      },
      { engine: async () => recordingEngine([]) },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(notes[0]?.kind).toBe("budget_paused");
    expect(notes[0]?.detail).toContain("round 3");
    expect(notes[0]?.detail).toContain('usage budget "brainwife"');
  });

  test("a provider failure names the provider's reason instead of deferring to the trace", async () => {
    const notes: { kind: string; detail: string }[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      {
        sendMessageText: undefined,
        images: [],
        failedRound: 2,
        failure: new Error("The engine is currently overloaded, please try again later"),
      },
      { engine: async () => recordingEngine([]) },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(notes.length).toBe(1);
    expect(notes[0]?.kind).toBe("call_failed");
    expect(notes[0]?.detail).toContain("round 2");
    expect(notes[0]?.detail).toContain("engine is currently overloaded");
  });

  test("an empty <sendMessage> is still a message, not a skip", async () => {
    const notes: { kind: string; detail: string }[] = [];
    const appended: Message[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: "", images: [] },
      { engine: async () => recordingEngine(appended), newId: () => "m", nowIso: () => "t" },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(notes[0]?.kind).toBe("message_sent");
    expect(appended.length).toBe(1);
  });

  test("notifies even when the engine refused the append", async () => {
    const notified: { title: string; body: string }[] = [];
    const notes: { kind: string; detail: string }[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: "still worth saying", images: [] },
      {
        engine: async () => ({
          appendMessage: async () => {
            throw new Error("disk full");
          },
          currentRevision: () => 0,
        }),
        notify: (title, body) => notified.push({ title, body }),
        newId: () => "m",
        nowIso: () => "t",
      },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(notified.length).toBe(1);
    expect(notes[0]?.kind).toBe("message_sent");
  });

  test("a failed append pushes nothing, so no client hears about a revision that is not there", async () => {
    const pushed: unknown[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: "hello", images: [] },
      {
        engine: async () => ({
          appendMessage: async () => {
            throw new Error("disk full");
          },
          currentRevision: () => 0,
        }),
        emit: () => pushed.push(1),
        newId: () => "m",
        nowIso: () => "t",
      },
      () => {},
    );

    expect(pushed).toEqual([]);
  });

  test("no engine at all still notifies and logs", async () => {
    const notified: unknown[] = [];
    const notes: { kind: string; detail: string }[] = [];

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: "into the void", images: [] },
      { notify: () => notified.push(1), newId: () => "m", nowIso: () => "t" },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(notified.length).toBe(1);
    expect(notes[0]?.kind).toBe("message_sent");
  });

  test("the logged preview is bounded at eighty characters", async () => {
    const notes: { kind: string; detail: string }[] = [];
    const long = "x".repeat(200);

    await persistHeartbeatMessage(
      "ada",
      request(),
      { sendMessageText: long, images: [] },
      { newId: () => "m", nowIso: () => "t" },
      (kind, detail) => notes.push({ kind, detail }),
    );

    expect(notes[0]?.detail).toBe(`Autonomous message sent: ${"x".repeat(80)}`);
  });

  test("a body with no model records no minting model rather than an empty one", async () => {
    const appended: Message[] = [];

    await persistHeartbeatMessage(
      "ada",
      { model: "", messages: [] } as never,
      { sendMessageText: "hi", images: [] },
      { engine: async () => recordingEngine(appended), newId: () => "m", nowIso: () => "t" },
      () => {},
    );

    expect(appended[0]?.model).toBeUndefined();
  });
});

describe("running a tick", () => {
  test("runs the loop and delivers what it produced", async () => {
    const config = await world();
    const appended: Message[] = [];

    const result = await runHeartbeatTick(
      "ada",
      config,
      tickDeps({
        generate: async () =>
          response([{ type: "text", text: "<sendMessage>the tide is out</sendMessage>" }]),
        engine: async () => recordingEngine(appended),
      }),
    );

    expect(appended.length).toBe(1);
    expect(appended[0]?.content).toBe("the tide is out");
    expect(appended[0]?.model).toBe("claude-fixture");
    expect(result.events).toEqual([
      { kind: "message_sent", detail: "Autonomous message sent: the tide is out" },
    ]);
    expect(result.turnCount).toBeUndefined();
    expect(result.failed).toBeUndefined();
  });

  test("a budget-paused tick is a logged skip, and spends nothing", async () => {
    const config = await world();
    let generated = 0;

    const result = await runHeartbeatTick(
      "ada",
      config,
      tickDeps({
        generate: async () => {
          generated += 1;
          return response([{ type: "text", text: "HEARTBEAT_OK" }]);
        },
        budgetBlockFor: () =>
          ({
            budget_name: "monthly",
            action: "pause_heartbeat",
            summary: 'budget "monthly" reached 80% ($9.00/$10.00); resets 2026-09-01 12:00 AM',
          }) as never,
      }),
    );

    expect(generated).toBe(0);
    expect(result.events).toEqual([
      {
        kind: "budget_paused",
        detail:
          'Heartbeat paused before round 0 — budget "monthly" reached 80% ' +
          "($9.00/$10.00); resets 2026-09-01 12:00 AM",
      },
    ]);
    expect(result.failed).toBeUndefined();
  });

  test("the real gate pauses the tick, because the body is tagged as a heartbeat", async () => {
    setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    const config = await world();
    const ledgerPath = join(config.dirs.data, "shore.db");
    Ledger.create(ledgerPath).close();
    const db = openLedger(ledgerPath);
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, 'ada', 'anthropic', 'default', 'claude-fixture', 'message',
         10, 5, 0, 0, 100, 10, 'end_turn', 1, 'provider_reported', 9.0)`,
    ).run(new Date().toISOString());
    db.close();

    const cache = new LastRequestCache();
    cache.set(
      "ada",
      {
        sdk: "anthropic",
        model: "claude-fixture",
        api_key: "secret",
        provider_key: "anthropic",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        max_tokens: 128,
        context: {
          ledger: ledgerPath,
          character: "ada",
          call_type: "message",
          api_key_name: "default",
          thinking_enabled: false,
          usage: {
            timezone: "utc",
            budgets: [
              {
                name: "monthly",
                period: "month",
                cost_usd: 10,
                warn_at: [0.8],
                warn_action: "pause_heartbeat",
                limit: "warn",
              },
            ],
          },
        },
      } as never,
      undefined,
    );

    config.app.usage.timezone = "utc";
    config.app.usage.budgets = [{
      name: "monthly",
      period: "month",
      cost_usd: 10,
      warn_at: [0.8],
      warn_action: "pause_heartbeat",
      limit: "warn",
      usage_kind: [],
    } as never];

    let generated = 0;
    const result = await runHeartbeatTick(
      "ada",
      config,
      tickDeps({
        cache,
        generate: async () => {
          generated += 1;
          return response([{ type: "text", text: "HEARTBEAT_OK" }]);
        },
      }),
    );

    expect(generated).toBe(0);
    expect(result.events).toEqual([
      {
        kind: "budget_paused",
        detail:
          'Heartbeat paused before round 0 — budget "monthly" reached 80% ' +
          "($9.00/$10.00); resets 2026-09-01 12:00 AM",
      },
    ]);
  });

  test("collects the loop's tool lines into the tick's events", async () => {
    const config = await world();
    let round = 0;

    const result = await runHeartbeatTick(
      "ada",
      config,
      tickDeps({
        generate: async () => {
          round += 1;
          return round === 1
            ? response(
                [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.md" } }],
                "tool_use",
              )
            : response([{ type: "text", text: "HEARTBEAT_OK" }]);
        },
        dispatch: async () => ({ output: "wrote it", isError: false }),
      }),
    );

    expect(result.events).toEqual([
      { kind: "tool_use", detail: "Tool: edit → wrote it" },
      { kind: "message_skipped", detail: "Tick completed — no message sent" },
    ]);
  });

  test("hands the loop the cap from the model and the grace from config", async () => {
    const config = await world();
    config.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds = 3;
    let calls = 0;

    await runHeartbeatTick(
      "ada",
      config,
      tickDeps({
        generate: async () => {
          calls += 1;
          if (calls > 20) return undefined;
          return response(
            [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.md" } }],
            "tool_use",
          );
        },
      }),
    );

    expect(calls).toBe(7);
  });

  test("a body that cannot be built is a silent skip", async () => {
    const config = await world([message("user", "m_1", "you there?")]);
    let called = 0;

    const result = await runHeartbeatTick(
      "ada",
      config,
      tickDeps({
        generate: async () => {
          called += 1;
          return response([]);
        },
      }),
    );

    expect(called).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.failed).toBeUndefined();
  });

  test("the tick's rounds never touch the cached body", async () => {
    const config = await world();
    const cache = new LastRequestCache();
    let round = 0;

    await runHeartbeatTick(
      "ada",
      config,
      tickDeps({
        cache,
        generate: async () => {
          round += 1;
          return round === 1
            ? response(
                [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.md" } }],
                "tool_use",
              )
            : response([{ type: "text", text: "done" }]);
        },
      }),
    );

    const cached = cache.get("ada");
    expect(cached).toBeDefined();
    expect(cached?.messages.length).toBe(2);
    expect(cached?.messages.some((m) => m.role === "system")).toBe(false);
    expect(
      cached?.messages.some((m) => m.content.some((b) => b.type === "tool_result")),
    ).toBe(false);
  });
});

describe("what an autonomous turn leaves in the history", () => {
  const request = (): SidecarRequest =>
    ({ model: "kimi-k3", provider_key: "moonshot", messages: [] }) as never;

  const persist = async (loop: HeartbeatLoopResult): Promise<Message[]> => {
    const appended: Message[] = [];
    await persistHeartbeatMessage(
      "ada",
      request(),
      loop,
      {
        engine: async () => recordingEngine(appended),
        newId: () => "m_fixed",
        nowIso: () => "2026-07-30T13:00:00.000Z",
      },
      () => {},
    );
    return appended;
  };

  test("the reasoning is stored ahead of the text, the way a chat turn stores it", async () => {
    const [msg] = await persist({
      sendMessageText: "evening eve",
      images: [],
      thinking: [{ type: "thinking", thinking: "she has been quiet all day" }],
    });

    expect(msg?.content_blocks).toEqual([
      { type: "thinking", thinking: "she has been quiet all day" },
      { type: "text", text: "evening eve" },
    ]);
  });

  test("the displayed content stays text only", async () => {
    const [msg] = await persist({
      sendMessageText: "evening eve",
      images: [],
      thinking: [{ type: "thinking", thinking: "internal" }],
    });

    expect(msg?.content).toBe("evening eve");
  });

  test("a tick with no reasoning stores the text alone", async () => {
    const [msg] = await persist({ sendMessageText: "hi", images: [], thinking: [] });

    expect(msg?.content_blocks).toEqual([{ type: "text", text: "hi" }]);
  });

  test("an image-only tick still stores its reasoning", async () => {
    const [msg] = await persist({
      sendMessageText: undefined,
      images: [{ path: "images/x.png", caption: undefined }],
      thinking: [{ type: "thinking", thinking: "she would like this one" }],
    });

    expect(msg?.content_blocks).toEqual([
      { type: "thinking", thinking: "she would like this one" },
    ]);
    expect(msg?.content).toBe("");
  });
});
