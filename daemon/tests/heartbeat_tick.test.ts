/**
 * A heartbeat tick end to end, against real files.
 *
 * The two halves are pinned on their own — `heartbeat_request.test.ts` and
 * `heartbeat_loop.test.ts` — so what is left here is delivery, and delivery is
 * the part where a character's one chance to be heard goes quiet.
 *
 * Three things worth naming, because each looks like nothing when it breaks:
 *
 * - **An image-only tick still delivers.** `<sendMessage>` is not the only way
 *   to say something. A tick that generated an image and wrote no words has
 *   produced something for the user, and the message carries no empty text
 *   block beside it.
 * - **The notification fires even when the append failed.** The character did
 *   speak. A user told about a message they cannot find is better served than
 *   one who is never told.
 * - **A tick that could not build a body is a skip, not a failure.** Nothing
 *   ran, so there is nothing to log and nothing to retry differently — the
 *   clock tries again on its own schedule.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  persistHeartbeatMessage,
  runHeartbeatTick,
  type HeartbeatEngine,
  type HeartbeatTickDeps,
} from "../src/autonomy/heartbeat_tick.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(restoreTestEnv);

// ── harness ─────────────────────────────────────────────────────────────

const KEY_ENV = "SHORE_HB_TICK_KEY";
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
  await mkdir(characterDir, { recursive: true });
  await writeFile(
    join(characterDir, "active.jsonl"),
    messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length === 0 ? "" : "\n"),
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

/** A conversation that records what was appended to it. */
function recordingEngine(appended: Message[], revision = 7): HeartbeatEngine {
  return {
    appendMessage: async (msg) => {
      appended.push(msg);
    },
    currentRevision: () => revision,
  };
}

function tickDeps(over: Partial<HeartbeatTickDeps> = {}): HeartbeatTickDeps {
  return {
    cache: new LastRequestCache(),
    generate: async () => response([{ type: "text", text: "HEARTBEAT_OK" }]),
    dispatch: async () => ({ output: "ok", isError: false }),
    scheduleNextWake: () => "scheduled",
    newId: () => "m_fixed",
    nowIso: () => "2026-07-30T13:00:00.000Z",
    now: () => Date.parse("2026-07-30T13:00:00Z"),
    timeZone: "UTC",
    ...over,
  };
}

// ── delivery ────────────────────────────────────────────────────────────

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
      // The model that actually wrote it — the background one, not chat's.
      model: "claude-opus-bg",
      provider_key: "anthropic",
    });
    // Persisted before pushed, so the revision announced is one that exists.
    expect(pushed).toEqual([{ revision: 7, msg: appended[0] as Message }]);
    expect(notified).toEqual([
      { title: "Shore — ada", body: "I read that paper you left open" },
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
    // A blank `ContentBlock::Text` beside the image renders as a stray empty
    // line in every client that shows the conversation.
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
    expect("caption" in (appended[0]?.images[0] as object)).toBe(false);
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

    // The sink holding `""` and holding nothing are different states: the tag
    // never yields an empty string, so this can only come from a tool call the
    // model deliberately made.
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

// ── the tick as a whole ─────────────────────────────────────────────────

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
    // Stamped from the request the loop actually ran against, so the
    // conversation records which model wrote this turn.
    expect(appended[0]?.model).toBe("claude-fixture");
    expect(result.events).toEqual([
      { kind: "message_sent", detail: "Autonomous message sent: the tide is out" },
    ]);
    // A heartbeat writes log lines and leaves the turn count alone.
    expect(result.turnCount).toBeUndefined();
    expect(result.failed).toBeUndefined();
  });

  test("a budget-paused tick is a logged skip, and spends nothing", async () => {
    // The pre-flight keepalive has always had. Without it the tick builds its
    // request, reaches the gate inside `generate`, and throws `BudgetBlocked`
    // — once per tick, forever, which is not what "pause" means.
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
          ({ budget_name: "monthly", action: "pause_heartbeat" }) as never,
      }),
    );

    expect(generated).toBe(0);
    expect(result.events).toEqual([
      { kind: "budget_paused", detail: 'Tick skipped — usage budget "monthly"' },
    ]);
    expect(result.failed).toBeUndefined();
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
                [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.md" } } as ContentBlock],
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

  /**
   * The tick is where the two budget numbers come from: the round cap off the
   * model the body runs on, and the grace rounds off config. Neither is the
   * loop's to know, and getting either wrong changes how long a character has
   * to finish what it was doing.
   */
  test("hands the loop the cap from the model and the grace from config", async () => {
    const config = await world();
    config.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds = 3;
    let calls = 0;

    await runHeartbeatTick(
      "ada",
      config,
      tickDeps({
        // A model that never stops asking, so only the budget ends the tick.
        // The hard stop is a backstop: an unlimited cap would otherwise run to
        // the wall-clock deadline and hang this test for half an hour.
        generate: async () => {
          calls += 1;
          if (calls > 20) return undefined;
          return response(
            [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.md" } } as ContentBlock],
            "tool_use",
          );
        },
      }),
    );

    // The model's four rounds, then the nudge, then three grace rounds.
    expect(calls).toBe(7);
  });

  test("a body that cannot be built is a silent skip", async () => {
    // Mid-turn: a user message still waiting on an answer.
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
                [{ type: "tool_use", id: "t1", name: "edit", input: { path: "a.md" } } as ContentBlock],
                "tool_use",
              )
            : response([{ type: "text", text: "done" }]);
        },
      }),
    );

    // The rebuild was cached, and a whole tool round ran against a copy of it.
    // Two model calls and a tool-result turn later, what the keepalive holds is
    // still the body chat's next turn will extend.
    const cached = cache.get("ada");
    expect(cached).toBeDefined();
    // The two turns it was rebuilt from, and nothing the tick added: no inline
    // system entry, and no tool-result turn.
    expect(cached?.messages.length).toBe(2);
    expect(cached?.messages.some((m) => m.role === "system")).toBe(false);
    expect(
      cached?.messages.some((m) => m.content.some((b) => b.type === "tool_result")),
    ).toBe(false);
  });
});
