import { afterAll, afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { rebuildRequestFromDisk } from "../src/cache/rebuild.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { History } from "../src/engine/conversation.ts";
import { addDiaryNote, foldDiary, unfoldedDiary } from "../src/autonomy/diary.ts";
import { heartbeatNewsNote, triggerFiredNote, userWroteNote } from "../src/autonomy/heartbeat_shape.ts";
import { lastSeen, noteSeen, presence, setPresence } from "../src/autonomy/presence.ts";
import { checkFacts, startTriggerTimer, type TriggerService } from "../src/autonomy/trigger_service.ts";
import { DIARY_FOR_CHAT, DIARY_FOR_HEARTBEAT, diaryText, heartbeatRunningText } from "../src/engine/prompt.ts";
import { markThreadRead, threadActivityNow } from "../src/engine/threads.ts";
import type { DiaryNote, Message } from "../src/engine/types.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps, buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import { ThreadUnreadTracker } from "../src/handler/thread_unread.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { queuedCompactionsEnded } from "../src/memory/compaction/background.ts";
import { runCompactionPass } from "../src/memory/compaction/run.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { hostZone } from "../src/ledger/zoned.ts";
import { createRuntime, startRuntimeClocks, type ShoreRuntime } from "../src/runtime.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { sizedImage } from "./support/sized_image.ts";
import { eventsForResponse } from "./support/stream.ts";
import { restoreTestEnv, setTestEnv, unsetTestEnv } from "./support/env.ts";
import { NO_MCP } from "./support/rebuild.ts";
import { outcomeOf, rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12);
const KEY_ENV = "SHORE_HEARTBEAT_THREAD_KEY";

afterAll(restoreTestEnv);
afterEach(() => setSystemTime());

function at(minutes: number): void {
  setSystemTime(new Date(T0 + minutes * MINUTE));
}

function textOf(request: SidecarRequest): string {
  return request.messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : [])).join("\n");
}

interface Script {
  heartbeats: SidecarRequest[];
  replies: SidecarRequest[];
  calls: string[];
  held: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  closing: string;
  aside?: string | undefined;
  again?: number;
  beatHeld?: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  endHeld?: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  wake?: Record<string, unknown> | undefined;
  beatTool?: { name: string; input: Record<string, unknown> } | undefined;
  replyWake?: Record<string, unknown> | undefined;
  replyTool?: { name: string; input: Record<string, unknown> } | undefined;
}

function scriptedProvider(script: Script): SidecarProvider {
  const respond = (request: SidecarRequest, blocks: GenerateResponse["content_blocks"]): GenerateResponse => ({
    model: request.model,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    content_blocks: blocks,
    finish_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  });
  return {
    generate: async (request) => {
      script.calls.push(request.context?.call_type ?? "");
      return respond(request, [{ type: "text", text: "hello" }]);
    },
    stream: async function* (request) {
      script.calls.push(request.context?.call_type ?? "");
      if (request.context?.call_type.startsWith("heartbeat") !== true) {
        if (request.context?.call_type === "message") script.replies.push(structuredClone(request));
        const held = script.held;
        if (held !== undefined) {
          script.held = undefined;
          held.started.resolve();
          await held.release.promise;
        }
        const replyTool = script.replyTool;
        script.replyTool = undefined;
        if (replyTool !== undefined) {
          yield* eventsForResponse(respond(request, [{ type: "tool_use", id: "reply-tool", name: replyTool.name, input: replyTool.input }]));
          return;
        }
        const replyWake = script.replyWake;
        script.replyWake = undefined;
        yield* eventsForResponse(respond(request, replyWake === undefined
          ? [{ type: "text", text: `reply to: ${textOf(request).split("\n").at(-1) ?? ""}` }]
          : [{ type: "tool_use", id: "reply-wake", name: "set_next_wake", input: replyWake }]));
        return;
      }
      script.heartbeats.push(structuredClone(request));
      const resultsIn = request.messages.at(-1)?.content.some((block) => block.type === "tool_result") === true;
      const beat = script.beatHeld;
      if (beat !== undefined && !resultsIn) {
        script.beatHeld = undefined;
        beat.started.resolve();
        await beat.release.promise;
      }
      if (resultsIn && (script.again ?? 0) > 0) {
        script.again = (script.again ?? 0) - 1;
        yield* eventsForResponse(respond(request, [{ type: "tool_use", id: `again-${String(script.heartbeats.length)}`, name: "read", input: { file_path: "SOUL.md" } }]));
        return;
      }
      const end = script.endHeld;
      if (end !== undefined && resultsIn) {
        script.endHeld = undefined;
        end.started.resolve();
        await end.release.promise;
      }
      const beatTool = resultsIn ? undefined : script.beatTool;
      if (beatTool !== undefined) {
        script.beatTool = undefined;
        yield* eventsForResponse(respond(request, [{ type: "tool_use", id: `tool-${String(script.heartbeats.length)}`, name: beatTool.name, input: beatTool.input }]));
        return;
      }
      const wake = resultsIn ? undefined : script.wake;
      if (wake !== undefined) {
        script.wake = undefined;
        yield* eventsForResponse(respond(request, [{ type: "tool_use", id: `wake-${String(script.heartbeats.length)}`, name: "set_next_wake", input: wake }]));
        return;
      }
      yield* eventsForResponse(respond(request, resultsIn
        ? [
            { type: "thinking", thinking: "She asked about the lamp, so I'll tell her.", signature: "sig-1" },
            { type: "text", text: script.closing },
          ]
        : [
            ...(script.aside === undefined ? [] : [{ type: "text" as const, text: script.aside }]),
            { type: "tool_use", id: `read-${String(script.heartbeats.length)}`, name: "read", input: { file_path: "SOUL.md" } },
          ]));
    },
  };
}

interface Emitted {
  thread: string;
  msg: Message;
}

interface Harness {
  runtime: ShoreRuntime;
  script: Script;
  data: string;
  workspace: string;
  emitted: Emitted[];
  say: (text: string, thread?: string) => Promise<void>;
  regenerate: (thread: string) => Promise<void>;
  heartbeat: () => Promise<void>;
  thread: (id: string) => Promise<readonly Message[]>;
  shown: (thread: string, match: (message: Message) => boolean) => Promise<void>;
  heard: (thread: string) => boolean;
  events: ServerMessage[];
  command: (name: string, args: Record<string, unknown>, thread?: string) => Promise<ServerMessage>;
}

async function withCharacter(run: (h: Harness) => Promise<void>, configure?: (app: AppConfig) => void, kept?: string): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  if (kept === undefined) at(0);
  const root = kept ?? await mkdtemp(testTmp("shore-heartbeat-thread-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = ["read", "set_next_wake"];
  app.behavior.autonomy.enabled = true;
  configure?.(app);
  const models = emptyCatalog();
  for (const name of ["fixture", "pinned"]) {
    models.chat.set(`chat.${name}`, {
      name, qualifiedName: `chat.${name}`, category: "chat", providerKey: "anthropic",
      sdk: "anthropic", modelId: `claude-${name}`, apiKeyEnv: KEY_ENV,
      maxContextTokens: 200_000, maxOutputTokens: 4096,
    });
  }
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  const script: Script = { heartbeats: [], replies: [], calls: [], held: undefined, closing: "<sendMessage>I found the keeper's log.</sendMessage>" };
  const emitted: Emitted[] = [];
  const histories: History[] = [];
  const events: ServerMessage[] = [];
  const waiting: { thread: string; match: (message: Message) => boolean; resolve: () => void }[] = [];
  const env = { [KEY_ENV]: "fixture-key" };
  const runtime = await createRuntime({
    config, providers: { anthropic: scriptedProvider(script) }, env,
    emitEvent: (event) => { events.push(event); },
    emit: (_character, _revision, msg, thread) => { emitted.push({ thread, msg: structuredClone(msg) }); },
    onHistory: (history) => {
      histories.push(history);
      for (const waiter of waiting) if (history.selected_thread === waiter.thread && history.messages.some(waiter.match)) waiter.resolve();
    },
  });
  try {
    const autonomy = new TurnAutonomyBridge(runtime.autonomy);
    const deps = buildGenerationDeps({
      runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: () => {},
    });
    await run({
      runtime,
      script,
      data: config.dirs.data,
      workspace,
      emitted,
      heard: (thread) => histories.some((history) => history.selected_thread === thread),
      events,
      shown: async (thread, match) => {
        if (histories.some((history) => history.selected_thread === thread && history.messages.some(match))) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        waiting.push({ thread, match, resolve });
        await promise;
      },
      say: async (text, thread = "main") => {
        const end = runtime.autonomy.beginForeground("ada");
        try {
          await runGeneration(deps, {
            meta: {
              session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: thread },
              rid: text, kind: "message",
            },
            body: { rid: text, text, stream: true, images: [], image_data: [] },
            charName: "ada", regen: false, rid: text, signal: new AbortController().signal, send: async () => {},
          });
        } finally {
          end();
        }
        await autonomy.settled("ada");
      },
      regenerate: async (thread) => {
        await runGeneration(deps, {
          meta: {
            session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: thread },
            rid: "again", kind: "message",
          },
          body: { rid: "again", text: "", stream: true, images: [], image_data: [] },
          charName: "ada", regen: true, rid: "again", signal: new AbortController().signal, send: async () => {},
        });
        await autonomy.settled("ada");
      },
      heartbeat: async () => {
        expect(runtime.autonomy.forceHeartbeatNow("ada")).toBeDefined();
        await runtime.autonomy.tick();
      },
      thread: async (id) => (await runtime.registry.getOrCreate("ada", id)).messages(),
      command: async (name, args, thread = "main") => await dispatchCommand(buildCommandPathDeps({
        runtime, autonomy, diagnostics: new Diagnostics(), router: new SessionRouter(),
        handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env,
      }), { name, args }, {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: thread },
        rid: name,
        kind: "command",
      }),
    });
  } finally {
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
  }
}

test("a heartbeat runs while a reply in home is still generating, and its message lands in home after that reply", async () => {
  await withCharacter(async ({ runtime, script, say, heartbeat, thread, shown }) => {
    await say("hello");
    const held = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    script.held = held;
    at(1);
    const replying = say("is the lamp lit?");
    await held.started.promise;

    at(2);
    const ticking = heartbeat();
    await shown("heartbeat", (message) => message.role === "assistant" && message.content.includes("I found the keeper's log."));
    expect(script.heartbeats).toHaveLength(2);
    expect((await thread("main")).filter((message) => message.origin === "autonomous")).toEqual([]);

    at(3);
    held.release.resolve();
    await replying;
    await ticking;

    expect((await thread("main")).map((message) => [message.role, message.origin ?? "", message.content])).toEqual([
      ["user", "", "hello"],
      ["assistant", "", "reply to: hello"],
      ["user", "", "is the lamp lit?"],
      ["assistant", "", "reply to: is the lamp lit?"],
      ["assistant", "autonomous", "I found the keeper's log."],
    ]);
    expect((await thread("main")).at(-1)?.content_blocks).toEqual([{ type: "text", text: "I found the keeper's log." }]);
    expect(runtime.registry.heartbeatThread("ada")).toBe("heartbeat");
  });
});

test("the heartbeat's own turn stays in its thread for the user to read, and the next one starts fresh with only what was said in home since", async () => {
  await withCharacter(async ({ script, say, heartbeat, thread }) => {
    await say("the keeper's name is Mara");
    at(10);
    await heartbeat();

    const kept = await thread("heartbeat");
    expect(kept.map((message) => [message.role, message.origin ?? ""])).toEqual([
      ["user", "autonomous"],
      ["system", "autonomous"],
      ["assistant", ""],
      ["user", ""],
      ["assistant", ""],
    ]);
    expect(kept[0]?.content).toContain("the keeper's name is Mara");
    expect(kept[1]?.content).toContain("This is a private heartbeat turn");
    expect(kept.at(-1)?.content_blocks.map((block) => block.type)).toEqual(["thinking", "text"]);

    at(20);
    await say("she keeps a cat too");
    at(30);
    await heartbeat();

    const opener = (await thread("heartbeat")).filter((message) => message.role === "user" && message.origin === "autonomous").at(-1)?.content ?? "";
    expect(opener).toContain("since your last heartbeat");
    expect(opener).toContain("she keeps a cat too");
    expect(opener).toContain("reply to: she keeps a cat too");
    expect(opener).not.toContain("the keeper's name is Mara");
    const next = script.heartbeats.at(-2) as SidecarRequest;
    expect(textOf(next)).not.toContain("the keeper's name is Mara");
    expect(textOf(next)).not.toContain("She asked about the lamp");
    expect(next.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_use" || block.type === "tool_result")).toEqual([]);
  });
});

test("a heartbeat runs on home's model, and its thread is never compacted, however many heartbeats it holds, not even by hand", async () => {
  await withCharacter(async ({ runtime, script, say, heartbeat, thread }) => {
    await runtime.registry.setThreadModel("ada", "main", "pinned");
    await say("hello");
    at(10);
    await heartbeat();
    at(20);
    await heartbeat();

    expect(script.heartbeats.map((request) => request.model)).toEqual(["claude-pinned", "claude-pinned", "claude-pinned", "claude-pinned"]);
    expect(script.calls).not.toContain("compaction");
    expect((await thread("heartbeat")).filter((message) => message.role === "user" && message.origin === "autonomous")).toHaveLength(2);
    expect(runtime.registry.listThreads("ada").find((record) => record.id === "heartbeat")?.compaction).toBe(false);
    const byHand = runCompactionPass("ada", {
      config: runtime.config,
      generate: () => Promise.reject(new Error("compacting the heartbeat thread called the model")),
    }, { thread: "heartbeat" });
    expect(await outcomeOf(byHand)).toThrow("never compacted");
  }, (app) => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.min_turns = 1;
    app.memory.compaction.max_turns = 2;
  });
});

test("heartbeats and compaction keep the reasoning effort set for each on chat's model, and setting it for them never moves chat's", async () => {
  await withCharacter(async ({ runtime, script, say, heartbeat, command }) => {
    const effort = async (args: Record<string, unknown>): Promise<void> => {
      expect((await command("set_model_setting", { key: "reasoning_effort", ...args })).type).toBe("command_output");
    };
    const compactionEffort = async (): Promise<string | undefined> => {
      const sent: SidecarRequest[] = [];
      await runCompactionPass("ada", {
        config: runtime.config,
        generate: (request) => {
          sent.push(request);
          return Promise.resolve({
            model: request.model, content: "noted", content_blocks: [{ type: "text", text: "noted" }], finish_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
            timing: { total_ms: 1, time_to_first_token_ms: 1 },
          });
        },
      }, { thread: "main" });
      return sent[0]?.provider_options?.reasoning_effort;
    };
    const effortOf = (requests: SidecarRequest[]): (string | undefined)[] =>
      [...new Set(requests.map((request) => request.provider_options?.reasoning_effort))];

    await effort({ value: "high" });
    await effort({ value: "low", background_task: "heartbeat" });
    await effort({ value: "medium", background_task: "compaction", scope: "global" });
    await say("hello");
    await heartbeat();

    expect(effortOf(script.replies)).toEqual(["high"]);
    expect(script.heartbeats.map((request) => request.model)).toContain("claude-fixture");
    expect(effortOf(script.heartbeats)).toEqual(["low"]);
    expect(await compactionEffort()).toBe("medium");

    await effort({ value: "max", background_task: "all" });
    script.heartbeats.length = 0;
    at(10);
    await heartbeat();
    await say("again");

    expect(effortOf(script.heartbeats)).toEqual(["max"]);
    expect(await compactionEffort()).toBe("max");
    expect(effortOf(script.replies)).toEqual(["high"]);

    await effort({ value: null, background_task: "heartbeat" });
    script.heartbeats.length = 0;
    at(20);
    await heartbeat();

    expect(effortOf(script.heartbeats)).toEqual(["high"]);
  }, (app) => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.min_turns = 1;
  });
});

test("with defer_on_activity, each message and the end of each reply push the next heartbeat to min_interval after them, in a side thread too", async () => {
  await withCharacter(async ({ runtime, script, say, command }) => {
    const wake = (): number | undefined => runtime.autonomy.status("ada")?.next_wake_at;
    await say("hello");
    await runtime.autonomy.tick();
    expect(wake()).toBe(T0 + 60 * MINUTE);

    at(50);
    await say("are you there?");
    expect(wake()).toBe(T0 + 110 * MINUTE);

    await runtime.registry.createThread("ada", "side");
    at(70);
    const held = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    script.held = held;
    const replying = say("psst", "side");
    await held.started.promise;
    expect(wake()).toBe(T0 + 130 * MINUTE);
    at(80);
    held.release.resolve();
    await replying;
    expect(wake()).toBe(T0 + 140 * MINUTE);
    expect(JSON.stringify(await command("run_tool", { tool: "guide", input: { topic: "wakes" } }))).toMatch(/- Each message from \S+, in any thread, and the end of each reply to one, pushes the next heartbeat to at least 1h later\. It never brings it closer\./);
  }, (app) => {
    app.behavior.autonomy.heartbeat.defer_on_activity = true;
  });
});

test("a heartbeat's own turn notifies nobody and leaves its thread with nothing unread, while its message counts in home", async () => {
  await withCharacter(async ({ data, emitted, say, heartbeat, thread }) => {
    await say("hello");
    at(5);
    await heartbeat();
    markThreadRead(data, "ada", "heartbeat", T0 + 6 * MINUTE);
    markThreadRead(data, "ada", "main", T0 + 6 * MINUTE);

    at(10);
    await heartbeat();
    expect((await thread("heartbeat")).filter((message) => message.role === "assistant" && message.content.includes("I found the keeper's log."))).toHaveLength(2);
    expect(emitted.map((event) => [event.thread, event.msg.role, event.msg.content])).toEqual([
      ["main", "assistant", "I found the keeper's log."],
      ["main", "assistant", "I found the keeper's log."],
    ]);
    expect(threadActivityNow(data, "ada", "heartbeat").unread).toBe(0);
    expect(threadActivityNow(data, "ada", "main").unread).toBe(1);
  });
});

test("a picture a heartbeat sends is in its thread as well as home, and one it only mentions is in neither", async () => {
  await withCharacter(async ({ script, workspace, say, heartbeat, thread }) => {
    await writeFile(join(workspace, "lamp.png"), await sizedImage(8, 8));
    await writeFile(join(workspace, "sketch.png"), await sizedImage(16, 16));
    script.closing = "I kept ![[sketch.png]] to myself.\n\n<sendMessage>\nThe lamp tonight\n![[lamp.png]]\n</sendMessage>";
    await say("hello");
    at(10);
    await heartbeat();

    const delivered = (await thread("main")).at(-1);
    expect(delivered?.content).toBe("The lamp tonight\n![[lamp.png]]");
    expect(delivered?.images).toEqual([{ path: expect.stringContaining("/sent/") as string, embed: "![[lamp.png]]", name: "lamp.png" }]);
    expect((await thread("heartbeat")).at(-1)?.images).toEqual(delivered?.images ?? []);
  });
});

test("the user can read the heartbeat thread but not write there", async () => {
  await withCharacter(async ({ say, heartbeat, thread }) => {
    await say("hello");
    await heartbeat();
    const before = await thread("heartbeat");

    expect(await outcomeOf(say("can I join?", "heartbeat"))).toThrow("is where ada's heartbeats run");
    expect(await thread("heartbeat")).toEqual(before);
  });
});

function compactsWhenIdle(app: AppConfig): void {
  app.memory.compaction.enabled = true;
  app.memory.compaction.keep_recent_turns = 0;
  app.memory.compaction.min_turns = 1;
  app.memory.compaction.idle_trigger = ConfigDuration.fromSecs(50 * 60);
}

const shownIn = async (thread: (id: string) => Promise<readonly Message[]>): Promise<string[][]> =>
  (await thread("main")).map((message) => [message.role, message.origin ?? "", message.content]);

async function repliedAt(minutes: number, script: Script, send: () => Promise<void>): Promise<void> {
  const held = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  script.held = held;
  const replying = send();
  await held.started.promise;
  at(minutes);
  held.release.resolve();
  await replying;
}

test("a heartbeat's message that lands in home just before idle compaction stays there unread, and the next reply has it in context", async () => {
  await withCharacter(async ({ data, script, say, heartbeat, thread }) => {
    await say("the keeper's name is Mara");
    markThreadRead(data, "ada", "main", T0);

    at(60);
    await heartbeat();

    expect(script.calls).toContain("compaction");
    expect(await shownIn(thread)).toEqual([["assistant", "autonomous", "I found the keeper's log."]]);
    expect(threadActivityNow(data, "ada", "main").unread).toBe(1);

    at(8 * 60);
    await say("good morning");
    const next = script.replies.at(-1) as SidecarRequest;
    expect(next.messages[0]?.role).toBe("user");
    expect(textOf(next)).toContain("I found the keeper's log.");
  }, compactsWhenIdle);
});

test("a reply the user never saw stays in home through idle compaction and the deep-idle archive after it", async () => {
  await withCharacter(async ({ runtime, data, script, say, thread }) => {
    markThreadRead(data, "ada", "main", T0 - MINUTE);
    await repliedAt(1, script, () => say("is the lamp lit?"));
    runtime.autonomy.forceHeartbeatState("ada", "dormant");
    const unseen = [["assistant", "", "reply to: is the lamp lit?"]];

    at(60);
    await runtime.autonomy.tick();
    expect(script.calls).toContain("compaction");
    expect(await shownIn(thread)).toEqual(unseen);

    at(25 * 60);
    await runtime.autonomy.tick();
    expect(await shownIn(thread)).toEqual(unseen);
    expect(threadActivityNow(data, "ada", "main").unread).toBe(1);
  }, (app) => {
    compactsWhenIdle(app);
    app.memory.compaction.archive_after = ConfigDuration.fromSecs(24 * 60 * 60);
  });
});

test("a side thread trimmed for room without compaction keeps its newest reply while the user hasn't read it", async () => {
  await withCharacter(async ({ runtime, data, script, say, thread }) => {
    await runtime.registry.createThread("ada", "side");
    markThreadRead(data, "ada", "side", T0 - MINUTE);
    await repliedAt(1, script, () => say(`${"the lamp ".repeat(80_000)}\nwhich lamp?`, "side"));

    expect((await thread("side")).map((message) => [message.role, message.content])).toEqual([["assistant", "reply to: which lamp?"]]);
    expect(threadActivityNow(data, "ada", "side").unread).toBe(1);
  }, (app) => {
    app.memory.compaction.keep_recent_turns = 0;
  });
});

test("bare --background tunes heartbeats and compaction on their pinned model while dreams keep the chat model's settings", async () => {
  await withCharacter(async ({ command }) => {
    const set = await command("set_model_setting", { key: "reasoning_effort", value: "low", background_task: "all" });
    expect(set).toMatchObject({ type: "command_output", data: { model: "chat.pinned", background_task: "all" } });
    expect(await command("model_settings", { background_task: "all" })).toMatchObject({ type: "command_output", data: { model: "chat.pinned" } });
    expect(await command("model_settings", { background_task: "dreaming" })).toMatchObject({ type: "command_output", data: { model: "chat.fixture", saved_character: null } });
  }, (app) => {
    app.defaults.background.heartbeat = "pinned";
    app.defaults.background.compaction = "pinned";
  });
});

const SHOWN = "[You scheduled this heartbeat with set_next_wake, giving this reason: ";

function wakeNote(request: SidecarRequest | undefined): string | undefined {
  const text = request === undefined ? "" : textOf(request);
  const start = text.indexOf(SHOWN);
  return start === -1 ? undefined : text.slice(start + SHOWN.length, text.indexOf("]\n", start));
}

function wakeTool(request: SidecarRequest | undefined): { description: string; reason: string } {
  const tool = request?.tools?.find((def) => def.name === "set_next_wake");
  const properties = tool?.input_schema["properties"] as Record<string, { description: string }>;
  return { description: tool?.description ?? "", reason: properties["reason"]?.description ?? "" };
}

test("a heartbeat starts with the reason its set_next_wake call gave, word for word, and only that heartbeat does", async () => {
  await withCharacter(async ({ runtime, script, say, heartbeat, thread }) => {
    const first = "check the tide table for {{user}} {{#if now}}at {{now}}{{/if}} $& wake_reason";
    await say("hello");
    script.wake = { hours_from_now: 2, reason: first };
    at(10);
    await heartbeat();
    expect(wakeNote(script.heartbeats[0]), "a heartbeat no set_next_wake call scheduled").toBeUndefined();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain("PM]\n\n[This is a private heartbeat turn.");
    expect(runtime.autonomy.status("ada")?.next_wake_at).toBe(T0 + 130 * MINUTE);
    expect(runtime.autonomy.status("ada")?.recent_events.map((event) => event.detail)).toContain(`set_next_wake: 2.0h - ${first}`);

    script.heartbeats.length = 0;
    script.wake = { hours_from_now: 3, reason: "water the fern" };
    at(20);
    await heartbeat();
    expect(wakeNote(script.heartbeats[0])).toBe(first);
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain(`PM]\n\n${SHOWN}${first}]\n\n[This is a private heartbeat turn.`);
    expect(wakeNote(script.heartbeats[1]), "a call made during a heartbeat leaves that heartbeat's own reason alone").toBe(first);
    expect((await thread("heartbeat")).filter((message) => message.role === "system").at(-1)?.content).toContain(`${SHOWN}${first}]`);

    script.heartbeats.length = 0;
    at(30);
    await heartbeat();
    expect(wakeNote(script.heartbeats[0])).toBe("water the fern");

    script.heartbeats.length = 0;
    await say("still here");
    at(40);
    await heartbeat();
    expect(script.heartbeats).toHaveLength(2);
    expect(wakeNote(script.heartbeats[0]), "a reason is shown once").toBeUndefined();
    expect(runtime.autonomy.scheduleNextWake("ada", 3, "later")).toBe(3);
  }, (app) => {
    app.behavior.autonomy.heartbeat.min_interval = ConfigDuration.fromSecs(60n);
  });
});

test("a reason given in a chat reply waits for its heartbeat through later messages and a restart, and a later call replaces it", async () => {
  const root = await mkdtemp(testTmp("shore-wake-reason-"));
  at(0);
  await withCharacter(async ({ runtime, script, say, command }) => {
    script.replyWake = { hours_from_now: 2, reason: "an earlier plan" };
    await say("goodnight");
    script.replyWake = { hours_from_now: 4, reason: "ask how the interview went" };
    await say("actually, the interview is tomorrow");
    expect(runtime.autonomy.status("ada")?.next_wake_at).toBe(T0 + 240 * MINUTE);
    expect(script.replies.map((request) => wakeTool(request).reason)).toEqual(Array.from(script.replies, () => "A note to yourself for that heartbeat, which shows it to you when it starts. Also recorded in the heartbeat log."));
    expect(wakeTool(script.replies[0]).description).toContain("A later call replaces the earlier schedule, and the result says how many hours were actually scheduled.");
    const guide = JSON.stringify(await command("run_tool", { tool: "guide", input: { topic: "wakes" } }));
    expect(guide).toMatch(/- Messages from \S+ don't move the next heartbeat\./);
    expect(guide).toContain("The `reason` you give `set_next_wake` is shown to you when that heartbeat starts, word for word.");
  }, undefined, root);

  at(60);
  await withCharacter(async ({ runtime, script, say, heartbeat }) => {
    await say("good morning");
    expect(runtime.autonomy.status("ada")?.next_wake_at).toBe(T0 + 240 * MINUTE);
    at(70);
    await heartbeat();
    expect(wakeNote(script.heartbeats[0])).toBe("ask how the interview went");
  }, undefined, root);
});

test("a reason is dropped when its wake is, by dormancy or a blank reason, so a later heartbeat doesn't start with a stale one", async () => {
  await withCharacter(async ({ script, say, heartbeat, command }) => {
    script.replyWake = { hours_from_now: 2, reason: "look in on the bees" };
    await say("hello");
    expect((await command("heartbeat_set_dormant", {})).type).toBe("command_output");
    at(10);
    await say("back again");
    await heartbeat();
    expect(wakeNote(script.heartbeats[0]), "after the character was put to sleep").toBeUndefined();

    script.heartbeats.length = 0;
    script.replyWake = { hours_from_now: 2, reason: "count the hives" };
    await say("one");
    script.replyWake = { hours_from_now: 2, reason: "  \n" };
    await say("two");
    at(20);
    await heartbeat();
    expect(wakeNote(script.heartbeats[0]), "after a call with a blank reason").toBeUndefined();
  });
});

test("a character whose own heartbeat.md leaves the reason out is told set_next_wake only logs it", async () => {
  await withCharacter(async ({ script, say, heartbeat, workspace, command }) => {
    const prompts = join(workspace, "..", "prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "heartbeat.md"), "[Private turn at {{now}}. {{#if wake_reason}}You left a note.{{/if}}]");
    script.replyWake = { hours_from_now: 2, reason: "look in on the bees" };
    await say("hello");
    const offered = wakeTool(script.replies[0]);
    expect(offered.reason).toBe("Why this time. Recorded in the heartbeat log. That heartbeat doesn't show it to you.");
    expect(JSON.stringify(await command("run_tool", { tool: "guide", input: { topic: "wakes" } }))).toContain("The `reason` you give `set_next_wake` is only kept in the heartbeat log. That heartbeat doesn't show it to you, so leave a note for it in a file or in your diary.");
    at(10);
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain("PM. You left a note.]");
    expect(textOf(script.heartbeats[0] as SidecarRequest)).not.toContain("bees");

    await writeFile(join(prompts, "heartbeat.md"), "[Private turn. {{wake_reason}}]");
    const described = await command("run_tool", { tool: "set_next_wake", describe: true });
    expect(JSON.stringify(described)).toContain("A note to yourself for that heartbeat, which shows it to you when it starts.");
    expect(JSON.stringify(described)).not.toContain("{{");
    script.heartbeats.length = 0;
    at(20);
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest), "a heartbeat with no reason leaves the macro empty").toContain("[Private turn. ]");
  });
});

function left(minutes: number, text: string): DiaryNote {
  return { id: "", at: new Date(T0 + minutes * MINUTE).toISOString(), thread: "heartbeat", source: "heartbeat", text };
}

function times(text: string, part: string): number {
  return text.split(part).length - 1;
}

test("what a heartbeat says at the end, apart from the message it sends, is the note its later heartbeats start with for a day", async () => {
  await withCharacter(async ({ script, say, heartbeat, thread }) => {
    await say("hello");
    script.closing = "Read the keeper's log up to March.\n<sendMessage>I found the keeper's log.</sendMessage>";
    at(10);
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).not.toContain("[Your diary");
    expect((await thread("main")).at(-1)?.content).toBe("I found the keeper's log.");

    const diary = diaryText([left(10, "Read the keeper's log up to March.")], DIARY_FOR_HEARTBEAT, hostZone());
    script.heartbeats.length = 0;
    script.aside = "March is done, so April is next.";
    script.closing = "HEARTBEAT_OK";
    at(70);
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain(`in your home thread "main".]\n\n${diary}\n\n[Current time: `);
    expect(diary).toStartWith("[Your diary from the last day. Each entry says where it came from.]\n\nyour note at the end of a heartbeat · ");
    expect(diary).toEndWith("\nRead the keeper's log up to March.\n\n[End of your diary.]");

    script.heartbeats.length = 0;
    script.aside = undefined;
    script.closing = "<sendMessage>Goodnight.</sendMessage>";
    at(130);
    await heartbeat();
    const third = textOf(script.heartbeats[0] as SidecarRequest);
    expect(third).toContain(`${diary}\n\n[Current time: `);
    expect(third).not.toContain("April is next");

    at(24 * 60 + 9);
    await say("good morning");
    script.heartbeats.length = 0;
    script.closing = "HEARTBEAT_OK";
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain(diary);

    at(24 * 60 + 11);
    await say("still here");
    script.heartbeats.length = 0;
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).not.toContain("[Your diary");
  });
});

test("the user's next message in each thread arrives with the notes left since the character was last there, once, and they stay with that message", async () => {
  const note = left(10, "The log is read up to March.");
  const block = diaryText([note], DIARY_FOR_CHAT, hostZone());
  let root = "";
  await withCharacter(async ({ runtime, script, data, say, heartbeat, thread }) => {
    root = dirname(data);
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    expect(textOf(script.replies[0] as SidecarRequest)).not.toContain("diary");
    script.closing = "The log is read up to March.";
    at(10);
    await heartbeat();
    expect((await thread("main")).filter((message) => message.origin === "autonomous")).toEqual([]);

    at(20);
    await say("is the lamp lit?");
    expect(textOf(script.replies[1] as SidecarRequest)).toEndWith(`${block}\nis the lamp lit?`);

    at(21);
    await say("and the door?");
    const later = textOf(script.replies[2] as SidecarRequest);
    expect(later).toContain(`${block}\nis the lamp lit?`);
    expect(later).toEndWith("reply to: is the lamp lit?\nand the door?");
    expect(times(later, "[New in your diary")).toBe(1);
    expect((await thread("main")).flatMap((message) => message.diary === undefined ? [] : [[message.content, message.diary.map((each) => [each.at, each.thread, each.source, each.text])]])).toEqual([
      ["is the lamp lit?", [[note.at, "heartbeat", "heartbeat", "The log is read up to March."]]],
    ]);

    at(22);
    await say("the beans are up", "garden");
    expect(textOf(script.replies[3] as SidecarRequest)).toEndWith(`${block}\nthe beans are up`);
  });

  await withCharacter(async ({ script, say }) => {
    at(30);
    await say("anything new?");
    const resumed = textOf(script.replies[0] as SidecarRequest);
    expect(resumed).toContain(`${block}\nis the lamp lit?`);
    expect(resumed).toEndWith("reply to: and the door?\nanything new?");
    expect(times(resumed, "[New in your diary")).toBe(1);
  }, undefined, root);
});

function hold(): { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } {
  return { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
}

test("a heartbeat is told once, at its next step, that the user wrote while it was running, whichever thread they wrote in", async () => {
  await withCharacter(async ({ runtime, script, say, heartbeat, thread }) => {
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    at(10);
    await heartbeat();
    expect(script.heartbeats.map(textOf).join("\n")).not.toContain("has just written to you");

    for (const [minutes, where] of [[20, "main"], [40, "garden"]] as const) {
      script.heartbeats.length = 0;
      script.again = 1;
      const held = hold();
      script.beatHeld = held;
      at(minutes);
      const ticking = heartbeat();
      await held.started.promise;
      at(minutes + 1);
      await say("are you there?", where);
      at(minutes + 2);
      await say("hello?", where);
      held.release.resolve();
      await ticking;

      const note = userWroteNote(T0 + (minutes + 1) * MINUTE, "User", hostZone());
      expect(script.heartbeats).toHaveLength(3);
      expect(textOf(script.heartbeats[0] as SidecarRequest)).not.toContain("has just written to you");
      expect(textOf(script.heartbeats[1] as SidecarRequest)).toEndWith(note);
      expect(times(textOf(script.heartbeats[2] as SidecarRequest), "has just written to you")).toBe(1);
      expect((await thread("heartbeat")).filter((message) => message.role === "system").at(-1)?.content).toBe(note);
    }
  });
});

test("a message sent while a heartbeat runs tells that turn a heartbeat is running, since when and why, once in each thread, and the note stays with the message", async () => {
  const started = new Date(T0 + 20 * MINUTE).toISOString();
  const running = heartbeatRunningText({ started_at: started, reason: "check the tide table" }, hostZone());
  let root = "";
  await withCharacter(async ({ runtime, script, data, say, heartbeat, thread }) => {
    root = dirname(data);
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    script.wake = { hours_from_now: 2, reason: "check the tide table" };
    at(10);
    await heartbeat();
    at(11);
    await say("nothing is running now");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).not.toContain("A heartbeat of yours");

    const held = hold();
    script.beatHeld = held;
    at(20);
    const ticking = heartbeat();
    await held.started.promise;
    expect(runtime.autonomy.runningHeartbeats()).toEqual([{ character: "ada", startedAt: T0 + 20 * MINUTE }]);
    at(21);
    await say("is the lamp lit?");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(`${running}\nis the lamp lit?`);

    at(22);
    await say("and the door?");
    const later = textOf(script.replies.at(-1) as SidecarRequest);
    expect(times(later, "A heartbeat of yours")).toBe(1);
    expect(later).toEndWith("reply to: is the lamp lit?\nand the door?");

    at(23);
    await say("the beans are up", "garden");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(`${running}\nthe beans are up`);

    held.release.resolve();
    await ticking;
    expect(runtime.autonomy.runningHeartbeats()).toEqual([]);
    expect((await thread("main")).flatMap((message) => message.heartbeat_running === undefined ? [] : [[message.content, message.heartbeat_running]])).toEqual([
      ["is the lamp lit?", { started_at: started, reason: "check the tide table" }],
    ]);
  });

  await withCharacter(async ({ script, say }) => {
    at(30);
    await say("anything new?");
    const resumed = textOf(script.replies[0] as SidecarRequest);
    expect(resumed).toContain(`${running}\nis the lamp lit?`);
    expect(times(resumed, "A heartbeat of yours")).toBe(1);
  }, undefined, root);
});

test("each side is told about the other in these words, with the heartbeat's reason only when it has one", () => {
  const started = new Date(T0).toISOString();
  expect(heartbeatRunningText({ started_at: started }, "UTC")).toBe(
    "[A heartbeat of yours has been running since Friday 2026-10-30 · 12:00 PM. It can't see this conversation. It is only told that a message arrived.]",
  );
  expect(heartbeatRunningText({ started_at: started, reason: "check the tide table" }, "UTC")).toBe(
    "[A heartbeat of yours has been running since Friday 2026-10-30 · 12:00 PM. It can't see this conversation. It is only told that a message arrived. " +
    "You scheduled it with set_next_wake, giving this reason: check the tide table]",
  );
  expect(userWroteNote(T0 + MINUTE, "eve", "UTC")).toBe(
    "[eve has just written to you, at Friday 2026-10-30 · 12:01 PM, while this heartbeat is running. " +
    "Another turn of you is answering them, and it knows this heartbeat is running.]",
  );
  expect(heartbeatRunningText({ started_at: started, thread: "ring" }, "UTC")).toBe(
    '[A wake of yours in "ring" has been running since Friday 2026-10-30 · 12:00 PM. It can\'t see this conversation. It is only told that a message arrived.]',
  );
  expect(userWroteNote(T0 + MINUTE, "eve", "UTC", "wake")).toBe(
    "[eve has just written to you, at Friday 2026-10-30 · 12:01 PM, while this wake is running. " +
    "Another turn of you is answering them, and it knows this wake is running.]",
  );
});

test("a trigger that fires wakes the character with what it said, and leaves the heartbeat it scheduled for itself alone", async () => {
  await withCharacter(async ({ runtime, script, say, heartbeat }) => {
    const events = (): string[] => runtime.autonomy.log("ada", 100).map((event) => event.detail);
    await say("hello");
    script.wake = { hours_from_now: 2, reason: "water the fern" };
    at(10);
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).not.toContain("Your trigger");
    expect(events().filter((detail) => detail === "Heartbeat tick fired")).toHaveLength(1);

    const tide = { name: "tide-table", reason: "the tide is out", at: T0 + 19 * MINUTE };
    const lamp = { name: "lamp", reason: "the lamp is low", at: T0 + 20 * MINUTE };
    script.heartbeats.length = 0;
    at(20);
    expect(runtime.autonomy.wakeFor("ada", tide)).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(2);
    const woken = textOf(script.heartbeats[0] as SidecarRequest);
    expect(woken).toContain(`in your home thread "main".]\n\n${triggerFiredNote(tide, hostZone())}\n\n${triggerFiredNote(lamp, hostZone())}\n\n[Current time: `);
    expect(woken).not.toContain("water the fern");
    expect(runtime.autonomy.status("ada")?.next_wake_at).toBe(T0 + 130 * MINUTE);
    expect(events()).toContain('Woken by trigger "tide-table", "lamp"');
    expect(events().filter((detail) => detail === "Heartbeat tick fired")).toHaveLength(1);

    script.heartbeats.length = 0;
    at(21);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(0);

    at(22);
    expect(runtime.autonomy.wakeFor("ada", { ...tide, at: T0 + 22 * MINUTE })).toBe("queued");
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(2);
    expect(events()).toContain('Woken by trigger "tide-table"');
    script.heartbeats.length = 0;

    at(131);
    expect(runtime.autonomy.wakeFor("ada", { ...lamp, at: T0 + 131 * MINUTE })).toBe("queued");
    await runtime.autonomy.tick();
    const both = textOf(script.heartbeats[0] as SidecarRequest);
    expect(both).toContain(`${triggerFiredNote({ ...lamp, at: T0 + 131 * MINUTE }, hostZone())}\n\n[Current time: `);
    expect(both).toContain("giving this reason: water the fern]");
    expect(events().filter((detail) => detail === "Heartbeat tick fired")).toHaveLength(2);
    expect(runtime.autonomy.wakeFor("nobody", lamp)).toBeUndefined();
  });
});

test("a trigger that fires while the character is dormant, or with heartbeats off, wakes nothing then or later", async () => {
  const lamp = { name: "lamp", reason: "the lamp is low", at: T0 + 10 * MINUTE };
  await withCharacter(async ({ runtime, script, say }) => {
    await say("hello");
    expect(runtime.autonomy.forceHeartbeatState("ada", "dormant")).toBe(true);
    at(10);
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(0);

    at(20);
    await say("I'm back");
    at(90);
    await runtime.autonomy.tick();
    expect(script.heartbeats.length).toBeGreaterThan(0);
    expect(script.heartbeats.map(textOf).join("\n")).not.toContain("Your trigger");
  });

  await withCharacter(async ({ runtime, script, say }) => {
    await say("hello");
    at(10);
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(0);
  }, (app) => { app.behavior.autonomy.enabled = false; });
});

test("a trigger that fires during a heartbeat is handed to that heartbeat at its next step, along with word that the user wrote", async () => {
  await withCharacter(async ({ runtime, script, say, heartbeat }) => {
    await say("hello");
    const held = hold();
    script.beatHeld = held;
    script.again = 1;
    at(10);
    const ticking = heartbeat();
    await held.started.promise;
    const tide = { name: "tide-table", reason: "the tide is out", at: T0 + 11 * MINUTE };
    const lamp = { name: "lamp", reason: "the lamp is low", at: T0 + 13 * MINUTE };
    at(11);
    expect(runtime.autonomy.wakeFor("ada", tide)).toBe("handed");
    at(12);
    await say("are you there?");
    at(13);
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("handed");
    held.release.resolve();
    await ticking;

    expect(script.heartbeats).toHaveLength(3);
    expect(textOf(script.heartbeats[1] as SidecarRequest)).toEndWith(
      `${triggerFiredNote(tide, hostZone())}\n\n${userWroteNote(T0 + 12 * MINUTE, "User", hostZone())}\n\n${triggerFiredNote(lamp, hostZone())}`,
    );
    expect(times(textOf(script.heartbeats[2] as SidecarRequest), "Your trigger")).toBe(2);

    script.heartbeats.length = 0;
    at(14);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(0);
  });
});

test("a trigger's firing is told in these words, and nothing new means no note", () => {
  const tide = { name: "tide-table", reason: "the tide is out", at: T0 + MINUTE };
  expect(triggerFiredNote(tide, "UTC")).toBe('[Your trigger "tide-table" fired at Friday 2026-10-30 · 12:01 PM: the tide is out]');
  expect(heartbeatNewsNote([], "eve", "UTC")).toBeUndefined();
  expect(heartbeatNewsNote([{ kind: "user_wrote", at: T0 }, { kind: "trigger", firing: tide }], "eve", "UTC")).toBe(
    `${userWroteNote(T0, "eve", "UTC")}\n\n${triggerFiredNote(tide, "UTC")}`,
  );
});

function withTriggers(app: AppConfig): void {
  app.behavior.autonomy.triggers.enabled = true;
}

function diaryOf(data: string): [from: string, text: string][] {
  return unfoldedDiary(join(data, "ada")).map((note) => [note.source === "trigger" ? note.trigger ?? "" : note.source, note.text]);
}

test("a trigger in the character's file wakes it when its check prints, and the check is handed what Shore knows", async () => {
  await withCharacter(async ({ runtime, script, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), [
      "[tide]",
      'every = "10m"',
      `check = 'printf "%s|%s|%s|%s|" "$SHORE_TRIGGER" "$SHORE_NOW" "$SHORE_USER_QUIET_SECS" "$SHORE_USER_LAST_MESSAGE_AT"; cat'`,
      "",
    ].join("\n"));
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    setPresence(data, "asleep", T0 + 2 * MINUTE);
    noteSeen(data, T0 + 3 * MINUTE);
    at(11);
    await runtime.triggers.tick();
    expect(script.heartbeats).toHaveLength(0);
    await runtime.autonomy.tick();

    const woken = textOf(script.heartbeats[0] as SidecarRequest);
    expect(woken).toContain(
      '[Your trigger "tide" fired at Friday 2026-10-30 · ',
    );
    const printed = woken.slice(woken.indexOf(" PM: tide|") + " PM: ".length, woken.indexOf("]\n\n[Current time: "));
    const [name, now, quiet, last, ...stdin] = printed.split("|");
    expect([name, now, quiet, last]).toEqual(["tide", "2026-10-30T12:11:00.000Z", "660", "2026-10-30T12:00:00.000Z"]);
    const facts = JSON.parse(stdin.join("|")) as { now: string; user: unknown; activity: { messages: number; share_of_messages_by_local_hour: number[]; median_secs_between_sessions: number | null } };
    expect(facts.now).toBe("2026-10-30T12:11:00.000Z");
    expect(facts.user).toEqual({ last_message_at: "2026-10-30T12:00:00.000Z", quiet_secs: 660, last_seen_at: "2026-10-30T12:03:00.000Z", status: "asleep", status_set_at: "2026-10-30T12:02:00.000Z" });
    expect(Object.keys(facts.activity)).toEqual(["messages", "share_of_messages_by_local_hour", "median_secs_between_sessions"]);
    expect(facts.activity.messages).toBe(1);
    expect(facts.activity.share_of_messages_by_local_hour).toHaveLength(24);
    expect(facts.activity.share_of_messages_by_local_hour.reduce((sum, share) => sum + share, 0)).toBe(1);
    expect(facts.activity.median_secs_between_sessions).toBeNull();
    expect(runtime.triggers.view("ada")).toMatchObject({ enabled: true, problems: [], triggers: [{ fired: 1, lastFiredAt: T0 + 11 * MINUTE, off: false }] });
  }, withTriggers);
});

test("what a trigger for the user's return says arrives with their message, and the character's first message ever sets none off", async () => {
  await withCharacter(async ({ script, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `[welcome]\nwhen = "user_back"\nafter = "8h"\ncheck = 'echo "away $SHORE_USER_QUIET_SECS seconds"'\n\n[always]\nwhen = "user_back"\nafter = "1s"\nreason = "They wrote."\n`);
    await say("hello");
    expect(diaryOf(data)).toEqual([]);
    at(9 * 60);
    await say("I'm back");
    expect(diaryOf(data)).toEqual([["welcome", "away 32400 seconds"], ["always", "They wrote."]]);
    const reply = textOf(script.replies.at(-1) as SidecarRequest);
    expect(reply).toContain('from your trigger "welcome" · ');
    expect(reply).toEndWith("They wrote.\n\n[End of your diary.]\n[9 hours later · Friday 2026-10-30 · 9:00 PM]\n\nI'm back");

    at(9 * 60 + 1);
    await say("still here");
    expect(diaryOf(data)).toEqual([["welcome", "away 32400 seconds"], ["always", "They wrote."]]);
    const next = textOf(script.replies.at(-1) as SidecarRequest);
    expect(times(next, 'from your trigger "welcome"')).toBe(1);
    expect(next).toEndWith('[New in your diary. Each entry says where it came from.]\n\nfrom your trigger "always" · Friday 2026-10-30 · 9:01 PM\nThey wrote.\n\n[End of your diary.]\nstill here');

    const before = unfoldedDiary(join(data, "ada")).map((note) => note.at);
    at(18 * 60 + 1);
    await say("");
    expect(unfoldedDiary(join(data, "ada")).map((note) => note.at)).toEqual(before);
  }, withTriggers);
});

test("a follower's turn comes once the wake its leader caused is over, whether that wake was started for it or it joined one already running", async () => {
  const file = '[lamp]\nevery = "10m"\nreason = "Trim the lamp."\ncooldown = "1m"\n\n[after]\nfollows = "lamp"\nreason = "Write it up."\nwake = false\n';
  await withCharacter(async ({ runtime, script, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), file);
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    at(11);
    await runtime.triggers.tick();
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([]);
    await runtime.autonomy.tick();
    expect(script.heartbeats.length).toBeGreaterThan(0);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["after", "Write it up."]]);

    const held = hold();
    script.beatHeld = held;
    at(20);
    const ticking = runtime.autonomy.forceHeartbeatNow("ada") === undefined ? Promise.resolve() : runtime.autonomy.tick();
    await held.started.promise;
    at(21);
    await runtime.triggers.tick();
    expect(runtime.triggers.view("ada").triggers.map((each) => each.fired)).toEqual([2, 1]);
    held.release.resolve();
    await ticking;
    at(22);
    await runtime.triggers.tick();
    expect(runtime.triggers.view("ada").triggers.map((each) => each.fired)).toEqual([2, 2]);
  }, withTriggers);
});

test("a trigger that fires while a heartbeat is writing its last words isn't lost: it wakes the character once that heartbeat is over, and only then is its follower set off", async () => {
  const file = '[lamp]\nevery = "10m"\nreason = "Trim the lamp."\ncooldown = "1m"\n\n[after]\nfollows = "lamp"\nreason = "Write it up."\nwake = false\n';
  await withCharacter(async ({ runtime, script, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), file);
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    const end = hold();
    script.endHeld = end;
    at(10);
    const ticking = runtime.autonomy.forceHeartbeatNow("ada") === undefined ? Promise.resolve() : runtime.autonomy.tick();
    await end.started.promise;
    at(11);
    await runtime.triggers.tick();
    expect(runtime.triggers.view("ada").triggers.map((each) => each.fired)).toEqual([1, 0]);
    end.release.resolve();
    await ticking;
    expect(script.heartbeats).toHaveLength(2);
    expect(script.heartbeats.map(textOf).join("\n")).not.toContain("Trim the lamp.");
    at(12);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([]);

    script.heartbeats.length = 0;
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(2);
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain('[Your trigger "lamp" fired at Friday 2026-10-30 · 12:11 PM: Trim the lamp.]');
    expect(runtime.autonomy.log("ada", 100).map((event) => event.detail)).toContain('Woken by trigger "lamp"');
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["after", "Write it up."]]);
    expect(runtime.triggers.view("ada").triggers.map((each) => each.fired)).toEqual([1, 1]);

    script.heartbeats.length = 0;
    at(13);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(0);
  }, withTriggers);
});

test("a trigger for a dream finishing gets its turn after a dream", async () => {
  await withCharacter(async ({ runtime, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), '[after-dream]\nwhen = "dream_done"\nreason = "Read what the dream changed."\nwake = false\n');
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([]);
    expect(runtime.autonomy.forceDreamNow("ada")).toBe("queued");
    await runtime.autonomy.tick();
    await runtime.autonomy.dreamsEnded();
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["after-dream", "Read what the dream changed."]]);
  }, withTriggers);
});

const TOUCH = '[touch]\nevery = "10m"\ncheck = "touch ran"\n';

async function looks(runtime: ShoreRuntime): Promise<void> {
  at(1);
  await runtime.triggers.tick();
  at(11);
  await runtime.triggers.tick();
}

test("the character's triggers run only when the user has turned them on, with heartbeats on, and not while it is dormant", async () => {
  await withCharacter(async ({ runtime, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), TOUCH);
    await say("hello");
    await looks(runtime);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    expect(runtime.triggers.view("ada").enabled).toBe(false);
  });

  await withCharacter(async ({ runtime, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), TOUCH);
    await say("hello");
    await looks(runtime);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    expect(runtime.triggers.view("ada").enabled).toBe(false);
  }, (app) => {
    withTriggers(app);
    app.behavior.autonomy.enabled = false;
  });

  await withCharacter(async ({ runtime, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), TOUCH);
    await say("hello");
    expect(runtime.autonomy.forceHeartbeatState("ada", "dormant")).toBe(true);
    await looks(runtime);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    expect(runtime.autonomy.forceHeartbeatState("ada", "active")).toBe(true);
    at(12);
    await runtime.triggers.tick();
    at(22);
    await runtime.triggers.tick();
    expect(existsSync(join(workspace, "ran"))).toBe(true);
  }, withTriggers);
});

test("the user's settings reach the character's triggers: a longer cooldown, a shorter check limit, and a trigger switched off by name", async () => {
  await withCharacter(async ({ runtime, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `${TOUCH}\n[slow]\nevery = "10m"\ncheck = "sleep 30"\nwake = false\n\n[lamp]\nevery = "10m"\nreason = "Trim the lamp."\n`);
    await say("hello");
    const started = performance.now();
    await looks(runtime);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    expect(diaryOf(data)).toEqual([["shore", "The check for your trigger `slow` failed: it was still running at its time limit and was stopped. It keeps being tried, and you'll be told again only once it has worked and then failed again."]]);
    expect(runtime.triggers.view("ada").triggers.map((each) => [each.trigger.name, each.off, each.trigger.cooldownMs, each.nextAt])).toEqual([
      ["touch", true, 3 * 60 * MINUTE, undefined],
      ["slow", false, 0, T0 + 21 * MINUTE],
      ["lamp", false, 3 * 60 * MINUTE, T0 + 191 * MINUTE],
    ]);
  }, (app) => {
    withTriggers(app);
    app.behavior.autonomy.triggers.off = ["touch"];
    app.behavior.autonomy.triggers.wake_cooldown = ConfigDuration.fromSecs(3 * 3600);
    app.behavior.autonomy.triggers.check_time_limit = ConfigDuration.fromMillis(300);
  });
});

test("a character with no triggers file has none, and a file that can't be read leaves the triggers it had running", async () => {
  await withCharacter(async ({ runtime, workspace, say }) => {
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    expect(runtime.triggers.view("ada")).toEqual({ enabled: true, triggers: [], problems: [] });

    await writeFile(join(workspace, "TRIGGERS.toml"), TOUCH);
    at(2);
    await runtime.triggers.tick();
    expect(runtime.triggers.view("ada").triggers.map((each) => each.trigger.name)).toEqual(["touch"]);
    await rm(join(workspace, "TRIGGERS.toml"));
    await mkdir(join(workspace, "TRIGGERS.toml"));
    at(3);
    await runtime.triggers.tick();
    expect(runtime.triggers.view("ada").triggers.map((each) => each.trigger.name)).toEqual(["touch"]);
    await rm(join(workspace, "TRIGGERS.toml"), { recursive: true });
    at(4);
    await runtime.triggers.tick();
    expect(runtime.triggers.view("ada").triggers).toEqual([]);
  }, withTriggers);
});

test("a check still running when Shore shuts down is stopped, and nothing is recorded as fired or failed", async () => {
  let looking: Promise<void> = Promise.resolve();
  let state = "";
  const started = performance.now();
  await withCharacter(async ({ runtime, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), '[slow]\nevery = "10m"\ncheck = "sleep 30"\nwake = false\n');
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    at(11);
    looking = runtime.triggers.tick();
    await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
    state = JSON.stringify([diaryOf(data), runtime.triggers.view("ada").triggers.map((each) => [each.fired, each.failing])]);
  }, withTriggers);
  await looking;
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(state).toBe("[[],[[0,false]]]");
});

test("the runtime's clocks look at the triggers every thirty seconds until they are stopped", async () => {
  await withCharacter(async ({ runtime, say }) => {
    await say("hello");
    let looked = 0;
    runtime.triggers.tick = async () => { looked += 1; };
    jest.useFakeTimers();
    try {
      const clocks = startRuntimeClocks(runtime);
      jest.advanceTimersByTime(29_999);
      expect(looked).toBe(0);
      jest.advanceTimersByTime(1);
      expect(looked).toBe(1);
      jest.advanceTimersByTime(30_000);
      expect(looked).toBe(2);
      clocks.stop();
      jest.advanceTimersByTime(90_000);
      expect(looked).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

test("the timer looks at the triggers again and again until it is stopped, and one failed look doesn't end it", async () => {
  let looked = 0;
  const service = { tick: async () => { looked += 1; if (looked === 1) throw new Error("the first look failed"); } } as unknown as TriggerService;
  const timer = startTriggerTimer(service, 5);
  await new Promise<void>((resolve) => { setTimeout(resolve, 80); });
  timer.stop();
  const seen = looked;
  expect(seen).toBeGreaterThan(2);
  await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
  expect(looked).toBe(seen);
});

test("a check is told the time, when the user last wrote and was last seen, and their status if they have set one", () => {
  const activity = { messages: 3 };
  const status = { status: "asleep", set_at: "2026-10-30T11:00:00.000Z" };
  expect(checkFacts(T0 + 90_500, { lastUserAt: T0, lastSeenAt: T0 + 30_000, status }, activity)).toEqual({
    facts: {
      now: "2026-10-30T12:01:30.500Z",
      user: { last_message_at: "2026-10-30T12:00:00.000Z", quiet_secs: 90, last_seen_at: "2026-10-30T12:00:30.000Z", status: "asleep", status_set_at: "2026-10-30T11:00:00.000Z" },
      activity,
    },
    env: {
      SHORE_NOW: "2026-10-30T12:01:30.500Z", SHORE_USER_LAST_MESSAGE_AT: "2026-10-30T12:00:00.000Z", SHORE_USER_QUIET_SECS: "90",
      SHORE_USER_LAST_SEEN_AT: "2026-10-30T12:00:30.000Z", SHORE_USER_STATUS: "asleep", SHORE_USER_STATUS_SET_AT: "2026-10-30T11:00:00.000Z",
    },
  });
  const nothing = {
    facts: { now: "2026-10-30T12:00:00.000Z", user: { last_message_at: null, quiet_secs: null, last_seen_at: null, status: null, status_set_at: null }, activity: null },
    env: { SHORE_NOW: "2026-10-30T12:00:00.000Z", SHORE_USER_LAST_MESSAGE_AT: "", SHORE_USER_QUIET_SECS: "", SHORE_USER_LAST_SEEN_AT: "", SHORE_USER_STATUS: "", SHORE_USER_STATUS_SET_AT: "" },
  };
  expect(checkFacts(T0, { lastUserAt: undefined, lastSeenAt: undefined, status: undefined }, undefined)).toEqual(nothing);
  expect(checkFacts(T0, { lastUserAt: undefined, lastSeenAt: undefined, status: { status: "", set_at: "2026-10-30T11:00:00.000Z" } }, undefined)).toEqual(nothing);
  expect(checkFacts(T0, { lastUserAt: T0, lastSeenAt: undefined, status: undefined }, undefined).env.SHORE_USER_QUIET_SECS).toBe("0");
});

function lastToolResult(messages: readonly Message[]): { text: unknown; failed: boolean } | undefined {
  const block = messages.flatMap((message) => message.content_blocks).findLast((each) => each.type === "tool_result");
  return block?.type === "tool_result" ? { text: block.content, failed: block.is_error === true } : undefined;
}

function withTools(...names: string[]): (app: AppConfig) => void {
  return (app) => {
    withTriggers(app);
    app.tools.enabled_tools = [...app.tools.enabled_tools, ...names];
  };
}

test("a note the character writes in its diary from a conversation reaches its heartbeats and its other threads, and isn't shown again where it was written", async () => {
  await withCharacter(async ({ runtime, script, data, say, heartbeat, thread }) => {
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    script.replyTool = { name: "write_diary", input: { text: "  Water the fern on Friday.  " } };
    at(5);
    await say("please remember the fern");
    expect(lastToolResult(await thread("main"))).toEqual({ text: "Noted in your diary. Your other turns will see it for the next day.", failed: false });
    expect(unfoldedDiary(join(data, "ada")).map((note) => [note.source, note.thread, note.at, note.text])).toEqual([
      ["note", "main", new Date(T0 + 5 * MINUTE).toISOString(), "Water the fern on Friday."],
    ]);

    at(6);
    await say("thank you");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).not.toContain("[New in your diary");
    at(7);
    await say("the beans are up", "garden");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(
      '[New in your diary. Each entry says where it came from.]\n\nyour note, written in "main" · Friday 2026-10-30 · 12:05 PM\nWater the fern on Friday.\n\n[End of your diary.]\nthe beans are up',
    );
    script.closing = "HEARTBEAT_OK";
    at(10);
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain('your note, written in "main" · Friday 2026-10-30 · 12:05 PM\nWater the fern on Friday.');

    script.replyTool = { name: "write_diary", input: { text: "   " } };
    at(11);
    await say("and the lamp");
    expect(lastToolResult(await thread("main"))).toMatchObject({ failed: true });
    expect(String(lastToolResult(await thread("main"))?.text)).toContain("text must be a non-empty string");
    expect(unfoldedDiary(join(data, "ada"))).toHaveLength(1);

    script.replyTool = { name: "write_diary", input: { text: "Lamp oil is low.", urgent: true } };
    at(12);
    await say("and the oil");
    expect(lastToolResult(await thread("main"))).toMatchObject({ failed: true });
    script.replyTool = { name: "write_diary", input: { text: "" } };
    at(13);
    await say("and the wick");
    expect(lastToolResult(await thread("main"))).toMatchObject({ failed: true });
    expect(String(lastToolResult(await thread("main"))?.text)).not.toContain("text must be a non-empty string");
    expect(unfoldedDiary(join(data, "ada"))).toHaveLength(1);

    script.replyTool = { name: "write_diary", input: { text: "!" } };
    at(14);
    await say("and the door");
    expect(lastToolResult(await thread("main"))).toMatchObject({ failed: false });
    expect(unfoldedDiary(join(data, "ada")).map((note) => note.text)).toEqual(["Water the fern on Friday.", "!"]);
  }, withTools("write_diary"));
});

test("the character can list its triggers from a conversation, and is told when the user hasn't turned them on", async () => {
  const file = '[lamp]\nevery = "1h"\nreason = "Trim the lamp."\n';
  await withCharacter(async ({ runtime, script, workspace, say, thread }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), file);
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    script.replyTool = { name: "list_triggers", input: {} };
    await say("what have you set up?");
    expect(lastToolResult(await thread("main"))).toEqual({
      text: 'Your triggers, from TRIGGERS.toml in your workspace root.\n\nlamp: every 1h, wakes you, "Trim the lamp.", at most every 1h\n  next Friday 2026-10-30 · 1:01 PM · never fired',
      failed: false,
    });

    script.replyTool = { name: "list_triggers", input: { only: "lamp" } };
    await say("just the lamp?");
    expect(lastToolResult(await thread("main"))).toMatchObject({ failed: true });
    expect(String(lastToolResult(await thread("main"))?.text)).not.toContain("Your triggers");
  }, withTools("list_triggers"));

  await withCharacter(async ({ script, workspace, say, thread }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), file);
    await say("hello");
    script.replyTool = { name: "list_triggers", input: {} };
    await say("what have you set up?");
    expect(lastToolResult(await thread("main"))).toEqual({
      text: "Your triggers, from TRIGGERS.toml in your workspace root. peggy hasn't turned triggers on, so none of them run.\n\nYou have none yet.",
      failed: false,
    });
  }, (app) => { app.tools.enabled_tools = [...app.tools.enabled_tools, "list_triggers"]; });
});

test("the character's push reaches the user's topic once, at normal priority, and a second one the same day is refused", async () => {
  const pushed: { path: string; method: string; title: string | null; auth: string | null; priority: string | null; body: string }[] = [];
  const ntfy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      pushed.push({
        path: new URL(request.url).pathname, method: request.method, title: request.headers.get("title"),
        auth: request.headers.get("authorization"), priority: request.headers.get("priority"), body: await request.text(),
      });
      return new Response("ok");
    },
  });
  try {
    await withCharacter(async ({ script, say, thread }) => {
      const result = async (): Promise<{ text: string; failed: boolean }> => {
        const last = lastToolResult(await thread("main"));
        return { text: String(last?.text), failed: last?.failed === true };
      };
      await say("hello");
      script.replyTool = { name: "send_push", input: { message: "  I miss you.  " } };
      at(5);
      await say("you can reach my phone now");
      expect(await result()).toEqual({ text: "Sent to peggy's phone. The next push is allowed from Saturday 2026-10-31 · 12:05 PM.", failed: false });
      expect(pushed).toEqual([{ path: "/phone", method: "POST", title: "Shore - ada", auth: "Bearer fixture-key", priority: null, body: "I miss you." }]);

      script.replyTool = { name: "send_push", input: { message: "Still here." } };
      at(65);
      await say("try again");
      expect(await result()).toMatchObject({ failed: true });
      expect((await result()).text).toContain("not sent: your last push was Friday 2026-10-30 · 12:05 PM, and the next one is allowed from Saturday 2026-10-31 · 12:05 PM");
      expect(pushed).toHaveLength(1);

      for (const input of [{ message: "   " }, { message: "" }, { message: "Hello.", loud: true }]) {
        script.replyTool = { name: "send_push", input };
        await say("and again");
        expect(await result(), JSON.stringify(input)).toMatchObject({ failed: true });
      }
      script.replyTool = { name: "send_push", input: { message: "   " } };
      await say("once more");
      expect((await result()).text).toContain("message must be a non-empty string");
      expect(pushed).toHaveLength(1);
    }, (app) => {
      app.tools.enabled_tools = [...app.tools.enabled_tools, "send_push"];
      app.notifications.push_topic = "phone";
      app.notifications.ntfy.url = `http://127.0.0.1:${String(ntfy.port)}`;
      app.notifications.token_env = KEY_ENV;
    });

    await withCharacter(async ({ script, say, thread }) => {
      await say("hello");
      script.replyTool = { name: "send_push", input: { message: "I miss you." } };
      await say("can you reach my phone?");
      const last = lastToolResult(await thread("main"));
      expect(last?.failed).toBe(true);
      expect(String(last?.text)).toContain("push notifications aren't set up: peggy hasn't given Shore a topic to send them to");
      expect(pushed).toHaveLength(1);
    }, (app) => { app.tools.enabled_tools = [...app.tools.enabled_tools, "send_push"]; });

    await withCharacter(async ({ script, say, thread }) => {
      await say("hello");
      script.replyTool = { name: "send_push", input: { message: "Hello.", loud: true } };
      await say("loudly");
      expect(lastToolResult(await thread("main"))?.failed).toBe(true);
      expect(pushed).toHaveLength(1);
      script.replyTool = { name: "send_push", input: { message: "!" } };
      await say("briefly");
      expect(lastToolResult(await thread("main"))?.failed).toBe(false);
      expect(pushed.map((each) => each.body)).toEqual(["I miss you.", "!"]);
    }, (app) => {
      app.tools.enabled_tools = [...app.tools.enabled_tools, "send_push"];
      app.notifications.push_topic = "phone";
      app.notifications.ntfy.url = `http://127.0.0.1:${String(ntfy.port)}`;
    });
  } finally {
    await ntfy.stop(true);
  }
});

test("the user's status reaches a conversation with their next message, once, and again when it changes or is cleared", async () => {
  let root = "";
  await withCharacter(async ({ script, data, say, thread }) => {
    root = dirname(data);
    const last = (): string => textOf(script.replies.at(-1) as SidecarRequest);
    await say("hello");
    expect(last()).not.toContain("status");
    setPresence(data, "asleep", T0 + 5 * MINUTE);
    at(15);
    await say("you up?");
    expect(last()).toEndWith('[Their status, set 10 minutes ago: "asleep"]\nyou up?');
    at(16);
    await say("hello?");
    expect(times(last(), "Their status")).toBe(1);

    setPresence(data, "at work", T0 + 20 * MINUTE);
    at(25);
    await say("back at it");
    expect(last()).toEndWith('[Their status, set 5 minutes ago: "at work"]\nback at it');
    setPresence(data, "", T0 + 30 * MINUTE);
    at(32);
    await say("done for the day");
    expect(last()).toEndWith("[Their status was cleared 2 minutes ago.]\ndone for the day");
    expect((await thread("main")).flatMap((message) => message.presence === undefined ? [] : [[message.content, message.presence.status]])).toEqual([
      ["you up?", "asleep"], ["back at it", "at work"], ["done for the day", ""],
    ]);
  });

  await withCharacter(async ({ script, say }) => {
    at(40);
    await say("anything new?");
    const resumed = textOf(script.replies[0] as SidecarRequest);
    expect(resumed).toContain('[Their status, set 10 minutes ago: "asleep"]\nyou up?');
    expect(times(resumed, "Their status")).toBe(3);
  }, undefined, root);
});

test("a heartbeat starts with the user's status and its age while one is set, and a status that changes sets off the trigger for it", async () => {
  await withCharacter(async ({ runtime, script, workspace, data, say, heartbeat }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `[status]\nwhen = "status_changed"\ncheck = 'echo "now: $SHORE_USER_STATUS"'\nwake = false\n`);
    await say("hello");
    script.closing = "HEARTBEAT_OK";
    at(1);
    await runtime.triggers.tick();
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).not.toContain("status");

    setPresence(data, "asleep", T0 + 5 * MINUTE);
    await runtime.triggers.statusChanged();
    script.heartbeats.length = 0;
    at(65);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["status", "now: asleep"]]);
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain(`in your home thread "main".]\n\n[User's status, set about an hour ago: "asleep"]\n\n[Your diary from the last day.`);

    setPresence(data, "", T0 + 70 * MINUTE);
    script.heartbeats.length = 0;
    at(130);
    await heartbeat();
    expect(textOf(script.heartbeats[0] as SidecarRequest)).not.toContain("User's status");
  }, withTriggers);
});

test("the user was last seen when they last wrote, or when a client of theirs last marked a thread read, and not when a reply is only asked for again", async () => {
  await withCharacter(async ({ data, say }) => {
    expect(lastSeen(data)).toBeUndefined();
    at(3);
    await say("hello");
    expect(lastSeen(data)).toBe(T0 + 3 * MINUTE);
    at(8);
    await say("");
    expect(lastSeen(data)).toBe(T0 + 3 * MINUTE);

    const reads = new ThreadUnreadTracker({ dataDir: data, broadcast: () => {}, now: () => T0 + 20 * MINUTE });
    reads.markRead("ada", "main", T0 + 15 * MINUTE);
    expect(lastSeen(data)).toBe(T0 + 20 * MINUTE);
  });
});

test("the presence command sets one of the user's own statuses, shows and clears it, refuses any other, and sets off the trigger for a change", async () => {
  const choices = ["asleep", "at work"];
  await withCharacter(async ({ runtime, workspace, data, say, command }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `[status]\nwhen = "status_changed"\ncheck = 'echo "now: $SHORE_USER_STATUS"'\nwake = false\n`);
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    expect((await command("presence", {}) as { data?: unknown }).data).toEqual({ choices });
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([]);

    at(5);
    const set = await command("presence", { status: "  at work " });
    expect(set).toMatchObject({ type: "command_output", name: "presence" });
    expect((set as { data?: unknown }).data).toEqual({ status: "at work", set_at: new Date(T0 + 5 * MINUTE).toISOString(), choices });
    expect(presence(data)).toEqual({ status: "at work", set_at: new Date(T0 + 5 * MINUTE).toISOString() });
    at(6);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["status", "now: at work"]]);
    expect((await command("presence", {}) as { data?: unknown }).data).toEqual({ status: "at work", set_at: new Date(T0 + 5 * MINUTE).toISOString(), choices });
    expect((await command("presence", { status: null }) as { data?: unknown }).data).toEqual({ status: "at work", set_at: new Date(T0 + 5 * MINUTE).toISOString(), choices });

    at(7);
    const refused = await command("presence", { status: "on the moon" });
    expect(refused.type).toBe("error");
    expect(JSON.stringify(refused)).toContain(`\\"on the moon\\" isn't one of your statuses: yours are asleep, at work. Add it to presence.statuses to use it.`);
    expect(presence(data)?.status).toBe("at work");
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["status", "now: at work"]]);

    at(8);
    const cleared = await command("presence", { status: " " });
    expect((cleared as { data?: unknown }).data).toEqual({ choices });
    expect(presence(data)).toEqual({ status: "", set_at: new Date(T0 + 8 * MINUTE).toISOString() });
  }, (app) => {
    withTriggers(app);
    app.behavior.presence.statuses = choices;
  });

  await withCharacter(async ({ say, command }) => {
    await say("hello");
    const refused = await command("presence", { status: "asleep" });
    expect(refused.type).toBe("error");
    expect(JSON.stringify(refused)).toContain("isn't one of your statuses: presence.statuses in your config is empty. Add it to presence.statuses to use it.");
    expect((await command("presence", { status: "" }) as { data?: unknown }).data).toEqual({ choices: [] });
  }, (app) => { app.behavior.presence.statuses = []; });
});

test("the diary command lists the newest twenty notes oldest first, as many as asked for, or all of them for zero, with which ones the character still sees and which a dream has read", async () => {
  await withCharacter(async ({ data, command }) => {
    const dir = join(data, "ada");
    const listed = async (args: Record<string, unknown>): Promise<{ character: string; kept: number; notes: Record<string, unknown>[] }> =>
      (await command("diary", args) as unknown as { data: { character: string; kept: number; notes: Record<string, unknown>[] } }).data;
    expect(await listed({})).toEqual({ character: "ada", notes: [], kept: 0 });

    let made = 0;
    const newId = (): string => `d${String(++made)}`;
    addDiaryNote(dir, { at: T0 - 25 * 60 * MINUTE, thread: "main", source: "note", text: "Promised the ferry times." }, newId);
    for (let n = 1; n <= 21; n += 1) addDiaryNote(dir, { at: T0 + n * MINUTE, thread: "heartbeat", source: "heartbeat", text: `note ${String(n)}` }, newId);
    addDiaryNote(dir, { at: T0 + 22 * MINUTE, thread: "heartbeat", source: "trigger", trigger: "mail", text: "Two letters." }, newId);
    foldDiary(dir, ["d1", "d22"]);
    at(30);

    const newest = await listed({});
    expect(newest.kept).toBe(23);
    expect(newest.notes.map((note) => note["text"])).toEqual([...Array.from({ length: 19 }, (_unused, n) => `note ${String(n + 3)}`), "Two letters."]);
    expect(newest.notes.at(-1)).toEqual({ at: new Date(T0 + 22 * MINUTE).toISOString(), thread: "heartbeat", source: "trigger", trigger: "mail", text: "Two letters.", shown: true, dreamed: false });
    expect(newest.notes.at(-2)).toEqual({ at: new Date(T0 + 21 * MINUTE).toISOString(), thread: "heartbeat", source: "heartbeat", text: "note 21", shown: true, dreamed: true });

    expect((await listed({ count: 2 })).notes.map((note) => note["text"])).toEqual(["note 21", "Two letters."]);
    const all = await listed({ count: 0 });
    expect(all.kept).toBe(23);
    expect(all.notes).toHaveLength(23);
    expect(all.notes[0]).toEqual({ at: new Date(T0 - 25 * 60 * MINUTE).toISOString(), thread: "main", source: "note", text: "Promised the ferry times.", shown: false, dreamed: true });
    expect(all.notes.filter((note) => note["shown"] === false).map((note) => note["text"])).toEqual(["Promised the ferry times.", "note 1", "note 2"]);

    expect((await command("diary", { count: -1 })).type).toBe("error");
    expect((await command("diary", { newest: 2 })).type).toBe("error");
  });
});

const SHOW = '[show]\nevery = "10m"\nreason = "Tell the next part."\nthread = "ring"\n';

const FIRED = '[Your trigger "show" fired at Friday 2026-10-30 · 12:11 PM: Tell the next part.]';

function wakeText(now: string, lines: readonly string[], limit = "30 minutes", nudgeAfter = "25 minutes"): string {
  return [
    "[wake]",
    ...lines,
    `[Current time: Friday 2026-10-30 · ${now}]`,
    '[This is a wake in your thread "ring": time of your own here, without User having written. Everything above is this thread as you left it. You are free to use your tools as you wish.',
    "What you write in your final response is your note to yourself. It goes in your diary, where your other turns see it for the next day, and it stays here in this thread. To say something to User, wrap it in `<sendMessage>...</sendMessage>` tags in your final response. That text is posted in this thread as a message to them. The rest of what you do in a wake stays in this thread as your working: they can read it if they look, but nothing tells them it is there.",
    `A wake here can run for up to ${limit}. After ${nudgeAfter}, you will get a nudge to wrap up, with a few more rounds to finish. If User writes in this thread while you are working, the wake stops at the end of the step it is on so that you can answer them, and you are woken here again to pick it up once they have been quiet here for 10 minutes.]`,
  ].join("\n\n");
}

function turnsOf(request: SidecarRequest | undefined): [role: string, text: string][] {
  return (request?.messages ?? []).map((message) => [message.role, message.content.map((block) => block.type === "text" ? block.text : `<${block.type}>`).join("|")]);
}

async function fires(runtime: ShoreRuntime, minutes: number): Promise<void> {
  at(minutes);
  await runtime.triggers.tick();
  await runtime.autonomy.tick();
}

const SOUL_READ = "SOUL.md: lines 1–1\n1\tAda\nEnd of file.";

function stored(messages: readonly Message[]): [role: string, origin: string, content: string][] {
  return messages.map((message) => [message.role, message.origin ?? "", message.content.endsWith(SOUL_READ) ? "<SOUL.md>" : message.content]);
}

test("a trigger that names a thread wakes the character there, with that thread's history, and what it sends lands there unread", async () => {
  await withCharacter(async ({ runtime, script, workspace, data, emitted, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await runtime.registry.setThreadModel("ada", "ring", "pinned");
    await writeFile(join(workspace, "TRIGGERS.toml"), SHOW);
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    await runtime.triggers.tick();
    markThreadRead(data, "ada", "ring", 2);
    script.closing = "Told part one; the fox is at the gate.\n<sendMessage>Part one: the fox came to the gate.</sendMessage>";
    emitted.length = 0;
    await fires(runtime, 11);

    const opener = wakeText("12:11 PM", [FIRED]);
    expect(script.heartbeats.map((request) => [request.model, request.context?.call_type, request.context?.thread])).toEqual([
      ["claude-pinned", "heartbeat", "ring"],
      ["claude-pinned", "heartbeat_tool_loop", "ring"],
    ]);
    expect(turnsOf(script.heartbeats[0])).toEqual([
      ["user", "tell me a story in parts"],
      ["assistant", "reply to: tell me a story in parts"],
      ["user", opener],
    ]);
    expect(stored(await thread("ring"))).toEqual([
      ["user", "", "tell me a story in parts"],
      ["assistant", "", "reply to: tell me a story in parts"],
      ["user", "autonomous", opener],
      ["assistant", "", ""],
      ["user", "", "<SOUL.md>"],
      ["assistant", "", "Told part one; the fox is at the gate.\n[sent to User as the next message here]"],
      ["assistant", "autonomous", "Part one: the fox came to the gate."],
    ]);
    expect(emitted.map((each) => [each.thread, each.msg.content])).toEqual([["ring", "Part one: the fox came to the gate."]]);
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "ring"]);
    expect(threadActivityNow(data, "ada", "ring")).toEqual({
      turns: 2, last_active: new Date(T0 + 11 * MINUTE).toISOString(), last_user: new Date(T0 + MINUTE).toISOString(), unread: 1,
    });
    expect(unfoldedDiary(join(data, "ada")).map((note) => [note.source, note.thread, note.text])).toEqual([["wake", "ring", "Told part one; the fox is at the gate."]]);

    at(12);
    await say("and then?", "ring");
    expect(turnsOf(script.replies.at(-1)).slice(2)).toEqual([
      ["user", opener],
      ["assistant", "<tool_use>"],
      ["user", "<tool_result>"],
      ["assistant", "<thinking>|Told part one; the fox is at the gate.\n[sent to User as the next message here]"],
      ["user", "[heartbeat · Friday 2026-10-30 · 12:11 PM]"],
      ["assistant", "Part one: the fox came to the gate."],
      ["user", "and then?"],
    ]);
    at(13);
    await say("anything new?");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(
      '[New in your diary. Each entry says where it came from.]\n\nyour note at the end of a wake in "ring" · Friday 2026-10-30 · 12:11 PM\nTold part one; the fox is at the gate.\n\n[End of your diary.]\nanything new?',
    );
  }, withTriggers);
});

test("a trigger that names a thread the character doesn't have, or the one its heartbeats run in, wakes nothing and says so in the diary", async () => {
  await withCharacter(async ({ runtime, script, workspace, data, say, heartbeat }) => {
    await say("hello");
    script.closing = "HEARTBEAT_OK";
    at(1);
    await heartbeat();
    script.heartbeats.length = 0;
    await writeFile(join(workspace, "TRIGGERS.toml"), '[lost]\nevery = "10m"\nreason = "r"\nthread = "nowhere"\n\n[beat]\nevery = "10m"\nreason = "r"\nthread = "heartbeat"\n');
    await runtime.triggers.tick();
    await fires(runtime, 12);
    expect(script.heartbeats).toEqual([]);
    expect(diaryOf(data)).toEqual([
      ["shore", 'You were to be woken in the thread "nowhere" by trigger "lost", but you have no such thread, so nothing ran. `list_threads` shows the threads you do have.'],
      ["shore", 'You were to be woken in the thread "heartbeat" by trigger "beat", but you have no such thread, so nothing ran. `list_threads` shows the threads you do have.'],
    ]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-4)).toEqual([
      ["tick_fired", 'Woken in "nowhere" by trigger "lost"'],
      ["call_failed", 'Wake skipped: no thread "nowhere"'],
      ["tick_fired", 'Woken in "heartbeat" by trigger "beat"'],
      ["call_failed", 'Wake skipped: no thread "heartbeat"'],
    ]);
  }, withTriggers);
});

const AFTER = '\n[after]\nfollows = "show"\nreason = "Write it up."\nwake = false\n';

test("the user's message stops a wake in that thread at the end of its step and is answered, and the wake picks up once they have been quiet there for ten minutes", async () => {
  await withCharacter(async ({ runtime, script, workspace, data, emitted, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await writeFile(join(workspace, "TRIGGERS.toml"), SHOW + AFTER);
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    await runtime.triggers.tick();
    script.again = 3;
    script.aside = "Let me look.";
    const held = hold();
    script.beatHeld = held;
    emitted.length = 0;
    const waking = fires(runtime, 11);
    await held.started.promise;
    const running = runtime.autonomy.runningHeartbeat("ada");
    expect([running?.thread, running?.reason, running?.startedAt]).toEqual(["ring", undefined, T0 + 11 * MINUTE]);
    at(12);
    const asking = say("wait, what is the fox called?", "ring");
    held.release.resolve();
    await waking;
    await asking;

    const opener = wakeText("12:11 PM", [FIRED]);
    const stopped = "[User wrote here while this wake was running, so Shore stopped it here for you to answer them. Once they have been quiet in this thread for 10 minutes, Shore wakes you here again to pick it up.]";
    expect(script.heartbeats).toHaveLength(1);
    expect(stored(await thread("ring")).slice(2)).toEqual([
      ["user", "autonomous", opener],
      ["assistant", "", "Let me look."],
      ["user", "", "<SOUL.md>"],
      ["system", "autonomous", stopped],
      ["user", "", "wait, what is the fox called?"],
      ["assistant", "", "reply to: wait, what is the fox called?"],
    ]);
    expect(turnsOf(script.replies.at(-1)).slice(2)).toEqual([
      ["user", opener],
      ["assistant", "Let me look.|<tool_use>"],
      ["user", "<tool_result>"],
      ["system", stopped],
      ["user", "wait, what is the fox called?"],
    ]);
    expect(emitted.filter((each) => each.msg.origin === "autonomous")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind !== "tool_use").map((event) => [event.kind, event.detail]).slice(-3)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["wake", 'Wake in "ring" stopped for User\'s message'],
      ["message_skipped", "Tick completed — no message sent"],
    ]);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([]);

    script.again = 0;
    script.aside = undefined;
    at(13);
    await say("is the lamp lit?");
    at(21);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(1);
    script.closing = "Told part one.\n<sendMessage>Part one: Rue came to the gate.</sendMessage>";
    at(22);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(3);
    expect(turnsOf(script.heartbeats[1]).at(-1)).toEqual(["user", wakeText("12:22 PM", ["[This picks up the wake that User interrupted at Friday 2026-10-30 · 12:12 PM.]", FIRED])]);
    expect((await thread("ring")).at(-1)?.content).toBe("Part one: Rue came to the gate.");
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["wake", "Told part one."], ["after", "Write it up."]]);
    at(40);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(3);
  }, withTriggers);
});

test("a wake waits for the user to have been quiet in its thread for ten minutes, however lately they wrote elsewhere", async () => {
  await withCharacter(async ({ runtime, script, say }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(5);
    await say("one more thing", "ring");
    script.closing = "HEARTBEAT_OK";
    expect(runtime.autonomy.wakeFor("ada", { name: "show", reason: "Tell the next part.", at: T0 + 6 * MINUTE, thread: "ring" })).toBe("queued");
    at(14);
    await say("is the lamp lit?");
    await runtime.autonomy.tick();
    at(14.999);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(0);
    at(15);
    await runtime.autonomy.tick();
    expect(script.heartbeats.map((request) => request.context?.thread)).toEqual(["ring", "ring"]);
    expect(turnsOf(script.heartbeats[0]).at(-1)?.[1]).toBe(wakeText("12:15 PM", ['[Your trigger "show" fired at Friday 2026-10-30 · 12:06 PM: Tell the next part.]']));
  }, withTriggers);
});

function handOff(...names: string[]): (app: AppConfig) => void {
  return (app) => {
    app.tools.enabled_tools = [...app.tools.enabled_tools, "wake_in_thread", ...names];
    app.behavior.autonomy.triggers.max_wake_limit = ConfigDuration.fromSecs(2 * 3600);
  };
}

test("from a heartbeat the character hands off into a thread, and is woken there next with its reason and the limit it asked for, held to the user's ceiling", async () => {
  await withCharacter(async ({ runtime, script, say, heartbeat, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.beatTool = { name: "wake_in_thread", input: { thread: " ring ", reason: " Tell part two. ", limit: "6h" } };
    script.closing = "HEARTBEAT_OK";
    at(10);
    await heartbeat();
    expect(lastToolResult(await thread("heartbeat"))).toEqual({
      text: 'Shore will wake you in "ring" for up to 2 hours, once this turn is over and peggy has been quiet there for 10 minutes.', failed: false,
    });
    expect(script.heartbeats.map((request) => request.context?.thread)).toEqual(["heartbeat", "heartbeat"]);

    script.closing = "Told part two.\n<sendMessage>Part two: the gate opened.</sendMessage>";
    at(11);
    await runtime.autonomy.tick();
    expect(script.heartbeats.map((request) => request.context?.thread)).toEqual(["heartbeat", "heartbeat", "ring", "ring"]);
    expect(turnsOf(script.heartbeats[2])).toEqual([
      ["user", wakeText("12:11 PM", ['[You asked for this wake from "heartbeat" at Friday 2026-10-30 · 12:10 PM: Tell part two.]'], "2 hours", "105 minutes")],
    ]);
    expect((await thread("ring")).at(-1)?.content).toBe("Part two: the gate opened.");
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").at(-1)?.detail).toBe('Woken in "ring" by a hand-off from "heartbeat"');

    script.beatTool = { name: "wake_in_thread", input: { thread: "ring", reason: "Tell part three." } };
    script.closing = "HEARTBEAT_OK";
    at(30);
    await heartbeat();
    expect(lastToolResult(await thread("heartbeat"))?.text).toBe('Shore will wake you in "ring" for up to 30 minutes, once this turn is over and peggy has been quiet there for 10 minutes.');
    script.beatTool = { name: "wake_in_thread", input: { thread: "main", reason: "And tell them." } };
    at(31);
    await runtime.autonomy.tick();
    expect(turnsOf(script.heartbeats.at(-2)).at(-1)?.[1]).toContain("A wake here can run for up to 30 minutes. After 25 minutes,");
    expect(lastToolResult(await thread("ring"))).toEqual({ text: "io: a wake can't be handed on from here", failed: true });
    expect(script.heartbeats).toHaveLength(8);
    at(32);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(8);
  }, handOff());
});

test("a hand-off is refused for a thread the character doesn't have, the one it is in, or without a reason, and nothing is queued", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    const refused = async (input: Record<string, unknown>): Promise<unknown> => {
      script.replyTool = { name: "wake_in_thread", input };
      await say("go on");
      const result = lastToolResult(await thread("main"));
      expect(result?.failed).toBe(true);
      return result?.text;
    };
    expect(await refused({ thread: "nowhere", reason: "r" })).toBe('io: you have no thread "nowhere" to be woken in; `list_threads` shows the ones you have');
    expect(await refused({ thread: "main", reason: "r" })).toBe('io: you are in "main" now, so there is nothing to hand over');
    expect(await refused({ thread: "the ring", reason: "r" })).toContain("thread must be a thread's id, as `list_threads` shows it");
    expect(await refused({ thread: "  ", reason: "r" })).toContain("thread must be a thread's id, as `list_threads` shows it");
    expect(await refused({ thread: "ring", reason: "  " })).toContain("reason must be a non-empty string");
    expect(await refused({ thread: "ring", reason: "r", limit: "soon" })).toContain('limit must be a length of time, like "45m" or "2h"');
    expect(await refused({ thread: "ring", reason: "r", limit: "59s" })).toContain("limit can't be shorter than a minute");
    expect(await refused({ thread: "r", reason: "r" })).toBe('io: you have no thread "r" to be woken in; `list_threads` shows the ones you have');
    expect(await refused({ thread: "t".repeat(64), reason: "r" })).toBe(`io: you have no thread "${"t".repeat(64)}" to be woken in; \`list_threads\` shows the ones you have`);
    expect(await refused({ thread: "t".repeat(65), reason: "r" })).toStartWith("The call to wake_in_thread was not run because argument `thread` must NOT have more than 64 characters.");
    expect(await refused({ thread: "ring", reason: "r", urgent: true })).toStartWith("The call to wake_in_thread was not run because argument `urgent` is not allowed.");
    script.closing = "HEARTBEAT_OK";
    script.replyTool = { name: "wake_in_thread", input: { thread: "heartbeat", reason: "r" } };
    at(1);
    expect(runtime.autonomy.forceHeartbeatNow("ada")).toBeDefined();
    await runtime.autonomy.tick();
    expect(await refused({ thread: "heartbeat", reason: "r" })).toBe('io: you have no thread "heartbeat" to be woken in; `list_threads` shows the ones you have');
    script.heartbeats.length = 0;
    at(20);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toEqual([]);

    script.replyTool = { name: "wake_in_thread", input: { thread: "ring", reason: "Tell the next part.", limit: "1m" } };
    await say("off you go");
    expect(lastToolResult(await thread("main"))).toEqual({
      text: 'Shore will wake you in "ring" for up to 1 minute, once this turn is over and peggy has been quiet there for 10 minutes.', failed: false,
    });
    await runtime.autonomy.tick();
    expect(turnsOf(script.heartbeats[0])).toEqual([
      ["user", wakeText("12:20 PM", ['[You asked for this wake from "main" at Friday 2026-10-30 · 12:20 PM: Tell the next part.]'], "1 minute", "50 seconds")],
    ]);
  }, handOff());
});

test("a second wake asked for in a thread is refused while the first is still waiting and says what is waiting, and with overwrite it takes the first one's place", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    const ask = async (input: Record<string, unknown>): Promise<{ text: unknown; failed: boolean } | undefined> => {
      script.replyTool = { name: "wake_in_thread", input };
      await say("go on");
      return lastToolResult(await thread("main"));
    };
    const granted = (where: string, length = "30 minutes"): string => `Shore will wake you in "${where}" for up to ${length}, once this turn is over and peggy has been quiet there for 10 minutes.`;
    const waiting = 'asked for from "main" at Friday 2026-10-30 · 12:20 PM: Tell part two.';
    at(19);
    expect(runtime.autonomy.wakeFor("ada", { name: "show", reason: "show is due", at: T0 + 19 * MINUTE, thread: "ring" })).toBe("queued");
    at(20);
    expect(await ask({ thread: "ring", reason: "Tell part two." })).toEqual({ text: granted("ring"), failed: false });
    expect(await ask({ thread: "garden", reason: "Water the beans.", overwrite: true })).toEqual({ text: granted("garden"), failed: false });

    at(21);
    expect(await ask({ thread: "ring", reason: "Tell part three." })).toEqual({
      text: `io: you already have a wake waiting in "ring", ${waiting}\nNothing was changed. To put this one in its place, call again with \`overwrite\` set to true.`, failed: true,
    });
    expect(await ask({ thread: "ring", reason: "Tell part three.", overwrite: "yes" })).toMatchObject({ failed: true });
    at(22);
    expect(await ask({ thread: "ring", reason: "Tell part three.", limit: "1h", overwrite: true })).toEqual({
      text: `${granted("ring", "1 hour")}\nThis takes the place of the wake you had waiting there, ${waiting}`, failed: false,
    });

    script.closing = "HEARTBEAT_OK";
    at(40);
    await runtime.autonomy.tick();
    expect(script.heartbeats.map((request) => request.context?.thread)).toEqual(["ring", "ring", "garden", "garden"]);
    const ring = turnsOf(script.heartbeats[0]).at(-1)?.[1] ?? "";
    expect(ring).toStartWith([
      "[wake]",
      '[Your trigger "show" fired at Friday 2026-10-30 · 12:19 PM: show is due]',
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:22 PM: Tell part three.]',
      "[Current time: ",
    ].join("\n\n"));
    expect(ring).not.toContain("Tell part two.");
    expect(turnsOf(script.heartbeats[2]).at(-1)?.[1]).toStartWith('[wake]\n\n[You asked for this wake from "main" at Friday 2026-10-30 · 12:20 PM: Water the beans.]\n\n[Current time: ');

    at(41);
    expect(await ask({ thread: "ring", reason: "And once more." })).toEqual({ text: granted("ring"), failed: false });
  }, handOff());
});

test("a wake the character asked for and the user interrupted is not a request still waiting: a new request for its thread is taken, overwriting leaves the interrupted wake be, and it picks up with both", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    const ask = async (input: Record<string, unknown>): Promise<{ text: unknown; failed: boolean } | undefined> => {
      script.replyTool = { name: "wake_in_thread", input };
      await say("go on");
      return lastToolResult(await thread("main"));
    };
    const granted = 'Shore will wake you in "ring" for up to 30 minutes, once this turn is over and peggy has been quiet there for 10 minutes.';
    at(1);
    expect(await ask({ thread: "ring", reason: "Tell part two." })).toEqual({ text: granted, failed: false });

    script.again = 3;
    const held = hold();
    script.beatHeld = held;
    at(11);
    const waking = runtime.autonomy.tick();
    await held.started.promise;
    at(12);
    const asking = say("wait, what is the fox called?", "ring");
    held.release.resolve();
    await waking;
    await asking;
    script.again = 0;
    expect((await thread("ring")).some((message) => message.content.includes("Shore stopped it here for you to answer them"))).toBe(true);

    at(13);
    expect(await ask({ thread: "ring", reason: "And the fox's name." })).toEqual({ text: granted, failed: false });
    at(14);
    const later = 'asked for from "main" at Friday 2026-10-30 · 12:13 PM: And the fox\'s name.';
    expect(await ask({ thread: "ring", reason: "Tell part three." })).toEqual({
      text: `io: you already have a wake waiting in "ring", ${later}\nNothing was changed. To put this one in its place, call again with \`overwrite\` set to true.`, failed: true,
    });
    expect(await ask({ thread: "ring", reason: "Tell part three.", overwrite: true })).toEqual({
      text: `${granted}\nThis takes the place of the wake you had waiting there, ${later}`, failed: false,
    });

    script.heartbeats.length = 0;
    script.closing = "HEARTBEAT_OK";
    at(30);
    await runtime.autonomy.tick();
    expect(script.heartbeats.map((request) => request.context?.thread)).toEqual(["ring", "ring"]);
    expect(turnsOf(script.heartbeats[0]).at(-1)?.[1]).toStartWith([
      "[wake]",
      "[This picks up the wake that User interrupted at Friday 2026-10-30 · 12:12 PM.]",
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:01 PM: Tell part two.]',
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:14 PM: Tell part three.]',
      "[Current time: ",
    ].join("\n\n"));
  }, handOff());
});

test("a hand-off is refused when the character's heartbeats aren't running", async () => {
  await withCharacter(async ({ script, say, thread, runtime }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.replyTool = { name: "wake_in_thread", input: { thread: "ring", reason: "r" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: "io: heartbeats are not running for this character", failed: true });
  }, (app) => {
    handOff()(app);
    app.behavior.autonomy.enabled = false;
  });
});

test("a wake's turn can't be regenerated, and a wake in the home thread isn't taken for the user writing there", async () => {
  await withCharacter(async ({ runtime, script, say, regenerate, thread }) => {
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    at(2);
    await say("the beans are up", "garden");
    script.closing = "Looked in.\n<sendMessage>The lamp is lit.</sendMessage>";
    runtime.autonomy.wakeFor("ada", { name: "lamp", reason: "Look in.", at: T0 + 60 * MINUTE, thread: "main" });
    at(60);
    await runtime.autonomy.tick();
    const home = await thread("main");
    expect(home.at(-1)?.content).toBe("The lamp is lit.");
    const refusal = await rejectionOf(regenerate("main"));
    expect([(refusal as Error).name, (refusal as Error).message, (refusal as { code?: string }).code]).toEqual([
      "WakeTurnError", "The last turn here is a wake of ada's own, not a reply to you, so there is nothing to regenerate. Write to ada instead.", "invalid_request",
    ]);
    expect(await thread("main")).toEqual(home);

    at(200);
    await say("and the peas", "garden");
    expect((await thread("garden")).at(-2)?.last_elsewhere).toEqual({ thread: "main", at: new Date(T0).toISOString() });
    await regenerate("garden");
    expect((await thread("garden")).at(-1)?.content).toBe("reply to: and the peas");
  });
});

test("a wake in a thread takes in what fires for that thread while it runs, leaves the rest to their own turns, and carries all of it when the user interrupts", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    const zone = hostZone();
    const fired = (name: string, minutes: number, where?: string) => ({ name, reason: `${name} is due`, at: T0 + minutes * MINUTE, ...(where === undefined ? {} : { thread: where }) });
    const where = (): (string | undefined)[] => script.heartbeats.map((request) => request.context?.thread);
    await runtime.registry.createThread("ada", "ring");
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    script.closing = "HEARTBEAT_OK";

    let held = hold();
    script.beatHeld = held;
    script.again = 1;
    at(10);
    expect(runtime.autonomy.wakeFor("ada", fired("show", 9, "ring"))).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", fired("show", 10, "ring"))).toBe("queued");
    let waking = runtime.autonomy.tick();
    await held.started.promise;
    expect(turnsOf(script.heartbeats[0])).toEqual([["user", wakeText("12:10 PM", [triggerFiredNote(fired("show", 10), zone)])]]);
    at(11);
    expect(runtime.autonomy.wakeFor("ada", fired("encore", 11, "ring"))).toBe("handed");
    expect(runtime.autonomy.wakeFor("ada", fired("lamp", 11))).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", fired("beans", 11, "garden"))).toBe("queued");
    await say("is the lamp lit?");
    held.release.resolve();
    await waking;
    expect(where()).toEqual(["ring", "ring", "ring"]);
    expect(textOf(script.heartbeats[1] as SidecarRequest)).toEndWith(
      `${triggerFiredNote(fired("encore", 11), zone)}\n\n[User has just written to you, at Friday 2026-10-30 · 12:11 PM, while this wake is running. Another turn of you is answering them, and it knows this wake is running.]`,
    );
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(
      `[A wake of yours in "ring" has been running since Friday 2026-10-30 · 12:10 PM. It can't see this conversation. It is only told that a message arrived.]\nis the lamp lit?`,
    );
    expect((await thread("ring")).some((message) => message.content.includes("Shore stopped it"))).toBe(false);

    at(12);
    await runtime.autonomy.tick();
    expect(where().slice(3)).toEqual(["heartbeat", "heartbeat", "garden", "garden"]);
    expect(textOf(script.heartbeats[3] as SidecarRequest)).toContain(triggerFiredNote(fired("lamp", 11), zone));
    expect(textOf(script.heartbeats[3] as SidecarRequest)).not.toContain("beans");
    expect(turnsOf(script.heartbeats[5]).at(-1)?.[1]).toStartWith(`[wake]\n\n${triggerFiredNote(fired("beans", 11), zone)}\n\n[Current time: `);

    script.heartbeats.length = 0;
    held = hold();
    script.beatHeld = held;
    script.again = 2;
    at(40);
    expect(runtime.autonomy.wakeFor("ada", fired("show", 40, "ring"))).toBe("queued");
    waking = runtime.autonomy.tick();
    await held.started.promise;
    at(41);
    expect(runtime.autonomy.wakeFor("ada", fired("encore", 41, "ring"))).toBe("handed");
    expect(runtime.autonomy.wakeFor("ada", { ...fired("", 41, "ring"), from: "main" })).toBe("queued");
    const asking = say("wait", "ring");
    held.release.resolve();
    await waking;
    await asking;
    expect(where()).toEqual(["ring"]);
    script.again = 0;

    at(45);
    expect(runtime.autonomy.wakeFor("ada", fired("show", 45, "ring"))).toBe("queued");
    at(50.999);
    await runtime.autonomy.tick();
    expect(where()).toEqual(["ring"]);
    at(51);
    await runtime.autonomy.tick();
    expect(where()).toEqual(["ring", "ring", "ring"]);
    expect(turnsOf(script.heartbeats[1]).at(-1)).toEqual(["user", wakeText("12:51 PM", [
      "[This picks up the wake that User interrupted at Friday 2026-10-30 · 12:41 PM.]",
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:41 PM:  is due]',
      triggerFiredNote(fired("encore", 41), zone),
      triggerFiredNote(fired("show", 45), zone),
    ])]);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").at(-1)?.detail).toBe('Woken in "ring" by trigger "encore", "show" and a hand-off from "main"');
  });
});

test("what is waiting for a thread where a wake is running starts together once that wake is over, as one wake that opens with each reason and runs to the longest limit, a repeat counted once", async () => {
  await withCharacter(async ({ runtime, script, say }) => {
    const asked = (reason: string, minutes: number, limitMs: number) => ({ name: "", from: "main", reason, at: T0 + minutes * MINUTE, thread: "ring", limitMs });
    const show = (reason: string, minutes: number) => ({ name: "show", reason, at: T0 + minutes * MINUTE, thread: "ring" });
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.closing = "HEARTBEAT_OK";
    const held = hold();
    script.beatHeld = held;
    at(9);
    expect(runtime.autonomy.wakeFor("ada", show("the early show", 9))).toBe("queued");
    at(10);
    expect(runtime.autonomy.wakeFor("ada", show("the late show", 10))).toBe("queued");
    const waking = runtime.autonomy.tick();
    await held.started.promise;
    expect(textOf(script.heartbeats[0] as SidecarRequest)).toContain('[Your trigger "show" fired at Friday 2026-10-30 · 12:10 PM: the late show]');
    expect(textOf(script.heartbeats[0] as SidecarRequest)).not.toContain("the early show");
    at(11);
    expect(runtime.autonomy.wakeFor("ada", asked("carry on with the first plan", 11, 45 * MINUTE))).toBe("queued");
    at(12);
    expect(runtime.autonomy.wakeFor("ada", asked("carry on with the second plan", 12, 90 * MINUTE))).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", asked("carry on with the second plan", 12, 90 * MINUTE))).toBe("queued");
    held.release.resolve();
    await waking;
    expect(script.heartbeats).toHaveLength(2);
    expect(script.heartbeats.map(textOf).join("\n")).not.toContain("You asked for this wake");

    at(13);
    await runtime.autonomy.tick();
    expect(script.heartbeats.map((request) => request.context?.thread)).toEqual(["ring", "ring", "ring", "ring"]);
    const opener = turnsOf(script.heartbeats[2]).at(-1)?.[1] ?? "";
    expect(opener).toStartWith([
      "[wake]",
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:11 PM: carry on with the first plan]',
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:12 PM: carry on with the second plan]',
      "[Current time: ",
    ].join("\n\n"));
    expect(opener).toContain("A wake here can run for up to 90 minutes.");
  });
});

test("a side thread grown long by a wake compacts once the wake is over, as it would after a reply, unless the user cut the wake short", async () => {
  const long = (app: AppConfig): void => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.min_turns = 1;
    app.memory.compaction.max_turns = 2;
  };
  const compactions = (script: Script): number => script.calls.filter((call) => call === "compaction").length;
  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await runtime.registry.createThread("ada", "ring", { compaction: true });
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    await queuedCompactionsEnded(data, "ada");
    expect(compactions(script)).toBe(0);
    script.closing = "Told part one.";
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    await runtime.autonomy.tick();
    await queuedCompactionsEnded(data, "ada");
    expect(compactions(script)).toBe(1);
    expect(await thread("ring")).toEqual([]);

    script.heartbeats.length = 0;
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 21 * MINUTE, thread: "ring" });
    at(21);
    await runtime.autonomy.tick();
    await queuedCompactionsEnded(data, "ada");
    expect(turnsOf(script.heartbeats[0])).toEqual([
      ["user", `[Friday 2026-10-30 · 12:21 PM]\n\n${wakeText("12:21 PM", ['[Your trigger "show" fired at Friday 2026-10-30 · 12:21 PM: r]'])}`],
    ]);
    expect(compactions(script)).toBe(1);

    const held = hold();
    script.beatHeld = held;
    script.again = 1;
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 40 * MINUTE, thread: "ring" });
    at(40);
    const waking = runtime.autonomy.tick();
    await held.started.promise;
    const reply = hold();
    script.held = reply;
    const asking = say("wait", "ring");
    held.release.resolve();
    await waking;
    await reply.started.promise;
    expect(compactions(script)).toBe(1);
    expect((await thread("ring")).at(-2)?.content).toStartWith("[User wrote here while this wake was running");
    reply.release.resolve();
    await asking;
    await queuedCompactionsEnded(data, "ada");
    expect(compactions(script)).toBe(2);
  }, long);

  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await say("hello");
    script.closing = "Looked in.";
    runtime.autonomy.wakeFor("ada", { name: "lamp", reason: "r", at: T0 + 20 * MINUTE, thread: "main" });
    at(20);
    await runtime.autonomy.tick();
    await queuedCompactionsEnded(data, "ada");
    expect(compactions(script)).toBe(0);
    expect(await thread("main")).toHaveLength(6);
  }, long);
});

function keepNothing(app: AppConfig): void {
  app.memory.compaction.keep_recent_turns = 0;
  app.memory.compaction.min_turns = 1;
}

async function compactByHand(runtime: ShoreRuntime, thread: string, sent: SidecarRequest[] = []): Promise<void> {
  await runCompactionPass("ada", {
    config: runtime.config,
    generate: (request) => {
      sent.push(structuredClone(request));
      return Promise.resolve({
        model: request.model, content: "noted", content_blocks: [{ type: "text", text: "noted" }], finish_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      });
    },
  }, { thread });
}

test("after a compaction that kept nothing, the next reply, the request rebuilt from disk and the next compaction all open with how long it had been", async () => {
  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await say("goodnight");
    await compactByHand(runtime, "main");
    expect(await thread("main")).toEqual([]);

    at(300);
    await say("good morning");
    const opening: [role: string, text: string] = ["user", "[5 hours later · Friday 2026-10-30 · 5:00 PM]\n\ngood morning"];
    expect(turnsOf(script.replies.at(-1))[0]).toEqual(opening);

    const rebuilt = await rebuildRequestFromDisk("ada", data, runtime.config, { ...NO_MCP, thread: "main" });
    expect(turnsOf(rebuilt?.request)[0]).toEqual(opening);

    const compacting: SidecarRequest[] = [];
    await compactByHand(runtime, "main", compacting);
    expect(turnsOf(compacting[0])[0]).toEqual(opening);
  }, keepNothing);
});

test("a wake in a side thread compacted down to nothing opens with how long it has been since the thread's last message", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring", { compaction: true });
    await say("tell me a story in parts", "ring");
    await compactByHand(runtime, "ring");
    expect(await thread("ring")).toEqual([]);

    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 300 * MINUTE, thread: "ring" });
    at(300);
    await runtime.autonomy.tick();
    expect(turnsOf(script.heartbeats[0])).toEqual([
      ["user", `[5 hours later · Friday 2026-10-30 · 5:00 PM]\n\n${wakeText("5:00 PM", ['[Your trigger "show" fired at Friday 2026-10-30 · 5:00 PM: r]'])}`],
    ]);
  }, keepNothing);
});

test("the message a wake sends is announced like a heartbeat's, and deleting it puts back the files that wake changed", async () => {
  await withCharacter(async ({ runtime, script, workspace, say, thread, command }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    script.beatTool = { name: "bash", input: { command: "printf 'part one' > story.md" } };
    script.closing = "Wrote it down.\n<sendMessage>Part one is written.</sendMessage>";
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    await runtime.autonomy.tick();
    expect(announced).toEqual([["autonomous_message", "Shore - ada", "Part one is written.", undefined]]);
    expect(await Bun.file(join(workspace, "story.md")).text()).toBe("part one");

    const sent = (await thread("ring")).at(-1);
    expect(sent?.content).toBe("Part one is written.");
    await command("delete", { refs: sent?.msg_id }, "ring");
    expect(existsSync(join(workspace, "story.md"))).toBe(false);
  }, (app) => { app.tools.enabled_tools = [...app.tools.enabled_tools, "bash"]; });
});

test("a wake in a thread opens with the diary entries and the user's status that thread hasn't been shown, and is made with the keys Shore was started with", async () => {
  await withCharacter(async ({ runtime, script, data, say, heartbeat }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.closing = "The log is read up to March.";
    at(5);
    await heartbeat();
    setPresence(data, "asleep", T0 + 6 * MINUTE);
    unsetTestEnv(KEY_ENV);
    script.heartbeats.length = 0;
    script.closing = "HEARTBEAT_OK";
    for (const minutes of [20, 40]) {
      runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minutes * MINUTE, thread: "ring" });
      at(minutes);
      await runtime.autonomy.tick();
    }
    const [first, , second] = script.heartbeats;
    expect(turnsOf(first)).toEqual([["user", [
      "[New in your diary. Each entry says where it came from.]\n\nyour note at the end of a heartbeat · Friday 2026-10-30 · 12:05 PM\nThe log is read up to March.\n\n[End of your diary.]",
      '[Their status, set 14 minutes ago: "asleep"]',
      wakeText("12:20 PM", ['[Your trigger "show" fired at Friday 2026-10-30 · 12:20 PM: r]']),
    ].join("|")]]);
    expect(first?.api_key).toBe("fixture-key");
    expect(turnsOf(second).at(-1)).toEqual(["user", wakeText("12:40 PM", ['[Your trigger "show" fired at Friday 2026-10-30 · 12:40 PM: r]'])]);
  });
});

test("a wake whose request can't be built, or that a budget holds back, leaves its thread untouched and the log says why", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    const pinned = runtime.config.models.chat.get("chat.pinned");
    if (pinned === undefined) throw new Error("no pinned model");
    runtime.config.models.chat.set("chat.keyless", { ...pinned, name: "keyless", qualifiedName: "chat.keyless", apiKeyEnv: "SHORE_NO_SUCH_KEY" });
    await runtime.registry.setThreadModel("ada", "ring", "keyless");
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toEqual([]);
    expect(await thread("ring")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["call_failed", "Wake could not build its request: MissingApiKey: API key environment variable SHORE_NO_SUCH_KEY is not set"],
    ]);
  });

  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toEqual([]);
    expect(await thread("ring")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["budget_paused", 'Wake paused before round 0 — budget "beats" is over its month limit ($0.00/$0.00); resets 2026-11-01 12:00 AM'],
    ]);
  }, (app) => {
    app.usage.budgets = [{
      name: "beats", period: "month", cost_usd: 0, warn_at: [], limit: "block", character: undefined, provider: undefined,
      api_key: undefined, model: undefined, call_type: "heartbeat", usage_kind: [], allow_compaction_over_budget: undefined,
      reset_hour: undefined, reset_day_of_week: undefined, reset_day_of_month: undefined, pace_period: undefined,
      pace_action: undefined, pace_warn_at: undefined, warn_action: undefined, pace_warn_action: undefined,
    }];
  });
});

test("a wake whose thread the user edits while it runs writes nothing more there", async () => {
  await withCharacter(async ({ runtime, script, data, say, thread, command }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    const asked = (await thread("ring"))[0];
    const held = hold();
    script.beatHeld = held;
    script.closing = "Told part one.\n<sendMessage>Part one.</sendMessage>";
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    const waking = runtime.autonomy.tick();
    await held.started.promise;
    const deleting = command("delete", { refs: asked?.msg_id }, "ring");
    held.release.resolve();
    await waking;
    await deleting;
    expect(stored(await thread("ring"))).toEqual([
      ["assistant", "", "reply to: tell me a story in parts"],
      ["user", "autonomous", wakeText("12:20 PM", ['[Your trigger "show" fired at Friday 2026-10-30 · 12:20 PM: r]'])],
    ]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["call_failed", 'Wake in "ring" stopped: the thread was changed while it ran'],
    ]);
    expect(diaryOf(data)).toEqual([]);
  });
});

function sealing(app: AppConfig): void {
  app.tools.enabled_tools = [...app.tools.enabled_tools, "start_sealed_thread", "wake_in_thread", "list_threads", "search_chat_logs"];
}

const SEALED_LIST = "[Your sealed threads. Only a wake inside one can see what is in it, and `wake_in_thread` takes you there.\n- `gift` \"Something for you\", opens Saturday 2026-10-31 · 8:00 AM]";

function giftWake(now: string, lines: readonly string[]): string {
  return wakeText(now, lines).replace('your thread "ring"', 'your thread "gift"');
}

async function sealsGift(h: Pick<Harness, "script" | "say" | "heartbeat">): Promise<void> {
  await h.say("hello");
  h.script.beatTool = { name: "start_sealed_thread", input: { name: " gift ", label: " Something for you ", opens: "2026-10-31 08:00" } };
  h.script.closing = "HEARTBEAT_OK";
  at(10);
  await h.heartbeat();
}

test("a sealed thread is kept out of the user's thread list and the character's other turns, which are shown only its label and when it opens", async () => {
  await withCharacter(async (h) => {
    const { runtime, script, data, say, heartbeat, thread, command } = h;
    await sealsGift(h);
    const filesDir = join(data, "ada", "sealed", "gift");
    expect(lastToolResult(await thread("heartbeat"))).toEqual({
      text: `Sealed the thread "gift" (Something for you) until Saturday 2026-10-31 · 8:00 AM. peggy can't see it until then, and your other turns are shown only its label and that time. ` +
        `\`wake_in_thread\` takes you into it. Keep what you make for it in ${filesDir}, which is outside your workspace.`,
      failed: false,
    });
    expect(existsSync(filesDir)).toBe(true);
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "heartbeat"]);
    expect(runtime.registry.sealedThreads("ada")).toEqual([
      { id: "gift", label: "Something for you", unseal_at: "2026-10-31T08:00:00.000Z", created_at: "2026-10-30T12:10:00.000Z" },
    ]);
    expect(JSON.stringify(await command("list_threads", {}))).not.toContain("gift");

    script.replyTool = { name: "list_threads", input: {} };
    at(11);
    await say("what threads do you have?");
    expect(String(lastToolResult(await thread("main"))?.text)).toEndWith(`\n\n${SEALED_LIST}`);
    expect(String(lastToolResult(await thread("main"))?.text)).not.toContain("gift ·");

    at(20);
    await heartbeat();
    expect(textOf(script.heartbeats.at(-2) as SidecarRequest)).toContain(`\n\n${SEALED_LIST}\n\n`);

    expect(await outcomeOf(runtime.registry.createThread("ada", "gift"))).toThrow('thread "gift" already exists for ada');
    expect(await outcomeOf(runtime.registry.forkThread("ada", "main", "gift"))).toThrow('thread "gift" already exists for ada');
    expect(await outcomeOf(runtime.registry.getOrCreate("ada", "gift"))).toThrow('no thread "gift" for ada');
    expect(await runtime.registry.sealedEngine("ada", "main")).toBeUndefined();
    script.replyTool = { name: "start_sealed_thread", input: { name: "gift", label: "Another", opens: "2026-11-02 08:00" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: 'io: thread "gift" already exists for ada', failed: true });
    script.replyTool = { name: "start_sealed_thread", input: { name: "main", label: "Another", opens: "2026-11-02 08:00" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: 'io: thread "main" already exists for ada', failed: true });
    script.replyTool = { name: "start_sealed_thread", input: { name: "late", label: "Too late", opens: "2026-10-30 12:20" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: "io: a sealed thread has to open at a time that is still to come", failed: true });
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift"]);

    const answered = async (input: Record<string, unknown>): Promise<string> => {
      script.replyTool = { name: "start_sealed_thread", input };
      await say("go on");
      return String(lastToolResult(await thread("main"))?.text);
    };
    expect(await answered({ name: "t".repeat(65), label: "A", opens: "2026-11-02 08:00" })).toStartWith("The call to start_sealed_thread was not run because argument `name` must NOT have more than 64 characters.");
    expect(await answered({ name: "box", label: "A", opens: "2026-11-02 08:00", purpose: "a secret" })).toStartWith("The call to start_sealed_thread was not run because argument `purpose` is not allowed.");
    expect(await answered({ name: "b", label: "A", opens: "2026-11-02 08:00" })).toStartWith('Sealed the thread "b" (A) until Monday 2026-11-02 · 8:00 AM.');
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift", "b"]);

    await rm(join(data, "ada", "sealed"), { recursive: true });
    await writeFile(join(data, "ada", "sealed"), "in the way");
    expect(await answered({ name: "box", label: "A", opens: "2026-11-02 08:00" })).toStartWith(`io: nothing was sealed, because the folder for its files, ${join(data, "ada", "sealed", "box")}, could not be made: mkdir:`);
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift", "b"]);
  }, sealing);
});

test("a wake inside a sealed thread sends, announces and logs nothing outside it, and its diary entries stay sealed with it", async () => {
  await withCharacter(async (h) => {
    const { runtime, script, data, emitted, say, heartbeat, thread } = h;
    await sealsGift(h);
    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    script.beatTool = { name: "wake_in_thread", input: { thread: "gift", reason: "Start on it." } };
    at(20);
    await heartbeat();
    expect(lastToolResult(await thread("heartbeat"))?.failed).toBe(false);
    const captured = runtime.callStore?.callCount();
    const transcripts = runtime.callStore?.queryTranscripts("heartbeat", "ada", 100).length;
    script.heartbeats.length = 0;
    emitted.length = 0;
    script.closing = "Made a card.\n<sendMessage>Happy birthday!</sendMessage>";
    at(21);
    await runtime.autonomy.tick();

    expect(turnsOf(script.heartbeats[0])).toEqual([["user", giftWake("12:21 PM", [
      '[You asked for this wake from "heartbeat" at Friday 2026-10-30 · 12:20 PM: Start on it.]',
      `[This thread is sealed until Saturday 2026-10-31 · 8:00 AM. User can't see it, or anything you do or send here, until then, and your other threads are shown only its label, "Something for you". ` +
        `What you send here waits in the thread for them. Keep what you make for it in ${join(data, "ada", "sealed", "gift")}, which is outside your workspace.]`,
    ])]]);
    expect(script.heartbeats.map((request) => [request.context?.thread, request.context?.sealed])).toEqual([["gift", true], ["gift", true]]);
    expect(emitted).toEqual([]);
    expect(announced).toEqual([]);
    expect([runtime.callStore?.callCount(), runtime.callStore?.queryTranscripts("heartbeat", "ada", 100).length]).toEqual([captured, transcripts]);
    expect(diaryOf(data)).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "gift" by a hand-off from "heartbeat"'],
      ["message_sent", "A message was left in a sealed thread"],
    ]);
    const sealedEngine = await runtime.registry.sealedEngine("ada", "gift");
    expect(stored(sealedEngine?.messages() ?? []).slice(-2)).toEqual([
      ["assistant", "", "Made a card.\n[sent to User as the next message here]"],
      ["assistant", "autonomous", "Happy birthday!"],
    ]);
    expect(await runtime.registry.sealedEngine("ada", "gift")).toBe(sealedEngine);
    expect(h.heard("gift")).toBe(false);
    expect(h.events.filter((event) => event.type === "threads_changed" && event.thread === "gift")).toEqual([]);

    at(22);
    await say("anything new?");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith("reply to: hello\nanything new?");
    script.replyTool = { name: "search_chat_logs", input: { query: "birthday" } };
    await say("did you say something about a birthday?");
    expect(String(lastToolResult(await thread("main"))?.text)).toStartWith("birthday: 0 matches.\nSearched 2 messages from every thread");
    script.closing = "HEARTBEAT_OK";
    at(30);
    await heartbeat();
    expect(textOf(script.heartbeats.at(-2) as SidecarRequest)).not.toContain("Made a card.");

    runtime.autonomy.forceHeartbeatState("ada", "dormant");
    script.closing = "Gave it.\n<sendMessage>Open the card.</sendMessage>";
    at(20 * 60);
    await runtime.autonomy.tick();
    await h.shown("gift", (message) => message.content === "Open the card.");
    expect(h.events.filter((event) => event.type === "threads_changed" && event.thread === "gift")).toEqual([{ type: "threads_changed", character: "ada", thread: "gift" }]);
    expect(await runtime.registry.sealedEngine("ada", "gift")).toBeUndefined();
  }, sealing);
});

test("at its time the seal comes off: the thread joins the user's list with what was sent waiting unread, the character is woken there even when dormant, and its diary entries are shown", async () => {
  let root = "";
  await withCharacter(async (h) => {
    const { runtime, script, data, heartbeat } = h;
    root = dirname(data);
    await sealsGift(h);
    script.beatTool = { name: "wake_in_thread", input: { thread: "gift", reason: "Start on it." } };
    at(20);
    await heartbeat();
    script.closing = "Made a card.\n<sendMessage>Happy birthday!</sendMessage>";
    at(21);
    await runtime.autonomy.tick();
  }, sealing);

  await withCharacter(async ({ runtime, script, data, emitted, say, thread, shown }) => {
    at(19 * 60 + 59);
    await say("good morning");
    expect(runtime.autonomy.forceHeartbeatState("ada", "dormant")).toBe(true);
    await runtime.autonomy.tick();
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift"]);
    expect(script.heartbeats).toEqual([]);

    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    script.closing = "Gave it.\n<sendMessage>Open the card.</sendMessage>";
    emitted.length = 0;
    at(20 * 60);
    await runtime.autonomy.tick();
    expect(runtime.registry.sealedThreads("ada")).toEqual([]);
    expect(runtime.registry.listThreads("ada").at(-1)).toEqual({ id: "gift", label: "Something for you", created_at: "2026-10-30T12:10:00.000Z", created_by: "character", compaction: true });
    expect(script.heartbeats.map((request) => [request.context?.thread, request.context?.sealed])).toEqual([["gift", undefined], ["gift", undefined]]);
    expect(turnsOf(script.heartbeats[0]).at(-1)).toEqual(["user", giftWake("8:00 AM", [
      "[The seal on this thread came off at Saturday 2026-10-31 · 8:00 AM. User can see this thread and everything in it from now on. This wake is for giving them what you made.]",
    ]).replace("Friday 2026-10-30 · 8:00 AM", "Saturday 2026-10-31 · 8:00 AM").replace("[wake]", "[about a day later · Saturday 2026-10-31 · 8:00 AM]\n\n[wake]")]);
    expect(emitted.map((each) => [each.thread, each.msg.content])).toEqual([["gift", "Open the card."]]);
    expect(announced).toEqual([["autonomous_message", "Shore - ada", "Open the card.", undefined]]);
    expect(threadActivityNow(data, "ada", "gift").unread).toBe(2);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").at(-1)?.detail).toBe('Woken in "gift" by its seal coming off');
    expect(diaryOf(data)).toEqual([
      ["wake", "Made a card."],
      ["shore", 'The seal on "Something for you" came off. Its thread, `gift`, is in User\'s thread list from now on, and you are being woken there.'],
      ["wake", "Gave it."],
    ]);
    expect((await thread("gift")).at(-1)?.content).toBe("Open the card.");
    await shown("gift", (message) => message.content === "Open the card.");
    script.replyTool = { name: "search_chat_logs", input: { query: "birthday" } };
    await say("did you say something about a birthday?");
    expect(String(lastToolResult(await thread("main"))?.text)).toContain("ada    [gift] (heartbeat) Happy [birthday]!");
    at(20 * 60 + 1);
    await runtime.autonomy.tick();
    expect(script.heartbeats).toHaveLength(2);
  }, sealing, root);
});

test("with the character's own time switched off a seal still comes off at its time, and nothing wakes", async () => {
  let root = "";
  await withCharacter(async (h) => {
    root = dirname(h.data);
    await sealsGift(h);
  }, sealing);
  await withCharacter(async ({ runtime, script, say }) => {
    at(20 * 60);
    await say("good morning");
    await runtime.autonomy.tick();
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "heartbeat", "gift"]);
    expect(script.heartbeats).toEqual([]);
  }, (app) => {
    sealing(app);
    app.behavior.autonomy.enabled = false;
  }, root);
});

test("the activity record a start rebuilds holds the user's messages of the last ninety days and none from before", async () => {
  const counted = (runtime: ShoreRuntime): number | undefined => runtime.autonomy.activityStats("ada", T0)?.messageCount;
  const day = 24 * 60;
  let root = "";
  at(0);
  await withCharacter(async ({ runtime, data, say }) => {
    root = dirname(data);
    await say("hello");
    at(2 * day);
    await say("two days on");
    expect(counted(runtime)).toBe(2);
  });

  at(91 * day);
  await withCharacter(async ({ runtime, say }) => {
    await say("a season later");
    expect(counted(runtime)).toBe(2);
    at(91 * day + 1);
    await say("and again");
    expect(counted(runtime)).toBe(3);
  }, undefined, root);
});

test("a message is counted once in the character's activity record, whether it is the first after a start or follows a restart in the middle of a conversation", async () => {
  const counted = (runtime: ShoreRuntime): number | undefined => runtime.autonomy.activityStats("ada", T0)?.messageCount;
  let root = "";
  await withCharacter(async ({ runtime, data, say }) => {
    root = dirname(data);
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    expect(counted(runtime)).toBe(1);
    at(1);
    await say("the beans are up", "garden");
    at(2);
    await say("and the lamp?");
    expect(counted(runtime)).toBe(3);
  });

  await withCharacter(async ({ runtime, say, regenerate }) => {
    expect(counted(runtime)).toBeUndefined();
    at(10);
    await say("back again", "garden");
    expect(counted(runtime)).toBe(4);
    at(11);
    await say("and here");
    expect(counted(runtime)).toBe(5);
    await regenerate("main");
    expect(counted(runtime)).toBe(5);
  }, undefined, root);

  await withCharacter(async ({ runtime, regenerate }) => {
    at(20);
    await regenerate("main");
    expect(counted(runtime)).toBe(5);
  }, undefined, root);
});
