import { afterAll, afterEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { registrationFor, TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { rebuildRequestFromDisk } from "../src/cache/rebuild.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { History } from "../src/engine/conversation.ts";
import { addDiaryNote, foldDiary, unfoldedDiary } from "../src/autonomy/diary.ts";
import { triggerFiredNote, userWroteNote, wakeNewsNote } from "../src/autonomy/wake_shape.ts";
import { lastSeen, noteSeen, presence, setPresence } from "../src/autonomy/presence.ts";
import { checkFacts, startTriggerTimer, type TriggerService } from "../src/autonomy/trigger_service.ts";
import { DIARY_FOR_CHAT, DIARY_FOR_WAKE, diaryText, wakeRunningText } from "../src/engine/prompt.ts";
import { isWakeOpener, markThreadRead, threadActivityNow } from "../src/engine/threads.ts";
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
import { readCharacterState, writeCharacterState } from "../src/storage/store.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import * as execute from "../src/tools/execute.ts";
import { recordedTurns, replyVersions, workspaceTurnsFor } from "../src/tools/workspace_turns.ts";
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
const KEY_ENV = "SHORE_WAKES_TEST_KEY";

afterAll(restoreTestEnv);
afterEach(() => setSystemTime());

function at(minutes: number): void {
  setSystemTime(new Date(T0 + minutes * MINUTE));
}

function textOf(request: SidecarRequest): string {
  return request.messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : [])).join("\n");
}

interface Script {
  wakes: SidecarRequest[];
  replies: SidecarRequest[];
  calls: string[];
  held: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  closing: string;
  aside?: string | undefined;
  again?: number;
  beatHeld?: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  endHeld?: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  beatTool?: { name: string; input: Record<string, unknown> } | undefined;
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
        yield* eventsForResponse(respond(request, [{ type: "text", text: `reply to: ${textOf(request).split("\n").at(-1) ?? ""}` }]));
        return;
      }
      script.wakes.push(structuredClone(request));
      const resultsIn = request.messages.at(-1)?.content.some((block) => block.type === "tool_result") === true;
      const beat = script.beatHeld;
      if (beat !== undefined && !resultsIn) {
        script.beatHeld = undefined;
        beat.started.resolve();
        await beat.release.promise;
      }
      if (resultsIn && (script.again ?? 0) > 0) {
        script.again = (script.again ?? 0) - 1;
        yield* eventsForResponse(respond(request, [{ type: "tool_use", id: `again-${String(script.wakes.length)}`, name: "read", input: { file_path: "SOUL.md" } }]));
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
        yield* eventsForResponse(respond(request, [{ type: "tool_use", id: `tool-${String(script.wakes.length)}`, name: beatTool.name, input: beatTool.input }]));
        return;
      }
      yield* eventsForResponse(respond(request, resultsIn
        ? [
            { type: "thinking", thinking: "She asked about the lamp, so I'll tell her.", signature: "sig-1" },
            { type: "text", text: script.closing },
          ]
        : [
            ...(script.aside === undefined ? [] : [{ type: "text" as const, text: script.aside }]),
            { type: "tool_use", id: `read-${String(script.wakes.length)}`, name: "read", input: { file_path: "SOUL.md" } },
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
  wakeNow: () => Promise<void>;
  reload: () => Promise<void>;
  thread: (id: string) => Promise<readonly Message[]>;
  shown: (thread: string, match: (message: Message) => boolean) => Promise<void>;
  heard: (thread: string) => boolean;
  events: ServerMessage[];
  command: (name: string, args: Record<string, unknown>, thread?: string) => Promise<ServerMessage>;
}

async function withCharacter(run: (h: Harness) => Promise<void>, configure?: (app: AppConfig) => void, kept?: string): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  if (kept === undefined) at(0);
  const root = kept ?? await mkdtemp(testTmp("shore-wakes-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = ["read"];
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
  const script: Script = { wakes: [], replies: [], calls: [], held: undefined, closing: "<sendMessage>I found the keeper's log.</sendMessage>" };
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
      wakeNow: async () => {
        expect(runtime.autonomy.wakeNow("ada")).toBeDefined();
        await runtime.autonomy.tick();
      },
      reload: async () => {
        autonomy.reloadConfig((name) => runtime.registry.effectiveConfig(name));
        await autonomy.settled("ada");
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

test("a wake in the own-time thread runs while a reply in home is still generating, and its message lands in home after that reply", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread, shown }) => {
    await say("hello");
    const held = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    script.held = held;
    at(1);
    const replying = say("is the lamp lit?");
    await held.started.promise;

    at(2);
    const ticking = wakeNow();
    await shown("own-time", (message) => message.role === "assistant" && message.content.includes("I found the keeper's log."));
    expect(script.wakes).toHaveLength(2);
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
    expect(runtime.registry.ownThread("ada")).toBe("own-time");
    expect(runtime.registry.listThreads("ada").find((record) => record.id === "own-time")).toMatchObject({ label: "Own time", compaction: false });
  });
});

test("a wake's own turn stays in its thread for the user to read, without what it was shown of home, and the next one starts fresh with only what was said in home since", async () => {
  await withCharacter(async ({ script, say, wakeNow, thread }) => {
    await say("the keeper's name is Mara");
    at(10);
    await wakeNow();

    const kept = await thread("own-time");
    expect(kept.map((message) => [message.role, message.origin ?? ""])).toEqual([
      ["user", "autonomous"],
      ["assistant", ""],
      ["user", ""],
      ["assistant", ""],
    ]);
    expect(kept[0]?.content).toStartWith("[wake]\n\n[This wake was started by hand at Friday 2026-10-30 · 12:10 PM, from Shore's command line or its settings.]\n\n[Current time: Friday 2026-10-30 · 12:10 PM]\n\n[This is a wake in your own-time thread, where a wake runs when its trigger names no thread: time of your own, without ");
    expect(kept[0]?.content).not.toContain("the keeper's name is Mara");
    expect(kept.at(-1)?.content_blocks.map((block) => block.type)).toEqual(["thinking", "text"]);
    const first = script.wakes[0] as SidecarRequest;
    expect(first.messages).toHaveLength(1);
    expect(textOf(first)).toStartWith('[wake]\n\nThe last of what was said in your home thread "main":\n\n');
    expect(textOf(first)).toContain("the keeper's name is Mara");

    at(20);
    await say("she keeps a cat too");
    at(30);
    await wakeNow();

    const next = script.wakes.at(-2) as SidecarRequest;
    expect(next.messages).toHaveLength(1);
    expect(textOf(next)).toStartWith('[wake]\n\nWhat was said in your home thread "main" since your last wake here:\n\n');
    expect(textOf(next)).toContain("she keeps a cat too");
    expect(textOf(next)).toContain("reply to: she keeps a cat too");
    expect(textOf(next)).not.toContain("the keeper's name is Mara");
    expect(textOf(next)).not.toContain("She asked about the lamp");
    expect(next.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_use" || block.type === "tool_result")).toEqual([]);
    expect((await thread("own-time")).filter((message) => message.role === "user" && message.origin === "autonomous")).toHaveLength(2);
  });
});

test("a wake in the own-time thread runs on home's model, and that thread is never compacted, however many wakes it holds, not even by hand", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread, command }) => {
    await runtime.registry.setThreadModel("ada", "main", "pinned");
    await say("hello");
    at(10);
    await wakeNow();
    at(20);
    await wakeNow();

    expect(script.wakes.map((request) => request.model)).toEqual(["claude-pinned", "claude-pinned", "claude-pinned", "claude-pinned"]);
    expect(script.calls).not.toContain("compaction");
    expect((await thread("own-time")).filter((message) => message.role === "user" && message.origin === "autonomous")).toHaveLength(2);
    expect(runtime.registry.listThreads("ada").find((record) => record.id === "own-time")?.compaction).toBe(false);
    const asked = runCompactionPass("ada", {
      config: runtime.config,
      generate: () => Promise.reject(new Error("compacting the own-time thread called the model")),
    }, { thread: "own-time" });
    expect(await outcomeOf(asked)).toThrow(`"own-time" is where ada's own time runs. It only keeps a log of its wakes, so it is never compacted`);
    expect(await command("compact", {}, "own-time")).toMatchObject({ type: "error", code: "invalid_request" });
    expect(JSON.stringify(await command("compact", {}, "own-time"))).toContain("is where ada's own time runs. It only keeps a log of its wakes, so it is never compacted");
    expect(await command("compact", { keep_turns: 99 })).toMatchObject({ type: "error", code: "invalid_request", message: "insufficient messages" });
  }, (app) => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.min_turns = 1;
    app.memory.compaction.max_turns = 2;
  });
});

test("wakes and compaction keep the reasoning effort set for each on chat's model, and setting it for them never moves chat's", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, command }) => {
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
    await wakeNow();

    expect(effortOf(script.replies)).toEqual(["high"]);
    expect(script.wakes.map((request) => request.model)).toContain("claude-fixture");
    expect(effortOf(script.wakes)).toEqual(["low"]);
    expect(await compactionEffort()).toBe("medium");

    await effort({ value: "max", background_task: "all" });
    script.wakes.length = 0;
    at(10);
    await wakeNow();
    await say("again");

    expect(effortOf(script.wakes)).toEqual(["max"]);
    expect(await compactionEffort()).toBe("max");
    expect(effortOf(script.replies)).toEqual(["high"]);

    await effort({ value: null, background_task: "heartbeat" });
    script.wakes.length = 0;
    at(20);
    await wakeNow();

    expect(effortOf(script.wakes)).toEqual(["high"]);
  }, (app) => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.min_turns = 1;
  });
});

test("a wake's own turn in the own-time thread notifies nobody and leaves that thread with nothing unread, while its message counts in home", async () => {
  await withCharacter(async ({ data, emitted, say, wakeNow, thread }) => {
    await say("hello");
    at(5);
    await wakeNow();
    markThreadRead(data, "ada", "own-time", T0 + 6 * MINUTE);
    markThreadRead(data, "ada", "main", T0 + 6 * MINUTE);

    at(10);
    await wakeNow();
    expect((await thread("own-time")).filter((message) => message.role === "assistant" && message.content.includes("I found the keeper's log."))).toHaveLength(2);
    expect(emitted.map((event) => [event.thread, event.msg.role, event.msg.content])).toEqual([
      ["main", "assistant", "I found the keeper's log."],
      ["main", "assistant", "I found the keeper's log."],
    ]);
    expect(threadActivityNow(data, "ada", "own-time").unread).toBe(0);
    expect(threadActivityNow(data, "ada", "main").unread).toBe(1);
  });
});

test("a picture a wake sends from the own-time thread is in that thread as well as home, and one it only mentions is in neither", async () => {
  await withCharacter(async ({ script, workspace, say, wakeNow, thread }) => {
    await writeFile(join(workspace, "lamp.png"), await sizedImage(8, 8));
    await writeFile(join(workspace, "sketch.png"), await sizedImage(16, 16));
    script.closing = "I kept ![[sketch.png]] to myself.\n\n<sendMessage>\nThe lamp tonight\n![[lamp.png]]\n</sendMessage>";
    await say("hello");
    at(10);
    await wakeNow();

    const delivered = (await thread("main")).at(-1);
    expect(delivered?.content).toBe("The lamp tonight\n![[lamp.png]]");
    expect(delivered?.images).toEqual([{ path: expect.stringContaining("/sent/") as string, embed: "![[lamp.png]]", name: "lamp.png" }]);
    expect((await thread("own-time")).at(-1)?.images).toEqual(delivered?.images ?? []);
  });
});

test("the user can read the own-time thread but not write there", async () => {
  await withCharacter(async ({ say, wakeNow, thread }) => {
    await say("hello");
    await wakeNow();
    const before = await thread("own-time");

    const refusal = await rejectionOf(say("can I join?", "own-time"));
    expect([(refusal as Error).name, (refusal as Error).message, (refusal as { code?: string }).code]).toEqual([
      "OwnThreadError", `"own-time" is where ada's own time runs, so you can read it but not write there. Write to ada in another thread.`, "invalid_request",
    ]);
    expect(await thread("own-time")).toEqual(before);
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

test("a wake's message that lands in home just before idle compaction stays there unread, and the next reply has it in context", async () => {
  await withCharacter(async ({ data, script, say, wakeNow, thread }) => {
    await say("the keeper's name is Mara");
    markThreadRead(data, "ada", "main", T0);

    at(60);
    await wakeNow();

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
    runtime.autonomy.forceDormancy("ada", "dormant");
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

test("bare --background tunes wakes and compaction on their pinned model while dreams keep the chat model's settings", async () => {
  await withCharacter(async ({ command }) => {
    const set = await command("set_model_setting", { key: "reasoning_effort", value: "low", background_task: "all" });
    expect(set).toMatchObject({ type: "command_output", data: { model: "chat.pinned", background_task: "all" } });
    expect(await command("model_settings", { background_task: "all" })).toMatchObject({ type: "command_output", data: { model: "chat.pinned" } });
    expect(await command("model_settings", { background_task: "dreaming" })).toMatchObject({ type: "command_output", data: { model: "chat.fixture", saved_character: null } });
    const listed = await command("list_models", {});
    const roles = listed.type === "command_output" ? (listed.data as { roles: { role: string; model: string | null; source: string | null }[] }).roles : [];
    expect(roles.filter((role) => ["heartbeat", "compaction", "dreaming"].includes(role.role))).toEqual([
      { role: "heartbeat", model: "chat.pinned", source: "triggers.model" },
      { role: "compaction", model: "chat.pinned", source: "compaction.model" },
      { role: "dreaming", model: "chat.fixture", source: "inherits chat" },
    ]);
  }, (app) => {
    app.defaults.background.heartbeat = "pinned";
    app.defaults.background.compaction = "pinned";
  });
});

function byHand(time: string): string {
  return `[This wake was started by hand at Friday 2026-10-30 · ${time}, from Shore's command line or its settings.]`;
}

function left(minutes: number, text: string): DiaryNote {
  return { id: "", at: new Date(T0 + minutes * MINUTE).toISOString(), thread: "own-time", source: "wake", text };
}

function times(text: string, part: string): number {
  return text.split(part).length - 1;
}

test("what a wake says at the end, apart from the message it sends, is the note its later wakes in that thread start with: in the diary for a day, and after that kept for the next one", async () => {
  await withCharacter(async ({ script, say, wakeNow, thread }) => {
    await say("hello");
    script.closing = "Read the keeper's log up to March.\n<sendMessage>I found the keeper's log.</sendMessage>";
    at(10);
    await wakeNow();
    expect(textOf(script.wakes[0] as SidecarRequest)).not.toContain("[Your diary");
    expect((await thread("main")).at(-1)?.content).toBe("I found the keeper's log.");

    const diary = diaryText([left(10, "Read the keeper's log up to March.")], DIARY_FOR_WAKE, hostZone());
    script.wakes.length = 0;
    script.aside = "March is done, so April is next.";
    script.closing = "NO_NOTE";
    at(70);
    await wakeNow();
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain(`in your home thread "main".]\n\n${diary}\n\n${byHand("1:10 PM")}\n\n[Current time: `);
    expect(textOf(script.wakes[0] as SidecarRequest)).not.toContain("kept for this one");
    expect(diary).toStartWith('[Your diary from the last day. Each entry says where it came from.]\n\nyour note at the end of a wake in "own-time" · ');
    expect(diary).toEndWith("\nRead the keeper's log up to March.\n\n[End of your diary.]");

    script.wakes.length = 0;
    script.aside = undefined;
    script.closing = "<sendMessage>Goodnight.</sendMessage>";
    at(130);
    await wakeNow();
    const third = textOf(script.wakes[0] as SidecarRequest);
    expect(third).toContain(`${diary}\n\n${byHand("2:10 PM")}`);
    expect(third).not.toContain("April is next");

    at(24 * 60 + 9);
    await say("good morning");
    script.wakes.length = 0;
    script.closing = "NO_NOTE";
    await wakeNow();
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain(diary);

    at(24 * 60 + 11);
    await say("still here");
    script.wakes.length = 0;
    await wakeNow();
    const later = textOf(script.wakes[0] as SidecarRequest);
    expect(later).not.toContain("[Your diary");
    expect(later).toContain('in your home thread "main".]\n\n[Your note from the end of your last wake here, Friday 2026-10-30 · 12:10 PM, kept for this one:]\n\nRead the keeper\'s log up to March.\n\n[This wake was started by hand at Saturday 2026-10-31 · 12:11 PM, ');
  });
});

test("the user's next message in each thread arrives with the notes left since the character was last there, once, and they stay with that message", async () => {
  const note = left(10, "The log is read up to March.");
  const block = diaryText([note], DIARY_FOR_CHAT, hostZone());
  let root = "";
  await withCharacter(async ({ runtime, script, data, say, wakeNow, thread }) => {
    root = dirname(data);
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    expect(textOf(script.replies[0] as SidecarRequest)).not.toContain("diary");
    script.closing = "The log is read up to March.";
    at(10);
    await wakeNow();
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
      ["is the lamp lit?", [[note.at, "own-time", "wake", "The log is read up to March."]]],
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

test("a wake in the own-time thread is told once, at its next step, that the user wrote while it was running, whichever thread they wrote in", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    at(10);
    await wakeNow();
    expect(script.wakes.map(textOf).join("\n")).not.toContain("has just written to you");

    for (const [minutes, where] of [[20, "main"], [40, "garden"]] as const) {
      script.wakes.length = 0;
      script.again = 1;
      const held = hold();
      script.beatHeld = held;
      at(minutes);
      const ticking = wakeNow();
      await held.started.promise;
      at(minutes + 1);
      await say("are you there?", where);
      at(minutes + 2);
      await say("hello?", where);
      held.release.resolve();
      await ticking;

      const note = userWroteNote(T0 + (minutes + 1) * MINUTE, "User", hostZone());
      expect(script.wakes).toHaveLength(3);
      expect(textOf(script.wakes[0] as SidecarRequest)).not.toContain("has just written to you");
      expect(textOf(script.wakes[1] as SidecarRequest)).toEndWith(note);
      expect(times(textOf(script.wakes[2] as SidecarRequest), "has just written to you")).toBe(1);
      expect((await thread("own-time")).filter((message) => message.role === "system").at(-1)?.content).toBe(note);
    }
  });
});

test("a message sent while a wake runs tells that turn a wake is running, where and since when, once in each thread, and the note stays with the message", async () => {
  const started = new Date(T0 + 20 * MINUTE).toISOString();
  const running = wakeRunningText({ started_at: started }, hostZone());
  let root = "";
  await withCharacter(async ({ runtime, script, data, say, wakeNow, thread }) => {
    root = dirname(data);
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    at(10);
    await wakeNow();
    at(11);
    await say("nothing is running now");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).not.toContain("A wake of yours");

    const held = hold();
    script.beatHeld = held;
    at(20);
    const ticking = wakeNow();
    await held.started.promise;
    expect(runtime.autonomy.runningWakes()).toEqual([{ character: "ada", startedAt: T0 + 20 * MINUTE }]);
    expect(runtime.autonomy.runningWake("ada")).toMatchObject({ thread: undefined, startedAt: T0 + 20 * MINUTE });
    at(21);
    await say("is the lamp lit?");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(`${running}\nis the lamp lit?`);

    at(22);
    await say("and the door?");
    const later = textOf(script.replies.at(-1) as SidecarRequest);
    expect(times(later, "A wake of yours")).toBe(1);
    expect(later).toEndWith("reply to: is the lamp lit?\nand the door?");

    at(23);
    await say("the beans are up", "garden");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(`${running}\nthe beans are up`);

    held.release.resolve();
    await ticking;
    expect(runtime.autonomy.runningWakes()).toEqual([]);
    expect((await thread("main")).flatMap((message) => message.heartbeat_running === undefined ? [] : [[message.content, message.heartbeat_running]])).toEqual([
      ["is the lamp lit?", { started_at: started }],
    ]);
  });

  await withCharacter(async ({ script, say }) => {
    at(30);
    await say("anything new?");
    const resumed = textOf(script.replies[0] as SidecarRequest);
    expect(resumed).toContain(`${running}\nis the lamp lit?`);
    expect(times(resumed, "A wake of yours")).toBe(1);
  }, undefined, root);
});

test("each side is told about the other in these words, with the thread the wake is in", () => {
  const started = new Date(T0).toISOString();
  expect(wakeRunningText({ started_at: started }, "UTC")).toBe(
    "[A wake of yours in your own-time thread has been running since Friday 2026-10-30 · 12:00 PM. It can't see this conversation. It is only told that a message arrived.]",
  );
  expect(wakeRunningText({ started_at: started, thread: "ring" }, "UTC")).toBe(
    '[A wake of yours in "ring" has been running since Friday 2026-10-30 · 12:00 PM. It can\'t see this conversation. It is only told that a message arrived.]',
  );
  expect(userWroteNote(T0 + MINUTE, "eve", "UTC")).toBe(
    "[eve has just written to you, at Friday 2026-10-30 · 12:01 PM, while this wake is running. " +
    "Another turn of you is answering them, and it knows this wake is running.]",
  );
});

test("a trigger that names no thread wakes the character in the own-time thread with what it said, shares that wake with whatever else fired, and nothing wakes it between firings", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow }) => {
    const events = (): string[] => runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").map((event) => event.detail);
    await say("hello");
    at(10);
    await wakeNow();
    expect(times(textOf(script.wakes[0] as SidecarRequest), "Your trigger")).toBe(0);
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain(`in your home thread "main".]\n\n${byHand("12:10 PM")}\n\n[Current time: Friday 2026-10-30 · 12:10 PM]\n\n[This is a wake in your own-time thread, `);
    expect(events()).toEqual(["Woken by a start by hand"]);

    const tide = { name: "tide-table", reason: "the tide is out", at: T0 + 19 * MINUTE };
    const lamp = { name: "lamp", reason: "the lamp is low", at: T0 + 20 * MINUTE };
    script.wakes.length = 0;
    at(20);
    expect(runtime.autonomy.wakeFor("ada", tide)).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(2);
    const woken = textOf(script.wakes[0] as SidecarRequest);
    expect(woken).toContain(`in your home thread "main".]\n\n${triggerFiredNote(tide, hostZone())}\n\n${triggerFiredNote(lamp, hostZone())}\n\n[Current time: `);
    expect(events()).toEqual(["Woken by a start by hand", 'Woken by trigger "tide-table", "lamp"']);

    script.wakes.length = 0;
    at(21);
    await runtime.autonomy.tick();
    at(24 * 60);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(0);

    expect(runtime.autonomy.wakeFor("ada", { ...tide, at: T0 + 24 * 60 * MINUTE })).toBe("queued");
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(2);
    expect(events().at(-1)).toBe('Woken by trigger "tide-table"');
    expect(runtime.autonomy.wakeFor("nobody", lamp)).toBeUndefined();
  });
});

test("every wake counts towards going dormant, in a thread or not: after the user's limit nothing fires, what was waiting is dropped, and a message from the user starts it again", async () => {
  let root = "";
  const dormant = (runtime: ShoreRuntime): string[] => runtime.autonomy.log("ada", 100).filter((event) => event.kind === "dormant" || event.kind === "wake").map((event) => event.detail);
  const twoWakes = (app: AppConfig): void => { app.behavior.autonomy.triggers.max_idle_wakes = 2; };
  await withCharacter(async ({ runtime, script, data, say }) => {
    root = dirname(data);
    const log = (): string[] => dormant(runtime);
    const wakeIn = async (minute: number, thread?: string): Promise<void> => {
      at(minute);
      runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minute * MINUTE, ...(thread === undefined ? {} : { thread }) });
      await runtime.autonomy.tick();
    };
    await runtime.registry.createThread("ada", "ring");
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    await say("psst", "garden");
    expect(log()).toEqual([]);
    script.closing = "NO_NOTE";
    await wakeIn(10, "ring");
    at(11);
    await say("thanks");
    expect(log()).toEqual(["User returned — idle counter reset"]);
    await say("and here", "garden");
    expect(log()).toHaveLength(1);

    await wakeIn(20, "ring");
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Active", wakes_without_user: 1 });
    await wakeIn(21);
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Dormant", wakes_without_user: 2 });
    expect(log()).toHaveLength(1);

    script.wakes.length = 0;
    await wakeIn(22);
    await wakeIn(23, "ring");
    at(200);
    await runtime.autonomy.tick();
    expect(script.wakes).toEqual([]);
    expect(log()).toEqual(["User returned — idle counter reset", "Went dormant (wakes without the user: 2)"]);
  }, twoWakes);

  at(210);
  await withCharacter(async ({ runtime, script, say }) => {
    await runtime.autonomy.register(registrationFor("ada", runtime.registry.effectiveConfig("ada")));
    await runtime.autonomy.tick();
    expect(runtime.autonomy.status("ada")?.state).toBe("Dormant");
    expect(dormant(runtime).filter((detail) => detail.startsWith("Went dormant"))).toHaveLength(1);

    at(211);
    await say("I'm back");
    expect(dormant(runtime).at(-1)).toBe("User returned — idle counter reset");
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Active", wakes_without_user: 0 });
    script.closing = "NO_NOTE";
    at(271);
    await runtime.autonomy.tick();
    expect(script.wakes, "what fired while it was dormant is not made up").toHaveLength(0);
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 271 * MINUTE });
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(2);
  }, twoWakes, root);
});

test("the user's limits on a character's own time take hold as soon as they change them", async () => {
  await withCharacter(async ({ runtime, say, reload }) => {
    await say("hello");
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 });
    await runtime.autonomy.tick();
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Dormant", wakes_without_user: 1, max_idle_wakes: 1, max_silent_ms: 48 * 60 * MINUTE });

    const { triggers } = runtime.registry.effectiveConfig("ada").app.behavior.autonomy;
    triggers.max_idle_wakes = 4;
    await reload();
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Active", max_idle_wakes: 4 });

    triggers.idle_timeout = ConfigDuration.fromSecs(90);
    await reload();
    at(1.5);
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Dormant", max_silent_ms: 90_000 });
    at(1.4);
    expect(runtime.autonomy.status("ada")?.state).toBe("Active");
  }, (app) => { app.behavior.autonomy.triggers.max_idle_wakes = 1; });
});

test("a trigger that fires while the character is dormant, or with its own time switched off, wakes nothing then or later", async () => {
  const lamp = { name: "lamp", reason: "the lamp is low", at: T0 + 10 * MINUTE };
  await withCharacter(async ({ runtime, script, say }) => {
    await say("hello");
    expect(runtime.autonomy.forceDormancy("ada", "dormant")).toBe(true);
    at(10);
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(0);

    at(20);
    await say("I'm back");
    at(90);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(0);
  });

  await withCharacter(async ({ runtime, script, say }) => {
    await say("hello");
    at(10);
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(0);
  }, (app) => { app.behavior.autonomy.enabled = false; });
});

test("a trigger that fires during a wake in its thread is handed to that wake at its next step, along with word that the user wrote", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow }) => {
    await say("hello");
    const held = hold();
    script.beatHeld = held;
    script.again = 1;
    at(10);
    const ticking = wakeNow();
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

    expect(script.wakes).toHaveLength(3);
    expect(textOf(script.wakes[1] as SidecarRequest)).toEndWith(
      `${triggerFiredNote(tide, hostZone())}\n\n${userWroteNote(T0 + 12 * MINUTE, "User", hostZone())}\n\n${triggerFiredNote(lamp, hostZone())}`,
    );
    expect(times(textOf(script.wakes[2] as SidecarRequest), "Your trigger")).toBe(2);

    script.wakes.length = 0;
    at(14);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(0);
  });
});

test("what set a wake off is told in these words, and nothing new means no note", () => {
  const tide = { name: "tide-table", reason: "the tide is out", at: T0 + MINUTE };
  expect(triggerFiredNote(tide, "UTC")).toBe('[Your trigger "tide-table" fired at Friday 2026-10-30 · 12:01 PM: the tide is out]');
  expect(triggerFiredNote({ name: "", byHand: true, reason: "", at: T0 }, "UTC")).toBe("[This wake was started by hand at Friday 2026-10-30 · 12:00 PM, from Shore's command line or its settings.]");
  expect(triggerFiredNote({ name: "", from: "main", reason: "Tell part two.", at: T0, thread: "ring" }, "UTC")).toBe('[You asked for this wake from "main" at Friday 2026-10-30 · 12:00 PM: Tell part two.]');
  expect(triggerFiredNote({ name: "", seal: true, reason: "It is open.", at: T0, thread: "gift" }, "UTC")).toBe("[The seal on this thread came off at Friday 2026-10-30 · 12:00 PM. It is open.]");
  expect(wakeNewsNote([], "eve", "UTC")).toBeUndefined();
  expect(wakeNewsNote([{ kind: "user_wrote", at: T0 }, { kind: "trigger", firing: tide }], "eve", "UTC")).toBe(
    `${userWroteNote(T0, "eve", "UTC")}\n\n${triggerFiredNote(tide, "UTC")}`,
  );
});

function withTriggers(app: AppConfig): void {
  app.tools.enabled_tools.push("bash");
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
    expect(script.wakes).toHaveLength(0);
    await runtime.autonomy.tick();

    const woken = textOf(script.wakes[0] as SidecarRequest);
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
    expect(script.wakes.length).toBeGreaterThan(0);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["after", "Write it up."]]);

    const held = hold();
    script.beatHeld = held;
    at(20);
    const ticking = runtime.autonomy.wakeNow("ada") === undefined ? Promise.resolve() : runtime.autonomy.tick();
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

test("a trigger that fires while a wake is writing its last words isn't lost: it wakes the character once that wake is over, and only then is its follower set off", async () => {
  const file = '[lamp]\nevery = "10m"\nreason = "Trim the lamp."\ncooldown = "1m"\n\n[after]\nfollows = "lamp"\nreason = "Write it up."\nwake = false\n';
  await withCharacter(async ({ runtime, script, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), file);
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    const end = hold();
    script.endHeld = end;
    at(10);
    const ticking = runtime.autonomy.wakeNow("ada") === undefined ? Promise.resolve() : runtime.autonomy.tick();
    await end.started.promise;
    at(11);
    await runtime.triggers.tick();
    expect(runtime.triggers.view("ada").triggers.map((each) => each.fired)).toEqual([1, 0]);
    end.release.resolve();
    await ticking;
    expect(script.wakes).toHaveLength(2);
    expect(script.wakes.map(textOf).join("\n")).not.toContain("Trim the lamp.");
    at(12);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([]);

    script.wakes.length = 0;
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(2);
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain('[Your trigger "lamp" fired at Friday 2026-10-30 · 12:11 PM: Trim the lamp.]');
    expect(runtime.autonomy.log("ada", 100).map((event) => event.detail)).toContain('Woken by trigger "lamp"');
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["after", "Write it up."]]);
    expect(runtime.triggers.view("ada").triggers.map((each) => each.fired)).toEqual([1, 1]);

    script.wakes.length = 0;
    at(13);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(0);
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

test("the character's triggers run whenever its own time is switched on, a check only when it has the bash tool, and nothing while it is dormant", async () => {
  const noBash = "`touch` isn't running: its `check` is a command, and you don't have the `bash` tool to run commands with";
  await withCharacter(async ({ runtime, workspace, data, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `${TOUCH}\n[lamp]\nevery = "10m"\nreason = "Trim the lamp."\nwake = false\n`);
    await say("hello");
    await looks(runtime);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    const view = runtime.triggers.view("ada");
    expect([view.enabled, view.triggers.map((each) => each.trigger.name), view.problems]).toEqual([true, ["lamp"], [noBash]]);
    expect(diaryOf(data)).toEqual([["shore", `These triggers in TRIGGERS.toml aren't running:\n- ${noBash}`], ["lamp", "Trim the lamp."]]);
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
    expect(runtime.autonomy.forceDormancy("ada", "dormant")).toBe(true);
    await looks(runtime);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    expect(runtime.triggers.view("ada").problems).toEqual([]);
    expect(runtime.autonomy.forceDormancy("ada", "active")).toBe(true);
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

test("a note the character writes in its diary from a conversation reaches its wakes and its other threads, and isn't shown again where it was written", async () => {
  await withCharacter(async ({ runtime, script, data, say, wakeNow, thread }) => {
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
    script.closing = "NO_NOTE";
    at(10);
    await wakeNow();
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain('your note, written in "main" · Friday 2026-10-30 · 12:05 PM\nWater the fern on Friday.');

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

test("the character can list its triggers from a conversation, and is told when it has none or its own time is off", async () => {
  const file = '[lamp]\nevery = "1h"\nreason = "Trim the lamp."\n';
  await withCharacter(async ({ runtime, script, workspace, say, thread }) => {
    script.replyTool = { name: "list_triggers", input: {} };
    await say("what have you set up?");
    expect(lastToolResult(await thread("main"))).toEqual({ text: "Your triggers, from TRIGGERS.toml in your workspace root.\n\nYou have none there yet, so nothing wakes you on its own.", failed: false });

    await writeFile(join(workspace, "TRIGGERS.toml"), file);
    at(1);
    await runtime.triggers.tick();
    script.replyTool = { name: "list_triggers", input: {} };
    await say("and now?");
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
      text: "Your triggers, from TRIGGERS.toml in your workspace root. peggy has your own time switched off, so nothing fires.\n\nYou have none there yet, so nothing wakes you on its own.",
      failed: false,
    });
  }, (app) => {
    app.tools.enabled_tools = [...app.tools.enabled_tools, "list_triggers"];
    app.behavior.autonomy.enabled = false;
  });
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

test("a wake starts with the user's status and its age while one is set, and a status that changes sets off the trigger for it", async () => {
  await withCharacter(async ({ runtime, script, workspace, data, say, wakeNow }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `[status]\nwhen = "status_changed"\ncheck = 'echo "now: $SHORE_USER_STATUS"'\nwake = false\n`);
    await say("hello");
    script.closing = "NO_NOTE";
    at(1);
    await runtime.triggers.tick();
    await wakeNow();
    expect(textOf(script.wakes[0] as SidecarRequest)).not.toContain("status");

    setPresence(data, "asleep", T0 + 5 * MINUTE);
    await runtime.triggers.statusChanged();
    script.wakes.length = 0;
    at(65);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["status", "now: asleep"]]);
    await wakeNow();
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain(`in your home thread "main".]\n\n[User's status, set about an hour ago: "asleep"]\n\n[Your diary from the last day.`);

    setPresence(data, "", T0 + 70 * MINUTE);
    script.wakes.length = 0;
    at(130);
    await wakeNow();
    expect(textOf(script.wakes[0] as SidecarRequest)).not.toContain("User's status");
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
    for (let n = 1; n <= 21; n += 1) addDiaryNote(dir, { at: T0 + n * MINUTE, thread: "own-time", source: "wake", text: `note ${String(n)}` }, newId);
    addDiaryNote(dir, { at: T0 + 22 * MINUTE, thread: "own-time", source: "trigger", trigger: "mail", text: "Two letters." }, newId);
    foldDiary(dir, ["d1", "d22"]);
    at(30);

    const newest = await listed({});
    expect(newest.kept).toBe(23);
    expect(newest.notes.map((note) => note["text"])).toEqual([...Array.from({ length: 19 }, (_unused, n) => `note ${String(n + 3)}`), "Two letters."]);
    expect(newest.notes.at(-1)).toEqual({ at: new Date(T0 + 22 * MINUTE).toISOString(), thread: "own-time", source: "trigger", trigger: "mail", text: "Two letters.", shown: true, dreamed: false });
    expect(newest.notes.at(-2)).toEqual({ at: new Date(T0 + 21 * MINUTE).toISOString(), thread: "own-time", source: "wake", text: "note 21", shown: true, dreamed: true });

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

function wakeShown(now: string, shown: readonly string[], lines: readonly string[], limit = "30 minutes", nudgeAfter = "25 minutes"): string {
  return [
    "[wake]",
    ...shown,
    ...lines,
    `[Current time: Friday 2026-10-30 · ${now}]`,
    '[This is a wake in your thread "ring": time of your own, without User having written. A wake starts fresh. Nothing that happened in this thread before is in front of you, only what is above: what was said here since your last wake here, the note that wake left you, and your diary. Any files this thread keeps are in your prompt, and the rest of what was said here is in your chat logs. You are free to use your tools as you wish.',
    "What you write in your final response is your note to yourself. It goes in your diary, where your other turns see it for the next day, and your next wake here starts with it however much later that is. So end with where you stopped and what comes next. Keep it short, because a long note is cut, and put anything longer in a file that the note points to. To say something to User, wrap it in `<sendMessage>...</sendMessage>` tags in your final response. That text is posted in this thread as a message to them. The rest of what you do in a wake stays in this thread as your working: they can read it if they look, but nothing tells them it is there. Your later turns here aren't shown it either, only a line saying how much of it there was.",
    `A wake here can run for up to ${limit}. After ${nudgeAfter}, you will get a nudge to wrap up, with a few more rounds to finish. If User writes in this thread while you are working, the wake stops at the end of the step it is on so that you can answer them, and you are woken here again to pick it up once they have been quiet here for 10 minutes.]`,
  ].join("\n\n");
}

function wakeText(now: string, lines: readonly string[], limit = "30 minutes", nudgeAfter = "25 minutes"): string {
  return wakeShown(now, [], lines, limit, nudgeAfter);
}

function ownWakeShown(now: string, shown: readonly string[], lines: readonly string[], limit = "30 minutes", nudgeAfter = "25 minutes"): string {
  return [
    "[wake]",
    ...shown,
    ...lines,
    `[Current time: Friday 2026-10-30 · ${now}]`,
    '[This is a wake in your own-time thread, where a wake runs when its trigger names no thread: time of your own, without User having written. A wake starts fresh. Nothing that happened in this thread before is in front of you, only what is above: what was said in your home thread, "main", since your last wake here, the note that wake left you, and your diary. You are free to use your tools as you wish.',
    'What you write in your final response is your note to yourself. It goes in your diary, where your other turns see it for the next day, and your next wake here starts with it however much later that is. So end with where you stopped and what comes next. Keep it short, because a long note is cut, and put anything longer in a file that the note points to. To say something to User, wrap it in `<sendMessage>...</sendMessage>` tags in your final response. That text arrives in "main" as a message to them. The rest of what you do stays in this thread, which they can read but don\'t write in, and your later wakes aren\'t shown it.',
    `A wake here can run for up to ${limit}. After ${nudgeAfter}, you will get a nudge to wrap up, with a few more rounds to finish. If User writes to you while you are working, the wake goes on, and another turn of you answers them. That turn can change your workspace too, so when you commit, stage only the files you changed.]`,
  ].join("\n\n");
}

function setOffBy(opener: string | undefined): string[] {
  return (opener ?? "").split("\n\n").filter((part) => /^\[(Your trigger "|You asked for this |The seal on |This wake was started by hand )/.test(part));
}

function said(who: string, time: string, text: string): string {
  return `${who} · Friday 2026-10-30 · ${time}\n${text}`;
}

function wroteLast(ago: string, where = "this thread"): string {
  return `[User last wrote to you ${ago}, in ${where}.]`;
}

function diaryOfDay(...entries: [from: string, time: string, text: string][]): string {
  return ["[Your diary from the last day. Each entry says where it came from.]", ...entries.map(([from, time, text]) => `${from} · Friday 2026-10-30 · ${time}\n${text}`), "[End of your diary.]"].join("\n\n");
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

test("a trigger that names a thread wakes the character there, fresh, with what was said there since its last wake there, and what it sends lands there unread", async () => {
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
    const held = hold();
    script.beatHeld = held;
    const waking = fires(runtime, 11);
    await held.started.promise;
    at(11.5);
    held.release.resolve();
    await waking;

    const opener = wakeText("12:11 PM", [FIRED]);
    expect(script.wakes.map((request) => [request.model, request.context?.call_type, request.context?.thread])).toEqual([
      ["claude-pinned", "heartbeat", "ring"],
      ["claude-pinned", "heartbeat_tool_loop", "ring"],
    ]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("12:11 PM", [
      `The last of what was said in this thread:\n\n${said("User", "12:01 PM", "tell me a story in parts")}\n\n${said("you", "12:01 PM", "reply to: tell me a story in parts")}`,
      wroteLast("10 minutes ago"),
    ], [FIRED])]]);
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
      turns: 2, last_active: new Date(T0 + 11.5 * MINUTE).toISOString(), last_user: new Date(T0 + MINUTE).toISOString(), unread: 1,
    });
    expect(unfoldedDiary(join(data, "ada")).map((note) => [note.source, note.thread, note.text])).toEqual([["wake", "ring", "Told part one; the fox is at the gate."]]);

    at(12);
    await say("and then?", "ring");
    expect(turnsOf(script.replies.at(-1)).slice(2)).toEqual([
      ["user", opener],
      ["system", "[Your working in this wake isn't shown here: 1 tool call. Your note from the end of it follows.]"],
      ["assistant", "Told part one; the fox is at the gate.\n[sent to User as the next message here]"],
      ["user", "[wake · Friday 2026-10-30 · 12:11 PM]"],
      ["assistant", "Part one: the fox came to the gate."],
      ["user", "and then?"],
    ]);
    at(13);
    await say("anything new?");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(
      '[New in your diary. Each entry says where it came from.]\n\nyour note at the end of a wake in "ring" · Friday 2026-10-30 · 12:11 PM\nTold part one; the fox is at the gate.\n\n[End of your diary.]\nanything new?',
    );

    script.wakes.length = 0;
    script.closing = "NO_NOTE";
    await fires(runtime, 71);
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring"]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("1:11 PM", [
      `What was said in this thread since your last wake here:\n\n${said("you, on your own time", "12:11 PM", "Part one: the fox came to the gate.")}\n\n${said("User", "12:12 PM", "and then?")}\n\n${said("you", "12:12 PM", "reply to: and then?")}`,
      wroteLast("58 minutes ago", 'your home thread "main"'),
      diaryOfDay(['your note at the end of a wake in "ring"', "12:11 PM", "Told part one; the fox is at the gate."]),
    ], ['[Your trigger "show" fired at Friday 2026-10-30 · 1:11 PM: Tell the next part.]'])]]);

    script.wakes.length = 0;
    await fires(runtime, 25 * 60 + 11);
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("1:11 PM", [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("about a day ago", 'your home thread "main"'),
      "[Your note from the end of your last wake here, Friday 2026-10-30 · 12:11 PM, kept for this one:]\n\nTold part one; the fox is at the gate.",
    ], ['[Your trigger "show" fired at Saturday 2026-10-31 · 1:11 PM: Tell the next part.]']).replace("[Current time: Friday 2026-10-30", "[Current time: Saturday 2026-10-31")]]);
  }, (app) => {
    withTriggers(app);
    app.behavior.autonomy.triggers.max_idle_wakes = 10;
  });
});

test("a trigger that names a thread the character doesn't have, or its own-time thread, wakes nothing and says so in the diary", async () => {
  await withCharacter(async ({ runtime, script, workspace, data, say, wakeNow }) => {
    await say("hello");
    script.closing = "NO_NOTE";
    at(1);
    await wakeNow();
    script.wakes.length = 0;
    await writeFile(join(workspace, "TRIGGERS.toml"), '[lost]\nevery = "10m"\nreason = "r"\nthread = "nowhere"\n\n[beat]\nevery = "10m"\nreason = "r"\nthread = "own-time"\n');
    await runtime.triggers.tick();
    await fires(runtime, 12);
    expect(script.wakes).toEqual([]);
    expect(diaryOf(data)).toEqual([
      ["shore", 'You were to be woken in the thread "nowhere" by trigger "lost", but you have no such thread, so nothing ran. `list_threads` shows the threads you do have.'],
      ["shore", 'You were to be woken in the thread "own-time" by trigger "beat", but you have no such thread, so nothing ran. `list_threads` shows the threads you do have.'],
    ]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-4)).toEqual([
      ["tick_fired", 'Woken in "nowhere" by trigger "lost"'],
      ["call_failed", 'Wake skipped: no thread "nowhere"'],
      ["tick_fired", 'Woken in "own-time" by trigger "beat"'],
      ["call_failed", 'Wake skipped: no thread "own-time"'],
    ]);
  }, withTriggers);
});

const AFTER = '\n[after]\nfollows = "show"\nreason = "Write it up."\nwake = false\n';

test("the user's message stops a wake in that thread at the end of its step and is answered, and once they have been quiet there for ten minutes a fresh wake picks it up, told how the last one stopped", async () => {
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
    const running = runtime.autonomy.runningWake("ada");
    expect([running?.thread, running?.startedAt]).toEqual(["ring", T0 + 11 * MINUTE]);
    at(12);
    const asking = say("wait, what is the fox called?", "ring");
    held.release.resolve();
    await waking;
    await asking;

    const opener = wakeText("12:11 PM", [FIRED]);
    const stopped = "[User wrote here while this wake was running, so Shore stopped it here for you to answer them. Once they have been quiet in this thread for 10 minutes, Shore wakes you here again to pick it up.]";
    expect(script.wakes).toHaveLength(1);
    expect(stored(await thread("ring")).slice(2)).toEqual([
      ["user", "autonomous", opener],
      ["assistant", "", "Let me look."],
      ["user", "", "<SOUL.md>"],
      ["system", "autonomous", stopped],
      ["user", "", "wait, what is the fox called?"],
      ["assistant", "", "reply to: wait, what is the fox called?"],
    ]);
    const cutShort: [role: string, text: string][] = [
      ["user", opener],
      ["system", "[Your working in this wake isn't shown here: 1 tool call, ending with `read`. It ended without a note from you. The last thing you wrote in it: \"Let me look.\"]"],
      ["system", stopped],
      ["user", "wait, what is the fox called?"],
    ];
    expect(turnsOf(script.replies.at(-1)).slice(2)).toEqual(cutShort);
    expect(emitted.filter((each) => each.msg.origin === "autonomous")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind !== "tool_use").map((event) => [event.kind, event.detail]).slice(-4)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["wake", 'Wake in "ring" stopped for User\'s message'],
      ["message_skipped", "Wake completed — no message sent"],
      ["wake", "User active in another thread — idle counter reset"],
    ]);
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([]);

    script.again = 0;
    script.aside = undefined;
    at(13);
    await say("is the lamp lit?");
    at(21);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(1);
    script.closing = "Told part one.\n<sendMessage>Part one: Rue came to the gate.</sendMessage>";
    at(22);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(3);
    expect(turnsOf(script.wakes[1])).toEqual([["user", wakeShown("12:22 PM", [
      `The last of what was said in this thread:\n\n${said("User", "12:01 PM", "tell me a story in parts")}\n\n${said("you", "12:01 PM", "reply to: tell me a story in parts")}\n\n${said("User", "12:12 PM", "wait, what is the fox called?")}\n\n${said("you", "12:12 PM", "reply to: wait, what is the fox called?")}`,
      "[Your last wake here was stopped for User's message at Friday 2026-10-30 · 12:12 PM, after 1 round, before it had finished. Nothing from it was sent to User. The last thing it wrote: \"Let me look.\" Whatever it had already changed with its tools is still in place.]",
      wroteLast("9 minutes ago", 'your home thread "main"'),
    ], [FIRED])]]);
    expect((await thread("ring")).at(-1)?.content).toBe("Part one: Rue came to the gate.");
    await runtime.triggers.tick();
    expect(diaryOf(data)).toEqual([["wake", "Told part one."], ["after", "Write it up."]]);
    at(40);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(3);
  }, withTriggers);
});

const RING_FIRED = (time: string): string => `[Your trigger "show" fired at Friday 2026-10-30 · ${time}: r]`;

async function wakesInRing(runtime: ShoreRuntime, minutes: number): Promise<void> {
  runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minutes * MINUTE, thread: "ring" });
  at(minutes);
  await runtime.autonomy.tick();
}

test("a wake's working stays in its thread for the user, and is left out of what a reply there, the request rebuilt from disk and that thread's compaction are sent, while a later wake there starts fresh", async () => {
  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    script.aside = "Let me find my place.";
    script.again = 1;
    script.closing = "Told part one.\n<sendMessage>Part one: the fox came to the gate.</sendMessage>";
    await wakesInRing(runtime, 11);

    const first = wakeText("12:11 PM", [RING_FIRED("12:11 PM")]);
    expect(stored(await thread("ring")).slice(2)).toEqual([
      ["user", "autonomous", first],
      ["assistant", "", "Let me find my place."],
      ["user", "", "<SOUL.md>"],
      ["assistant", "", ""],
      ["user", "", "<SOUL.md>"],
      ["assistant", "", "Told part one.\n[sent to User as the next message here]"],
      ["assistant", "autonomous", "Part one: the fox came to the gate."],
    ]);
    expect((await thread("ring")).at(-2)?.content_blocks.map((block) => block.type)).toEqual(["thinking", "text"]);
    const firstSeen: [role: string, text: string][] = [
      ["user", "tell me a story in parts"],
      ["assistant", "reply to: tell me a story in parts"],
      ["user", first],
      ["system", "[Your working in this wake isn't shown here: 2 tool calls. Your note from the end of it follows.]"],
      ["assistant", "Told part one.\n[sent to User as the next message here]"],
      ["user", "[wake · Friday 2026-10-30 · 12:11 PM]"],
      ["assistant", "Part one: the fox came to the gate."],
    ];

    script.wakes.length = 0;
    script.aside = undefined;
    script.closing = "Nothing to add yet.";
    await wakesInRing(runtime, 12);
    const second = wakeText("12:12 PM", [RING_FIRED("12:12 PM")]);
    const shownSecond = wakeShown("12:12 PM", [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("11 minutes ago"),
      diaryOfDay(['your note at the end of a wake in "ring"', "12:11 PM", "Told part one."]),
    ], [RING_FIRED("12:12 PM")]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", shownSecond]]);
    expect(turnsOf(script.wakes[1])).toEqual([
      ["user", shownSecond],
      ["assistant", "<tool_use>"],
      ["user", "<tool_result>"],
    ]);

    at(13);
    await say("and then?", "ring");
    const bothSeen: [role: string, text: string][] = [
      ...firstSeen,
      ["user", second],
      ["system", "[Your working in this wake isn't shown here: 1 tool call. Your note from the end of it follows.]"],
      ["assistant", "Nothing to add yet."],
      ["user", "and then?"],
    ];
    expect(turnsOf(script.replies.at(-1))).toEqual(bothSeen);
    expect((await thread("ring")).filter((message) => message.content_blocks.some((block) => block.type === "tool_use"))).toHaveLength(3);

    const answered: [role: string, text: string][] = [...bothSeen, ["assistant", "reply to: and then?"]];
    const rebuilt = await rebuildRequestFromDisk("ada", data, runtime.config, { ...NO_MCP, thread: "ring" });
    expect(turnsOf(rebuilt?.request)).toEqual(answered);

    markThreadRead(data, "ada", "ring", T0 + 14 * MINUTE);
    const compacting: SidecarRequest[] = [];
    await compactByHand(runtime, "ring", compacting);
    expect(turnsOf(compacting[0]).slice(0, -1)).toEqual(answered);
    expect(await thread("ring")).toEqual([]);
  }, keepNothing);
});

test("a wake's working doesn't count towards its thread's size: a thread is trimmed or compacted for what later turns are sent of it", async () => {
  const aLot = "the lamp ".repeat(80_000);
  await withCharacter(async ({ runtime, script, say, thread, command }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    script.aside = aLot;
    script.closing = "Told part one.";
    await wakesInRing(runtime, 11);
    at(12);
    await say("and then?", "ring");
    expect((await thread("ring")).map((message) => message.content.length > 100_000 ? "a lot" : message.role)).toEqual([
      "user", "assistant", "user", "a lot", "user", "assistant", "user", "assistant",
    ]);
    const status = await command("status", {}, "ring");
    expect(status.type === "command_output" ? (status.data as { context_tokens: number }).context_tokens : undefined).toBeLessThan(1000);

    script.aside = undefined;
    script.closing = aLot;
    await wakesInRing(runtime, 23);
    expect(await thread("ring"), "put away once the wake is over, as after a reply").toEqual([]);
    at(24);
    await say("go on", "ring");
    expect((await thread("ring")).map((message) => message.content)).toEqual(["go on", "reply to: go on"]);
  }, (app) => {
    app.memory.compaction.keep_recent_turns = 0;
  });

  const compactions = (script: Script): number => script.calls.filter((call) => call === "compaction").length;
  await withCharacter(async ({ runtime, script, data, say }) => {
    await runtime.registry.createThread("ada", "ring", { compaction: true });
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    script.aside = aLot;
    script.closing = "Told part one.";
    await wakesInRing(runtime, 11);
    await queuedCompactionsEnded(data, "ada");
    expect(compactions(script)).toBe(0);

    script.aside = undefined;
    script.closing = aLot;
    await wakesInRing(runtime, 12);
    await queuedCompactionsEnded(data, "ada");
    expect(compactions(script)).toBe(1);
  }, (app) => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.min_turns = 1;
    app.memory.compaction.max_context_tokens = 100_000;
  });
});

test("a wake waits for the user to have been quiet in its thread for ten minutes, however lately they wrote elsewhere", async () => {
  await withCharacter(async ({ runtime, script, say }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(5);
    await say("one more thing", "ring");
    script.closing = "NO_NOTE";
    expect(runtime.autonomy.wakeFor("ada", { name: "show", reason: "Tell the next part.", at: T0 + 6 * MINUTE, thread: "ring" })).toBe("queued");
    at(14);
    await say("is the lamp lit?");
    await runtime.autonomy.tick();
    at(14.999);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(0);
    at(15);
    await runtime.autonomy.tick();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring"]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("12:15 PM", [
      `The last of what was said in this thread:\n\n${said("User", "12:05 PM", "one more thing")}\n\n${said("you", "12:05 PM", "reply to: one more thing")}`,
      wroteLast("a minute ago", 'your home thread "main"'),
    ], ['[Your trigger "show" fired at Friday 2026-10-30 · 12:06 PM: Tell the next part.]'])]]);
  }, withTriggers);
});

function handOff(...names: string[]): (app: AppConfig) => void {
  return (app) => {
    app.tools.enabled_tools = [...app.tools.enabled_tools, "wake_in_thread", ...names];
    app.behavior.autonomy.triggers.max_wake_limit = ConfigDuration.fromSecs(2 * 3600);
    app.behavior.autonomy.triggers.max_idle_wakes = 10;
  };
}

test("from a wake in the own-time thread the character hands off into another thread, and is woken there next with its reason and the limit it asked for, held to the user's ceiling", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.beatTool = { name: "wake_in_thread", input: { thread: " ring ", reason: " Tell part two. ", limit: "6h" } };
    script.closing = "NO_NOTE";
    at(10);
    await wakeNow();
    expect(lastToolResult(await thread("own-time"))).toEqual({
      text: 'Shore will wake you in "ring" for up to 2 hours, once this turn is over and peggy has been quiet there for 10 minutes.', failed: false,
    });
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["own-time", "own-time"]);

    script.closing = "Told part two.\n<sendMessage>Part two: the gate opened.</sendMessage>";
    at(11);
    await runtime.autonomy.tick();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["own-time", "own-time", "ring", "ring"]);
    expect(turnsOf(script.wakes[2])).toEqual([
      ["user", wakeShown("12:11 PM", ["Nothing has been said in this thread yet.", wroteLast("11 minutes ago", 'your home thread "main"')], ['[You asked for this wake from "own-time" at Friday 2026-10-30 · 12:10 PM: Tell part two.]'], "2 hours", "105 minutes")],
    ]);
    expect((await thread("ring")).at(-1)?.content).toBe("Part two: the gate opened.");
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").at(-1)?.detail).toBe('Woken in "ring" by a hand-off from "own-time"');

    script.beatTool = { name: "wake_in_thread", input: { thread: "ring", reason: "Tell part three." } };
    script.closing = "NO_NOTE";
    at(30);
    await wakeNow();
    expect(lastToolResult(await thread("own-time"))?.text).toBe('Shore will wake you in "ring" for up to 30 minutes, once this turn is over and peggy has been quiet there for 10 minutes.');
    script.beatTool = { name: "wake_in_thread", input: { thread: "main", reason: "And tell them." } };
    at(31);
    await runtime.autonomy.tick();
    expect(turnsOf(script.wakes.at(-2)).at(-1)?.[1]).toContain("A wake here can run for up to 30 minutes. After 25 minutes,");
    expect(lastToolResult(await thread("ring"))).toEqual({ text: "io: a wake can't be handed on from here", failed: true });
    expect(script.wakes).toHaveLength(8);
    at(32);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(8);
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
    script.closing = "NO_NOTE";
    script.replyTool = { name: "wake_in_thread", input: { thread: "own-time", reason: "r" } };
    at(1);
    expect(runtime.autonomy.wakeNow("ada")).toBeDefined();
    await runtime.autonomy.tick();
    expect(await refused({ thread: "own-time", reason: "r" })).toBe('io: you have no thread "own-time" to be woken in; `list_threads` shows the ones you have');
    script.wakes.length = 0;
    at(20);
    await runtime.autonomy.tick();
    expect(script.wakes).toEqual([]);

    script.replyTool = { name: "wake_in_thread", input: { thread: "ring", reason: "Tell the next part.", limit: "1m" } };
    await say("off you go");
    expect(lastToolResult(await thread("main"))).toEqual({
      text: 'Shore will wake you in "ring" for up to 1 minute, once this turn is over and peggy has been quiet there for 10 minutes.', failed: false,
    });
    await runtime.autonomy.tick();
    expect(turnsOf(script.wakes[0])).toEqual([
      ["user", wakeShown("12:20 PM", ["Nothing has been said in this thread yet.", wroteLast("a minute ago", 'your home thread "main"')], ['[You asked for this wake from "main" at Friday 2026-10-30 · 12:20 PM: Tell the next part.]'], "1 minute", "50 seconds")],
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

    script.closing = "NO_NOTE";
    at(40);
    await runtime.autonomy.tick();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring", "garden", "garden"]);
    const ring = turnsOf(script.wakes[0]).at(-1)?.[1] ?? "";
    expect(ring).toStartWith("[wake]\n\nNothing has been said in this thread yet.\n\n");
    expect(setOffBy(ring)).toEqual([
      '[Your trigger "show" fired at Friday 2026-10-30 · 12:19 PM: show is due]',
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:22 PM: Tell part three.]',
    ]);
    expect(ring).not.toContain("Tell part two.");
    expect(setOffBy(turnsOf(script.wakes[2]).at(-1)?.[1])).toEqual(['[You asked for this wake from "main" at Friday 2026-10-30 · 12:20 PM: Water the beans.]']);

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

    script.wakes.length = 0;
    script.closing = "NO_NOTE";
    at(30);
    await runtime.autonomy.tick();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring"]);
    const pickUp = turnsOf(script.wakes[0]).at(-1)?.[1] ?? "";
    expect(pickUp).toContain("\n\n[Your last wake here was stopped for User's message at Friday 2026-10-30 · 12:12 PM, after 1 round, before it had finished. Nothing from it was sent to User. Whatever it had already changed with its tools is still in place.]\n\n");
    expect(setOffBy(pickUp)).toEqual([
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:01 PM: Tell part two.]',
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:14 PM: Tell part three.]',
    ]);
  }, handOff());
});

test("a hand-off is refused when the character's own time is switched off", async () => {
  await withCharacter(async ({ script, say, thread, runtime }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.replyTool = { name: "wake_in_thread", input: { thread: "ring", reason: "r" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: "io: peggy has your own time switched off, so nothing would wake you", failed: true });
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
    const where = (): (string | undefined)[] => script.wakes.map((request) => request.context?.thread);
    await runtime.registry.createThread("ada", "ring");
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    script.closing = "NO_NOTE";

    let held = hold();
    script.beatHeld = held;
    script.again = 1;
    at(10);
    expect(runtime.autonomy.wakeFor("ada", fired("show", 9, "ring"))).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", fired("show", 10, "ring"))).toBe("queued");
    let waking = runtime.autonomy.tick();
    await held.started.promise;
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("12:10 PM", ["Nothing has been said in this thread yet.", wroteLast("10 minutes ago", 'your home thread "main"')], [triggerFiredNote(fired("show", 10), zone)])]]);
    at(11);
    expect(runtime.autonomy.wakeFor("ada", fired("encore", 11, "ring"))).toBe("handed");
    expect(runtime.autonomy.wakeFor("ada", fired("lamp", 11))).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", fired("beans", 11, "garden"))).toBe("queued");
    await say("is the lamp lit?");
    held.release.resolve();
    await waking;
    expect(where()).toEqual(["ring", "ring", "ring"]);
    expect(textOf(script.wakes[1] as SidecarRequest)).toEndWith(
      `${triggerFiredNote(fired("encore", 11), zone)}\n\n[User has just written to you, at Friday 2026-10-30 · 12:11 PM, while this wake is running. Another turn of you is answering them, and it knows this wake is running.]`,
    );
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(
      `[A wake of yours in "ring" has been running since Friday 2026-10-30 · 12:10 PM. It can't see this conversation. It is only told that a message arrived.]\nis the lamp lit?`,
    );
    expect((await thread("ring")).some((message) => message.content.includes("Shore stopped it"))).toBe(false);

    at(12);
    await runtime.autonomy.tick();
    expect(where().slice(3)).toEqual(["own-time", "own-time", "garden", "garden"]);
    expect(textOf(script.wakes[3] as SidecarRequest)).toContain(triggerFiredNote(fired("lamp", 11), zone));
    expect(textOf(script.wakes[3] as SidecarRequest)).not.toContain("beans");
    expect(setOffBy(turnsOf(script.wakes[5]).at(-1)?.[1])).toEqual([triggerFiredNote(fired("beans", 11), zone)]);

    script.wakes.length = 0;
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
    const pickUp = turnsOf(script.wakes[1]).at(-1)?.[1] ?? "";
    expect(turnsOf(script.wakes[1])).toHaveLength(1);
    expect(pickUp).toContain("[Your last wake here was stopped for User's message at Friday 2026-10-30 · 12:41 PM, after 1 round, before it had finished.");
    expect(setOffBy(pickUp)).toEqual([
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:41 PM:  is due]',
      triggerFiredNote(fired("encore", 41), zone),
      triggerFiredNote(fired("show", 45), zone),
    ]);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").at(-1)?.detail).toBe('Woken in "ring" by trigger "encore", "show" and a hand-off from "main"');
  });
});

test("what is waiting for a thread where a wake is running starts together once that wake is over, as one wake that opens with each reason and runs to the longest limit, a repeat counted once", async () => {
  await withCharacter(async ({ runtime, script, say }) => {
    const asked = (reason: string, minutes: number, limitMs: number) => ({ name: "", from: "main", reason, at: T0 + minutes * MINUTE, thread: "ring", limitMs });
    const show = (reason: string, minutes: number) => ({ name: "show", reason, at: T0 + minutes * MINUTE, thread: "ring" });
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.closing = "NO_NOTE";
    const held = hold();
    script.beatHeld = held;
    at(9);
    expect(runtime.autonomy.wakeFor("ada", show("the early show", 9))).toBe("queued");
    at(10);
    expect(runtime.autonomy.wakeFor("ada", show("the late show", 10))).toBe("queued");
    const waking = runtime.autonomy.tick();
    await held.started.promise;
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain('[Your trigger "show" fired at Friday 2026-10-30 · 12:10 PM: the late show]');
    expect(textOf(script.wakes[0] as SidecarRequest)).not.toContain("the early show");
    at(11);
    expect(runtime.autonomy.wakeFor("ada", asked("carry on with the first plan", 11, 45 * MINUTE))).toBe("queued");
    at(12);
    expect(runtime.autonomy.wakeFor("ada", asked("carry on with the second plan", 12, 90 * MINUTE))).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", asked("carry on with the second plan", 12, 90 * MINUTE))).toBe("queued");
    held.release.resolve();
    await waking;
    expect(script.wakes).toHaveLength(2);
    expect(script.wakes.map(textOf).join("\n")).not.toContain("You asked for this wake");

    at(13);
    await runtime.autonomy.tick();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring", "ring", "ring"]);
    const opener = turnsOf(script.wakes[2]).at(-1)?.[1] ?? "";
    expect(opener).toStartWith("[wake]\n\nNothing has been said in this thread since your last wake here.\n\n");
    expect(setOffBy(opener)).toEqual([
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:11 PM: carry on with the first plan]',
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:12 PM: carry on with the second plan]',
    ]);
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
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind !== "tool_use").map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["message_skipped", "Wake completed — no message sent"],
    ]);

    script.wakes.length = 0;
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 21 * MINUTE, thread: "ring" });
    at(21);
    await runtime.autonomy.tick();
    await queuedCompactionsEnded(data, "ada");
    expect(turnsOf(script.wakes[0])).toEqual([
      ["user", wakeShown("12:21 PM", [
        "Nothing has been said in this thread since your last wake here.",
        wroteLast("20 minutes ago"),
        diaryOfDay(['your note at the end of a wake in "ring"', "12:20 PM", "Told part one."]),
      ], ['[Your trigger "show" fired at Friday 2026-10-30 · 12:21 PM: r]'])],
    ]);
    expect(compactions(script)).toBe(1);
    expect((await thread("ring")).filter(isWakeOpener)).toHaveLength(1);

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

  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await runtime.registry.createThread("ada", "ring", { compaction: true });
    await say("tell me a story in parts", "ring");
    script.closing = "Told part one.";
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    await runtime.autonomy.tick();
    await queuedCompactionsEnded(data, "ada");
    expect(compactions(script), "by the size of the thread, which the wake itself was never sent").toBe(1);
    expect(await thread("ring")).toEqual([]);
  }, (app) => {
    long(app);
    app.memory.compaction.max_turns = 0;
    app.memory.compaction.max_context_tokens = 20;
  });
});

interface WakesIn {
  wake: (minute: number, closing: string) => Promise<void>;
  openers: () => Promise<string[]>;
  compactions: () => number;
}

async function wakesIn(name: string, compaction: boolean, configure: (app: AppConfig) => void, run: (h: Harness, wakes: WakesIn) => Promise<void>): Promise<void> {
  await withCharacter(async (h) => {
    await h.runtime.registry.createThread("ada", name, { compaction });
    await h.say("hello");
    await run(h, {
      wake: async (minute, closing) => {
        h.script.closing = closing;
        h.runtime.autonomy.wakeFor("ada", { name: "show", reason: `at ${String(minute)}`, at: T0 + minute * MINUTE, thread: name });
        at(minute);
        await h.runtime.autonomy.tick();
        await queuedCompactionsEnded(h.data, "ada");
      },
      openers: async () => (await h.thread(name)).filter(isWakeOpener).map((message) => /fired at [^:]+:\d\d [AP]M: at (\d+)\]/.exec(message.content)?.[1] ?? ""),
      compactions: () => h.script.calls.filter((call) => call === "compaction").length,
    });
  }, (app) => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.min_turns = 1;
    app.behavior.autonomy.triggers.max_idle_wakes = 10;
    configure(app);
  });
}

test("a thread holding nothing but the character's own wakes is put away without a model call once it would compact, down to the newest wake", async () => {
  await wakesIn("log", true, (app) => {
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.max_turns = 2;
  }, async ({ thread, script }, { wake, openers, compactions }) => {
    await wake(10, "One.");
    expect(await openers()).toEqual(["10"]);
    await wake(20, "Two.");
    expect(await openers()).toEqual(["20"]);
    expect((await thread("log")).map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    script.wakes.length = 0;
    await wake(30, "Three.");
    expect(await openers()).toEqual(["30"]);
    expect(compactions()).toBe(0);
    expect(setOffBy(turnsOf(script.wakes[0]).at(-1)?.[1])).toEqual(['[Your trigger "show" fired at Friday 2026-10-30 · 12:30 PM: at 30]']);
    expect(turnsOf(script.wakes[0]).at(-1)?.[1]).toContain(diaryOfDay(
      ['your note at the end of a wake in "log"', "12:10 PM", "One."],
      ['your note at the end of a wake in "log"', "12:20 PM", "Two."],
    ));
  });
});

test("what Shore keeps to undo a wake's file changes goes once that wake is no longer in its thread", async () => {
  await wakesIn("log", true, (app) => {
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.max_turns = 2;
    app.tools.enabled_tools = [...app.tools.enabled_tools, "bash"];
  }, async ({ runtime, script, thread }, { wake, openers }) => {
    const turns = workspaceTurnsFor(runtime.config.dirs, "ada", characterWorkspace(runtime.config, "ada"));
    const wrote = async (minute: number): Promise<string> => {
      script.beatTool = { name: "bash", input: { command: `printf 'page' > at-${String(minute)}.md` } };
      await wake(minute, "Wrote a page.");
      return replyVersions(await thread("log")).at(-1) ?? "";
    };
    const first = await wrote(10);
    const second = await wrote(20);
    expect(await openers()).toEqual(["20"]);
    expect(await recordedTurns(turns, "log", [first, second])).toEqual([first, second]);
    const third = await wrote(30);
    expect(await openers()).toEqual(["30"]);
    expect(await recordedTurns(turns, "log", [first, second, third])).toEqual([second, third]);
  });
});

test("wakes from before the user first wrote in a thread are put away the same way, and what was said from then on is left for a compaction", async () => {
  await wakesIn("log", true, (app) => {
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.max_turns = 4;
  }, async ({ thread, say }, { wake, openers, compactions }) => {
    await wake(10, "One.");
    await wake(12, "Two.");
    at(15);
    await say("how is it going?", "log");
    expect(await openers()).toEqual(["10", "12"]);
    await wake(30, "Three.");
    expect(await openers()).toEqual(["30"]);
    expect((await thread("log")).slice(0, 2).map((message) => message.content)).toEqual(["how is it going?", "reply to: how is it going?"]);
    expect(compactions()).toBe(0);
  });
});

test("in a thread whose compaction is off a wake's turns stay while there is room, and when it runs out the oldest turns are put away without a model call", async () => {
  await wakesIn("ring", false, (app) => {
    app.memory.compaction.keep_recent_turns = 1;
    app.memory.compaction.max_turns = 2;
  }, async ({ thread, say }, { wake, openers, compactions }) => {
    await wake(10, "One.");
    await wake(20, "Two.");
    await wake(30, "Three.");
    expect(await openers()).toEqual(["10", "20", "30"]);

    at(35);
    await say(`${"the lamp ".repeat(80_000)}\nwhich lamp?`, "ring");
    expect((await thread("ring")).map((message) => message.content.slice(-11))).toEqual(["which lamp?", "which lamp?"]);
    await wake(50, "Four.");
    expect(await openers()).toEqual(["50"]);
    expect((await thread("ring")).map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(compactions()).toBe(0);
  });
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

test("a wake in a side thread compacted down to nothing is shown the last of what was said there, with when", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring", { compaction: true });
    await say("tell me a story in parts", "ring");
    await compactByHand(runtime, "ring");
    expect(await thread("ring")).toEqual([]);

    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 300 * MINUTE, thread: "ring" });
    at(300);
    await runtime.autonomy.tick();
    expect(turnsOf(script.wakes.find((request) => request.context?.thread === "ring"))).toEqual([
      ["user", wakeShown("5:00 PM", [
        `The last of what was said in this thread:\n\n${said("User", "12:00 PM", "tell me a story in parts")}\n\n${said("you", "12:00 PM", "reply to: tell me a story in parts")}`,
        wroteLast("5 hours ago"),
      ], ['[Your trigger "show" fired at Friday 2026-10-30 · 5:00 PM: r]'])],
    ]);
  }, keepNothing);
});

test("a wake in a side thread reads that thread's files afresh, unless the user has just been writing there, and a wake in the home thread leaves its prompt as it was", async () => {
  await withCharacter(async ({ runtime, script, workspace, say }) => {
    const systemOf = (request: SidecarRequest | undefined): string => (request?.system ?? []).map((block) => block.text).join("\n");
    const wake = async (minute: number, thread: string): Promise<string> => {
      script.wakes.length = 0;
      runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minute * MINUTE, thread });
      at(minute);
      await runtime.autonomy.tick();
      return systemOf(script.wakes.find((request) => request.context?.thread === thread));
    };
    await mkdir(join(workspace, "notes"), { recursive: true });
    await writeFile(join(workspace, "notes", "ring.md"), "the fox is at the gate");
    await runtime.registry.createThread("ada", "ring", { files: ["notes/ring.md"] });
    await say("hello");
    script.closing = "NO_NOTE";

    expect(await wake(1, "ring")).toContain("the fox is at the gate");
    await writeFile(join(workspace, "notes", "ring.md"), "the fox is in the yard");
    expect(await wake(2, "ring"), "no one has written there, so nothing of its conversation is cached").toContain("the fox is in the yard");

    at(10);
    await say("how is the fox?", "ring");
    await writeFile(join(workspace, "notes", "ring.md"), "the fox is asleep");
    const warm = await wake(69.9, "ring");
    expect(warm).toContain("the fox is in the yard");
    expect(warm).not.toContain("asleep");
    expect(await wake(70, "ring"), "an hour after they last wrote there").toContain("the fox is asleep");

    await writeFile(join(workspace, "SOUL.md"), "Ada, older now");
    const home = await wake(300, "main");
    expect(home).toContain("Ada");
    expect(home).not.toContain("older now");
  }, (app) => {
    app.behavior.autonomy.triggers.max_idle_wakes = 10;
  });
});

test("the message a wake sends in a side thread is announced, and deleting it puts back the files that wake changed", async () => {
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

test("a wake in any thread opens with the diary of the last day and the user's status while one is set, and is made with the keys Shore was started with", async () => {
  await withCharacter(async ({ runtime, script, data, say, wakeNow }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.closing = "The log is read up to March.";
    at(5);
    await wakeNow();
    setPresence(data, "asleep", T0 + 6 * MINUTE);
    unsetTestEnv(KEY_ENV);
    script.wakes.length = 0;
    script.closing = "NO_NOTE";
    for (const minutes of [20, 40]) {
      runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minutes * MINUTE, thread: "ring" });
      at(minutes);
      await runtime.autonomy.tick();
    }
    const [first, , second] = script.wakes;
    const diary = diaryOfDay(['your note at the end of a wake in "own-time"', "12:05 PM", "The log is read up to March."]);
    expect(turnsOf(first)).toEqual([["user", wakeShown("12:20 PM", [
      "Nothing has been said in this thread yet.",
      wroteLast("20 minutes ago", 'your home thread "main"'),
      '[User\'s status, set 14 minutes ago: "asleep"]',
      diary,
    ], ['[Your trigger "show" fired at Friday 2026-10-30 · 12:20 PM: r]'])]]);
    expect(first?.api_key).toBe("fixture-key");
    expect(turnsOf(second)).toEqual([["user", wakeShown("12:40 PM", [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("40 minutes ago", 'your home thread "main"'),
      '[User\'s status, set 34 minutes ago: "asleep"]',
      diary,
    ], ['[Your trigger "show" fired at Friday 2026-10-30 · 12:40 PM: r]'])]]);
  });
});

test("a wake in the own-time thread is shown home, sends to home and is told so, word for word, and runs for the limit its trigger asks for", async () => {
  await withCharacter(async ({ runtime, script, workspace, say, thread }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), '[tide]\nevery = "10m"\nreason = "Look at the tide."\nlimit = "45m"\n\n[long]\nevery = "10m"\nreason = "Stay a while."\nlimit = "9h"\ncooldown = "50m"\n');
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    script.closing = "The tide is out.";
    await fires(runtime, 11);

    const tide = '[Your trigger "tide" fired at Friday 2026-10-30 · 12:11 PM: Look at the tide.]';
    const long = '[Your trigger "long" fired at Friday 2026-10-30 · 12:11 PM: Stay a while.]';
    expect(script.wakes.map((request) => [request.model, request.context?.call_type, request.context?.thread])).toEqual([
      ["claude-fixture", "heartbeat", "own-time"],
      ["claude-fixture", "heartbeat_tool_loop", "own-time"],
    ]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", ownWakeShown("12:11 PM", [
      `The last of what was said in your home thread "main":\n\n${said("User", "12:00 PM", "hello")}\n\n${said("you", "12:00 PM", "reply to: hello")}`,
      wroteLast("11 minutes ago", 'your home thread "main"'),
    ], [tide, long], "2 hours", "105 minutes")]]);
    expect(stored(await thread("own-time"))).toEqual([
      ["user", "autonomous", ownWakeShown("12:11 PM", [], [tide, long], "2 hours", "105 minutes")],
      ["assistant", "", ""],
      ["user", "", "<SOUL.md>"],
      ["assistant", "", "The tide is out."],
    ]);

    script.wakes.length = 0;
    await fires(runtime, 21);
    expect(turnsOf(script.wakes[0])).toEqual([["user", ownWakeShown("12:21 PM", [
      'Nothing has been said in your home thread "main" since your last wake here.',
      wroteLast("21 minutes ago", 'your home thread "main"'),
      diaryOfDay(['your note at the end of a wake in "own-time"', "12:11 PM", "The tide is out."]),
    ], ['[Your trigger "tide" fired at Friday 2026-10-30 · 12:21 PM: Look at the tide.]'], "45 minutes", "37 minutes")]]);
  }, (app) => {
    app.behavior.autonomy.triggers.wake_cooldown = ConfigDuration.fromSecs(60);
    app.behavior.autonomy.triggers.max_idle_wakes = 10;
  });
});

test("the model and settings the user chose for wakes hold in whichever thread a wake runs", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, command }) => {
    await runtime.registry.createThread("ada", "ring");
    expect((await command("set_model_setting", { key: "reasoning_effort", value: "low", background_task: "heartbeat" })).type).toBe("command_output");
    await say("hello");
    await wakeNow();
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0, thread: "ring" });
    await runtime.autonomy.tick();
    expect(script.wakes.map((request) => [request.context?.thread, request.model, request.provider_options?.reasoning_effort])).toEqual([
      ["own-time", "claude-pinned", "low"], ["own-time", "claude-pinned", "low"], ["ring", "claude-pinned", "low"], ["ring", "claude-pinned", "low"],
    ]);
    expect(script.replies.map((request) => request.model)).toEqual(["claude-fixture"]);
    const asked = script.wakes[0];
    expect((asked?.system ?? []).map((block) => block.text).join("\n")).toContain("Ada");
    expect((asked?.tools ?? []).map((tool) => tool.name)).toEqual(["read"]);
  }, (app) => {
    app.defaults.background.heartbeat = "pinned";
    app.behavior.autonomy.triggers.max_idle_wakes = 10;
  });
});

test("a model chosen for wakes that isn't in the catalog, or can't be called, leaves wakes on the chat model", async () => {
  await withCharacter(async ({ script, say, wakeNow }) => {
    await say("hello");
    await wakeNow();
    expect(script.wakes.map((request) => request.model)).toEqual(["claude-fixture", "claude-fixture"]);
  }, (app) => { app.defaults.background.heartbeat = "missing"; });

  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    const pinned = runtime.config.models.chat.get("chat.pinned");
    if (pinned === undefined) throw new Error("no pinned model");
    runtime.config.models.chat.set("chat.keyless", { ...pinned, name: "keyless", qualifiedName: "chat.keyless", apiKeyEnv: "SHORE_NO_SUCH_KEY" });
    await say("hello");
    await wakeNow();
    expect(script.wakes.map((request) => request.model)).toEqual(["claude-fixture", "claude-fixture"]);
    expect((await thread("main")).at(-1)?.content).toBe("I found the keeper's log.");
  }, (app) => { app.defaults.background.heartbeat = "keyless"; });
});

test("a model chosen for wakes is used even when its provider's list keeps it out of the pickers", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow }) => {
    await say("hello");
    runtime.registry.setRuntimeEffectiveConfig("ada", {
      ...runtime.registry.effectiveConfig("ada"),
      providers: ProviderRegistry.fromSection({ anthropic: { sdk: "anthropic", api_key_env: KEY_ENV, discovery: { enabled: true, ignore: ["claude-tucked-*"] } } }),
    });
    await wakeNow();
    expect(script.wakes.map((request) => request.model)).toEqual(["claude-tucked-away", "claude-tucked-away"]);
  }, (app) => { app.defaults.background.heartbeat = "anthropic:claude-tucked-away"; });
});

test("a wake set off by a trigger can hand on from whichever thread it runs in, and one that was itself handed over can't, even when a trigger joined it", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    script.closing = "NO_NOTE";
    const refused = { text: "io: a wake can't be handed on from here", failed: true };

    at(10);
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "Tell part one.", at: T0 + 10 * MINUTE, thread: "ring" });
    script.beatTool = { name: "wake_in_thread", input: { thread: "garden", reason: "Water the beans." } };
    await runtime.autonomy.tick();
    expect(lastToolResult(await thread("ring"))).toEqual({
      text: 'Shore will wake you in "garden" for up to 30 minutes, once this turn is over and peggy has been quiet there for 10 minutes.', failed: false,
    });

    at(11);
    script.beatTool = { name: "wake_in_thread", input: { thread: "ring", reason: "And back." } };
    await runtime.autonomy.tick();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring", "garden", "garden"]);
    expect(lastToolResult(await thread("garden"))).toEqual(refused);

    at(12);
    runtime.autonomy.wakeFor("ada", { name: "weeds", reason: "Pull the weeds.", at: T0 + 12 * MINUTE, thread: "garden" });
    runtime.autonomy.requestWake("ada", { name: "", from: "main", reason: "Tie up the beans.", at: T0 + 12 * MINUTE, thread: "garden" }, false);
    script.beatTool = { name: "wake_in_thread", input: { thread: "ring", reason: "And back." } };
    await runtime.autonomy.tick();
    expect(setOffBy(turnsOf(script.wakes.at(-2)).at(-1)?.[1])).toHaveLength(2);
    expect(lastToolResult(await thread("garden"))).toEqual(refused);
    at(13);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(6);
  }, handOff());
});

test("what Shore kept for a character's heartbeats before they went is taken up by its first wake in the own-time thread, and by no other thread's", async () => {
  await withCharacter(async ({ runtime, script, data, say }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("before the last heartbeat");
    at(6);
    await say("after it");
    writeCharacterState(join(data, "ada"), "heartbeat_home.json", JSON.stringify({ through: new Date(T0 + 5 * MINUTE).toISOString() }));
    script.closing = "NO_NOTE";

    at(10);
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 10 * MINUTE, thread: "ring" });
    await runtime.autonomy.tick();
    expect(textOf(script.wakes[0] as SidecarRequest)).toStartWith("[wake]\n\nNothing has been said in this thread yet.");
    expect(readCharacterState(join(data, "ada"), "heartbeat_home.json")).toBeDefined();

    at(11);
    runtime.autonomy.wakeFor("ada", { name: "tide", reason: "r", at: T0 + 11 * MINUTE });
    await runtime.autonomy.tick();
    const shown = textOf(script.wakes[2] as SidecarRequest);
    expect(shown).toStartWith(`[wake]\n\nWhat was said in your home thread "main" since your last wake here:\n\n${said("User", "12:06 PM", "after it")}`);
    expect(shown).not.toContain("before the last heartbeat");
    expect(readCharacterState(join(data, "ada"), "heartbeat_home.json")).toBeUndefined();
  }, (app) => { app.behavior.autonomy.triggers.max_idle_wakes = 10; });
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
    expect(script.wakes).toEqual([]);
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
    expect(script.wakes).toEqual([]);
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

test("a wake started by hand runs at the next look, one for a dormant character is dropped with word of how to change that, and making the character active again starts nothing by itself", async () => {
  await withCharacter(async ({ runtime, script, say, command }) => {
    const answered = async (name: string): Promise<unknown> => {
      const reply = await command(name, {});
      return reply.type === "command_output" ? reply.data : reply;
    };
    expect(await answered("session_activate")).toEqual({ character: "ada", registered: true, keepalive: { status: "off" }, own_time: "Active" });
    await say("hello");
    at(1);
    expect(await answered("heartbeat_tick_now")).toEqual({ status: "scheduled", character: "ada" });
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(2);

    expect(await answered("heartbeat_set_dormant")).toEqual({ status: "dormant", character: "ada" });
    expect(await answered("session_activate")).toEqual({ character: "ada", registered: false, keepalive: { status: "off" }, own_time: "Dormant" });
    expect(await answered("heartbeat_tick_now")).toEqual({
      status: "scheduled", character: "ada",
      warning: "ada is dormant, so nothing wakes them and this wake is dropped. Run `shore debug heartbeat_status_active` first.",
    });
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(2);

    expect(await answered("heartbeat_set_active")).toEqual({ status: "active", character: "ada" });
    expect(runtime.autonomy.status("ada")?.state).toBe("Active");
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(2);
  });
});

test("writing memory again from an archived segment changes the character's files for real, and leaves the conversation as it is", async () => {
  await withCharacter(async ({ script, workspace, data, say, thread, command }) => {
    await writeFile(join(workspace, "MEMORY.md"), "nothing yet\n");
    await say("hello");
    at(1);
    await say("the keeper is called Mara");
    expect(await command("compact", {})).toMatchObject({ type: "command_output", data: { status: "compacted", compacted_turns: 2 } });
    await queuedCompactionsEnded(data, "ada");
    at(2);
    await say("and the lamp?");
    const before = await thread("main");

    script.replyTool = { name: "edit", input: { file_path: "MEMORY.md", old_string: "nothing yet", new_string: "The keeper is Mara." } };
    expect(await command("compact", { segment: 0 })).toMatchObject({
      type: "command_output",
      data: { status: "segment", character: "ada", segment: 0, compacted_turns: 2, memory_files_written: ["MEMORY.md"], tool_rounds: 1, tools_called: ["edit"] },
    });
    expect(await Bun.file(join(workspace, "MEMORY.md")).text()).toBe("The keeper is Mara.\n");
    expect(await thread("main")).toEqual(before);
  }, (app) => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.keep_recent_turns = 0;
    app.memory.compaction.min_turns = 1;
    app.tools.enabled_tools = [...app.tools.enabled_tools, "edit"];
  });
});

test("a wake for a character left with no chat model at all is skipped, and the log says so", async () => {
  await withCharacter(async ({ runtime, script, say, thread, wakeNow }) => {
    await say("hello");
    runtime.config.models.chat.clear();
    at(20);
    await wakeNow();
    expect(script.wakes).toEqual([]);
    expect(await thread("own-time")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", "Woken by a start by hand"],
      ["call_failed", "Wake skipped: no chat model resolves"],
    ]);
  });
});

test("each round of a wake is kept for the trace of what wakes thought and did", async () => {
  await withCharacter(async ({ runtime, say, wakeNow }) => {
    await say("hello");
    at(1);
    await wakeNow();
    const kept = runtime.callStore?.queryTranscripts("heartbeat", "ada", 100).map((row) => [row.call_type, row.iteration, row.finish_reason]);
    expect(kept?.reverse()).toEqual([
      ["heartbeat", 0, "tool_use"],
      ["heartbeat_tool_loop", 1, "end_turn"],
    ]);
  });
});

test("the log shows each tool a wake called with the start of what came back", async () => {
  await withCharacter(async ({ runtime, script, workspace, say, wakeNow }) => {
    await writeFile(join(workspace, "tides.md"), "high water ".repeat(40));
    await say("hello");
    script.beatTool = { name: "read", input: { file_path: "tides.md" } };
    at(1);
    await wakeNow();
    const called = runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tool_use").map((event) => event.detail);
    expect(called).toHaveLength(1);
    expect(called[0]).toMatch(/^Tool: read → .*…$/);
    expect(called[0]).toContain(workspace.slice(0, 40));
    expect(Buffer.byteLength(called[0] ?? "")).toBe(Buffer.byteLength("Tool: read → …") + 80);
  });
});

test("a wake whose tool call breaks off leaves its thread with an answer to that call, and the log says what went wrong", async () => {
  await withCharacter(async ({ runtime, script, say, thread, wakeNow }) => {
    await say("hello");
    const broken = spyOn(execute, "runToolUse").mockRejectedValueOnce(new Error("the tool runner broke"));
    try {
      at(1);
      await wakeNow();
    } finally {
      broken.mockRestore();
    }
    expect(script.wakes).toHaveLength(1);
    expect((await thread("own-time")).map((message) => [message.role, message.content_blocks.map((block) => block.type === "tool_result" ? [block.type, block.is_error, block.content] : block.type)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["tool_use"]],
      ["user", [["tool_result", true, "Tool execution was interrupted by a Shore daemon restart before it returned a result."]]],
    ]);
    expect((await thread("main")).filter((message) => message.origin === "autonomous")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", "Woken by a start by hand"],
      ["call_failed", "Model call failed on round 0 — the tool runner broke"],
    ]);
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

function giftWake(now: string, lines: readonly string[], shown: readonly string[] = []): string {
  return wakeShown(now, shown, lines).replace('your thread "ring"', 'your thread "gift"');
}

async function sealsGift(h: Pick<Harness, "script" | "say" | "wakeNow">): Promise<void> {
  await h.say("hello");
  h.script.beatTool = { name: "start_sealed_thread", input: { name: " gift ", label: " Something for you ", opens: "2026-10-31 08:00" } };
  h.script.closing = "NO_NOTE";
  at(10);
  await h.wakeNow();
}

test("a sealed thread is kept out of the user's thread list and the character's other turns, which are shown only its label and when it opens", async () => {
  await withCharacter(async (h) => {
    const { runtime, script, data, say, wakeNow, thread, command } = h;
    await sealsGift(h);
    const filesDir = join(data, "ada", "sealed", "gift");
    expect(lastToolResult(await thread("own-time"))).toEqual({
      text: `Sealed the thread "gift" (Something for you) until Saturday 2026-10-31 · 8:00 AM. peggy can't see it until then, and your other turns are shown only its label and that time. ` +
        `\`wake_in_thread\` takes you into it. Keep what you make for it in ${filesDir}, which is outside your workspace.`,
      failed: false,
    });
    expect(existsSync(filesDir)).toBe(true);
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "own-time"]);
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
    await wakeNow();
    expect(textOf(script.wakes.at(-2) as SidecarRequest)).toContain(`\n\n${SEALED_LIST}\n\n`);

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

test("a wake inside a sealed thread sends, announces and logs nothing outside it, and its diary entries stay sealed with it, but for the note its next wake there starts with", async () => {
  await withCharacter(async (h) => {
    const { runtime, script, data, emitted, say, wakeNow, thread } = h;
    await sealsGift(h);
    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    script.beatTool = { name: "wake_in_thread", input: { thread: "gift", reason: "Start on it." } };
    at(20);
    await wakeNow();
    expect(lastToolResult(await thread("own-time"))?.failed).toBe(false);
    const captured = runtime.callStore?.callCount();
    const transcripts = runtime.callStore?.queryTranscripts("heartbeat", "ada", 100).length;
    script.wakes.length = 0;
    emitted.length = 0;
    script.closing = "Made a card.\n<sendMessage>Happy birthday!</sendMessage>";
    at(21);
    await runtime.autonomy.tick();

    expect(turnsOf(script.wakes[0])).toEqual([["user", giftWake("12:21 PM", [
      '[You asked for this wake from "own-time" at Friday 2026-10-30 · 12:20 PM: Start on it.]',
      `[This thread is sealed until Saturday 2026-10-31 · 8:00 AM. User can't see it, or anything you do or send here, until then, and your other threads are shown only its label, "Something for you". ` +
        `What you send here waits in the thread for them. Keep what you make for it in ${join(data, "ada", "sealed", "gift")}, which is outside your workspace.]`,
    ], ["Nothing has been said in this thread yet.", wroteLast("21 minutes ago", 'your home thread "main"')])]]);
    expect(script.wakes.map((request) => [request.context?.thread, request.context?.sealed])).toEqual([["gift", true], ["gift", true]]);
    expect(emitted).toEqual([]);
    expect(announced).toEqual([]);
    expect([runtime.callStore?.callCount(), runtime.callStore?.queryTranscripts("heartbeat", "ada", 100).length]).toEqual([captured, transcripts]);
    expect(diaryOf(data)).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "gift" by a hand-off from "own-time"'],
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
    script.closing = "NO_NOTE";
    at(30);
    await wakeNow();
    expect(textOf(script.wakes.at(-2) as SidecarRequest)).not.toContain("Made a card.");

    script.wakes.length = 0;
    expect(runtime.autonomy.requestWake("ada", { name: "", from: "main", reason: "Wrap it.", at: T0 + 31 * MINUTE, thread: "gift" }, false).kind).toBe("queued");
    at(31);
    await runtime.autonomy.tick();
    const again = turnsOf(script.wakes[0]).at(-1)?.[1] ?? "";
    expect(again).toContain('in your home thread "main".]\n\n[Your note from the end of your last wake here, Friday 2026-10-30 · 12:21 PM, kept for this one:]\n\nMade a card.\n\n[You asked for this wake from "main" at ');
    expect(again).not.toContain("[Your diary");

    runtime.autonomy.forceDormancy("ada", "dormant");
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
    const { runtime, script, data, wakeNow } = h;
    root = dirname(data);
    await sealsGift(h);
    script.beatTool = { name: "wake_in_thread", input: { thread: "gift", reason: "Start on it." } };
    at(20);
    await wakeNow();
    script.closing = "Made a card.\n<sendMessage>Happy birthday!</sendMessage>";
    at(21);
    await runtime.autonomy.tick();
  }, sealing);

  await withCharacter(async ({ runtime, script, data, emitted, say, thread, shown }) => {
    at(19 * 60 + 59);
    await say("good morning");
    expect(runtime.autonomy.forceDormancy("ada", "dormant")).toBe(true);
    await runtime.autonomy.tick();
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift"]);
    expect(script.wakes).toEqual([]);

    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    script.closing = "Gave it.\n<sendMessage>Open the card.</sendMessage>";
    emitted.length = 0;
    at(20 * 60);
    await runtime.autonomy.tick();
    expect(runtime.registry.sealedThreads("ada")).toEqual([]);
    expect(runtime.registry.listThreads("ada").at(-1)).toEqual({ id: "gift", label: "Something for you", created_at: "2026-10-30T12:10:00.000Z", created_by: "character", compaction: true });
    expect(script.wakes.map((request) => [request.context?.thread, request.context?.sealed])).toEqual([["gift", undefined], ["gift", undefined]]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", giftWake("8:00 AM", [
      "[The seal on this thread came off at Saturday 2026-10-31 · 8:00 AM. User can see this thread and everything in it from now on. This wake is for giving them what you made.]",
    ], [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("a minute ago", 'your home thread "main"'),
      [
        "[Your diary from the last day. Each entry says where it came from.]",
        'your note at the end of a wake in "gift" · Friday 2026-10-30 · 12:21 PM\nMade a card.',
        'from Shore · Saturday 2026-10-31 · 8:00 AM\nThe seal on "Something for you" came off. Its thread, `gift`, is in User\'s thread list from now on, and you are being woken there.',
        "[End of your diary.]",
      ].join("\n\n"),
    ]).replace("[Current time: Friday 2026-10-30 · 8:00 AM]", "[Current time: Saturday 2026-10-31 · 8:00 AM]")]]);
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
    expect(String(lastToolResult(await thread("main"))?.text)).toContain("ada    [gift] (wake) Happy [birthday]!");
    at(20 * 60 + 1);
    await runtime.autonomy.tick();
    expect(script.wakes).toHaveLength(2);
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
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "own-time", "gift"]);
    expect(script.wakes).toEqual([]);
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
  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    root = dirname(data);
    await say("hello");
    at(2 * day);
    script.replyTool = { name: "read", input: { file_path: "SOUL.md" } };
    await say("two days on");
    expect(counted(runtime)).toBe(2);
    runtime.autonomy.wakeFor("ada", { name: "lamp", reason: "r", at: T0 + (2 * day + 20) * MINUTE, thread: "main" });
    at(2 * day + 20);
    await runtime.autonomy.tick();
    expect((await thread("main")).filter((message) => message.role === "user").map((message) => message.origin === "autonomous" ? "wake" : message.content_blocks[0]?.type)).toEqual([
      "text", "text", "tool_result", "wake", "tool_result",
    ]);
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

test("the activity heatmap tells the character how many messages the user has sent, the figure the status shows", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await say("hello");
    at(1);
    await say("the beans are up");
    script.replyTool = { name: "activity_heatmap", input: { days: 7 } };
    at(2);
    await say("how often do we talk?");
    expect(runtime.autonomy.activityStats("ada", T0)?.messageCount).toBe(3);
    expect(String(lastToolResult(await thread("main"))?.text).split("\n")[0]).toBe("Activity over 7 days: 3 messages (3 total)");
  }, (app) => {
    app.tools.enabled_tools = [...app.tools.enabled_tools, "activity_heatmap"];
  });
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
