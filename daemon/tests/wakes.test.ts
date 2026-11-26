import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { registrationFor, TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { rebuildRequestFromDisk } from "../src/cache/rebuild.ts";
import { type AppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { History } from "../src/engine/conversation.ts";
import { encodeEvent } from "../src/autonomy/wake_log.ts";
import { triggerFiredNote, userWroteNote, wakeNewsNote } from "../src/autonomy/wake_shape.ts";
import { changePresence, lastSeen, noteSeen, presence, presenceState } from "../src/autonomy/presence.ts";
import { checkFacts, startTriggerTimer, type TriggerService } from "../src/autonomy/trigger_service.ts";
import { wakeRunningText } from "../src/engine/prompt.ts";
import { isWakeOpener, markThreadRead, threadActivityNow } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps, buildRunGeneration } from "../src/handler/deps.ts";
import { ThreadUnreadTracker } from "../src/handler/thread_unread.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { stopBackgroundCompactions } from "../src/memory/compaction/background.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { archiveKey } from "../src/config/dirs.ts";
import { runCompactionPass } from "../src/memory/compaction/run.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { ThreadListing } from "../src/protocol/ThreadListing.ts";
import { shoreLog } from "../src/log.ts";
import { hostZone } from "../src/ledger/zoned.ts";
import { createRuntime, startRuntimeClocks, type ShoreRuntime } from "../src/runtime.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { insertEvent, withStorage } from "../src/storage/store.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import * as execute from "../src/tools/execute.ts";
import { recordedTurns, replyVersions, workspaceTurnsFor } from "../src/tools/workspace_turns.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/handshake.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { sizedImage } from "./support/sized_image.ts";
import { eventsForResponse } from "./support/stream.ts";
import { restoreTestEnv, setTestEnv, unsetTestEnv } from "./support/env.ts";
import { NO_MCP } from "./support/rebuild.ts";
import { outcomeOf, rejectionOf } from "./support/outcome.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";
import { Texts } from "../src/texts/texts.ts";
import { parameterText, TEXT_SPECS, TEXTS, toolText, type TextSpec } from "../src/texts/registry.ts";
import { ALL_TOOLS } from "../src/tools/registry.ts";

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
  sends?: string | undefined;
  finishes?: (string | undefined)[];
  aside?: string | undefined;
  again?: number;
  beatHeld?: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  endHeld?: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  beatTool?: { name: string; input: Record<string, unknown> } | undefined;
  replyTool?: { name: string; input: Record<string, unknown> } | undefined;
  fails?: Error | undefined;
}

function scriptedProvider(script: Script): SidecarProvider {
  const respond = (request: SidecarRequest, blocks: GenerateResponse["content_blocks"], finish?: string): GenerateResponse => ({
    model: request.model,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    content_blocks: blocks,
    finish_reason: finish ?? (blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn"),
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
      if (request.context?.call_type.startsWith("wake") !== true) {
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
      const fails = script.fails;
      script.fails = undefined;
      if (fails !== undefined) throw fails;
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
      const sending: GenerateResponse["content_blocks"] = script.sends === undefined ? [] : [{ type: "tool_use", id: `send-${String(script.wakes.length)}`, name: "send_message", input: { text: script.sends } }];
      const beatTool = resultsIn ? undefined : script.beatTool;
      if (beatTool !== undefined) {
        script.beatTool = undefined;
        yield* eventsForResponse(respond(request, [...sending, { type: "tool_use", id: `tool-${String(script.wakes.length)}`, name: beatTool.name, input: beatTool.input }]));
        return;
      }
      yield* eventsForResponse(respond(request, resultsIn
        ? [
            { type: "thinking", thinking: "She asked about the lamp, so I'll tell her.", signature: "sig-1" },
            { type: "text", text: script.closing },
          ]
        : [
            ...(script.aside === undefined ? [] : [{ type: "text" as const, text: script.aside }]),
            ...sending,
            { type: "tool_use", id: `read-${String(script.wakes.length)}`, name: "read", input: { file_path: "SOUL.md" } },
          ], resultsIn ? script.finishes?.shift() : undefined));
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
  fromReplies: ServerMessage[];
  command: (name: string, args: Record<string, unknown>, thread?: string) => Promise<ServerMessage>;
}

async function withCharacter(run: (h: Harness) => Promise<void>, configure?: (app: AppConfig) => void, kept?: string): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  if (kept === undefined) at(0);
  const root = kept ?? await mkdtemp(testTmp("shore-wakes-"));
  const app = promptedAppConfig();
  app.chat.model = "fixture";
  app.chat.max_retries = 0;
  app.compaction.enabled = false;
  app.tools.enabled = ["read", "send_message"];
  app.triggers.enabled = true;
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
  const script: Script = { wakes: [], replies: [], calls: [], held: undefined, closing: "Done.", sends: "I found the keeper's log." };
  const emitted: Emitted[] = [];
  const histories: History[] = [];
  const events: ServerMessage[] = [];
  const fromReplies: ServerMessage[] = [];
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
    const reply = buildRunGeneration({
      runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: (event) => { fromReplies.push(event); },
    });
    await run({
      runtime,
      script,
      data: config.dirs.data,
      workspace,
      emitted,
      heard: (thread) => histories.some((history) => history.selected_thread === thread),
      events,
      fromReplies,
      shown: async (thread, match) => {
        if (histories.some((history) => history.selected_thread === thread && history.messages.some(match))) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        waiting.push({ thread, match, resolve });
        await promise;
      },
      say: async (text, thread = "main") => {
        const end = runtime.autonomy.beginForeground("ada");
        try {
          await reply({
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
        await reply({
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
        await runtime.autonomy.runDue();
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

test("a wake started by hand while a reply in home is still generating waits for that reply, then runs in home and posts there", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    await say("hello");
    const held = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    script.held = held;
    at(1);
    const replying = say("is the lamp lit?");
    await held.started.promise;

    at(2);
    const ticking = wakeNow();
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    expect(script.wakes).toHaveLength(0);

    at(3);
    held.release.resolve();
    await replying;
    await ticking;

    expect(script.wakes).toHaveLength(2);
    const home = await thread("main");
    expect(home.slice(0, 4).map((message) => [message.role, message.origin ?? "", message.content])).toEqual([
      ["user", "", "hello"],
      ["assistant", "", "reply to: hello"],
      ["user", "", "is the lamp lit?"],
      ["assistant", "", "reply to: is the lamp lit?"],
    ]);
    expect(home.slice(4).map((message) => [message.role, message.origin ?? ""])).toEqual([
      ["user", "autonomous"],
      ["system", "autonomous"],
      ["assistant", "autonomous"],
    ]);
    expect((await thread("main")).at(-1)?.content_blocks).toEqual([{ type: "text", text: "I found the keeper's log." }]);
    expect(runtime.registry.listThreads("ada").map((record) => [record.id, record.label, record.compaction])).toEqual([["main", undefined, true], ["wakes", "Wakes", false]]);
  });
});

test("a wake in home leaves there how it opened, a line saying where its working went and what it sent, its working goes to the wakes thread for the user to read, and the next one starts fresh with only what was said there since", async () => {
  await withCharacter(async ({ script, say, wakeNow, thread, events }) => {
    await say("the keeper's name is Mara");
    at(10);
    await wakeNow();
    const wakesListed = () => events.filter((event) => event.type === "threads_changed" && event.thread === "wakes");
    expect(wakesListed(), "the clients are told of the wakes thread the first wake made").toEqual([{ type: "threads_changed", character: "ada", thread: "wakes" }]);

    const started = byHand("12:10 PM");
    const kept = (await thread("main")).slice(2);
    expect(stored(kept)).toEqual([
      ["user", "autonomous", `[wake]\n\n${started}`],
      ["system", "autonomous", 'This wake\'s working is in "Wakes": 2 tool calls.'],
      ["assistant", "autonomous", "I found the keeper's log."],
    ]);
    expect(kept.map((message) => message.shown_later)).toEqual([
      undefined,
      '[Your working in this wake is in your thread "wakes", not here: 2 tool calls.]',
      undefined,
    ]);
    const working = await thread("wakes");
    expect(working.map((message) => [message.role, message.origin ?? ""])).toEqual([
      ["user", "autonomous"],
      ["assistant", ""],
      ["user", ""],
      ["assistant", ""],
    ]);
    expect(working[0]?.content).toStartWith(`[wake in "main"]\n\n${started}\n\n[Current time: Friday 2026-10-30 · 12:10 PM]\n\n[This is a wake in your thread "main", not a message from `);
    expect(working[0]?.content).not.toContain("the keeper's name is Mara");
    expect(working[3]?.content_blocks).toEqual([
      { type: "thinking", thinking: "She asked about the lamp, so I'll tell her.", signature: "sig-1" },
      { type: "text", text: "Done." },
    ]);
    expect(working[1]?.content_blocks.flatMap((block) => block.type === "tool_use" ? [[block.name, block.input]] : [])).toEqual([
      ["send_message", { text: "I found the keeper's log." }],
      ["read", { file_path: "SOUL.md" }],
    ]);
    expect(working[2]?.content_blocks.flatMap((block) => block.type === "tool_result" ? [block.content] : []).at(0)).toBe("It will be posted in this thread when this wake ends.");
    const first = script.wakes[0] as SidecarRequest;
    expect(first.messages).toHaveLength(1);
    expect(textOf(first)).toStartWith("[wake]\n\nThe last of what was said in this thread:\n\n");
    expect(textOf(first)).toContain("the keeper's name is Mara");

    at(20);
    await say("she keeps a cat too");
    at(30);
    await wakeNow();

    const next = script.wakes.at(-2) as SidecarRequest;
    expect(next.messages).toHaveLength(1);
    expect(textOf(next)).toStartWith("[wake]\n\nWhat was said in this thread since your last wake here:\n\n");
    expect(textOf(next)).toContain("she keeps a cat too");
    expect(textOf(next)).toContain("reply to: she keeps a cat too");
    expect(textOf(next)).not.toContain("the keeper's name is Mara");
    expect(textOf(next)).not.toContain("She asked about the lamp");
    expect(textOf(next)).not.toContain("Done.");
    expect(next.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_use" || block.type === "tool_result")).toEqual([]);
    expect((await thread("main")).filter((message) => message.role === "user" && message.origin === "autonomous")).toHaveLength(2);
    expect(wakesListed(), "the next wake finds it there").toHaveLength(1);
  });
});

test("what Shore puts with each message for the model is saved on it and reaches clients: a reply's notes on what it was sent, and a wake's whole opening on the opener kept with its working", async () => {
  await withCharacter(async ({ script, say, wakeNow, thread, shown }) => {
    await say("the keeper's name is Mara");
    const noon = "[Friday 2026-10-30 · 12:00 PM]";
    expect(turnsOf(script.replies[0])).toEqual([["user", `${noon}\n\nthe keeper's name is Mara`]]);
    expect((await thread("main")).map((message) => message.notes)).toEqual([[{ place: "start", text: noon }], undefined]);
    await shown("main", (message) => message.notes !== undefined);

    at(10);
    await wakeNow();
    const opened = required((await thread("wakes"))[0]);
    const [[, read] = ["", ""]] = turnsOf(script.wakes[0]);
    const woke = "[Friday 2026-10-30 · 12:10 PM]";
    expect(read).toStartWith(`${woke}\n\n[wake]\n\nThe last of what was said in this thread:`);
    expect(read).toContain("the keeper's name is Mara");
    expect(opened.content).not.toContain("the keeper's name is Mara");
    expect(opened.notes).toEqual([{ place: "start", text: woke }, { place: "instead", text: read.slice(woke.length + 2) }]);
    await shown("wakes", (message) => message.notes !== undefined);

    at(20);
    await say("she keeps a cat too");
    expect((await thread("main")).map((message) => message.notes)).toEqual([
      [{ place: "start", text: noon }],
      undefined,
      [{ place: "start", text: woke }],
      [{ place: "instead", text: '[Your working in this wake is in your thread "wakes", not here: 2 tool calls.]' }],
      [{ place: "before", text: "[wake · Friday 2026-10-30 · 12:10 PM]" }],
      [{ place: "start", text: "[Friday 2026-10-30 · 12:20 PM]" }],
      undefined,
    ]);
  }, (app) => { app.chat.user_timestamps = "always"; });
});

test("a wake's chat logs hold what is still in its own thread's conversation, since a wake isn't shown it, while a reply there searches only the other threads", async () => {
  await withCharacter(async ({ script, say, wakeNow, thread }) => {
    await say("the keeper's name is Mara");
    script.replyTool = { name: "chat_logs", input: { action: "search", query: "Mara" } };
    at(1);
    await say("what did I call the keeper?");
    expect(lastToolResult(await thread("main"))?.text).toStartWith("Mara: 0 matches.\nThere is nothing to search yet; this thread's messages in your context aren't searched.");

    script.beatTool = { name: "chat_logs", input: { action: "search", query: "Mara" } };
    at(20);
    await wakeNow();
    expect(lastToolResult(await thread("main"))?.text).toStartWith("Mara: 0 matches.");
    const found = lastToolResult(await thread("wakes"));
    expect(found?.failed).toBe(false);
    expect(found?.text).toContain("the keeper's name is [Mara]");
  }, (app) => { app.tools.enabled.push("chat_logs"); });
});

test("a reply finds what a wake wrote while working only when its search names the wakes thread, where that working is kept", async () => {
  await withCharacter(async ({ script, say, wakeNow, thread }) => {
    await say("hello");
    script.closing = "The cellar key is under the heron stone.";
    at(20);
    await wakeNow();
    script.replyTool = { name: "chat_logs", input: { action: "search", query: "heron" } };
    at(40);
    await say("where did you leave the cellar key?");
    const unasked = lastToolResult(await thread("main"));
    expect([unasked?.failed, String(unasked?.text).split("\n")[0]]).toEqual([false, "heron: 0 matches."]);
    script.replyTool = { name: "chat_logs", input: { action: "search", query: "heron", thread: "wakes" } };
    at(41);
    await say("and while you were working?");
    const found = lastToolResult(await thread("main"));
    expect(found?.failed).toBe(false);
    expect(found?.text).toContain("under the [heron] stone");
  }, (app) => { app.tools.enabled.push("chat_logs"); });
});

test("a call under a tool's old name is answered with the tool it became, stays in the thread as it was made, and the conversation goes on with it", async () => {
  await withCharacter(async ({ script, say, thread }) => {
    await say("hello");
    script.replyTool = { name: "search_chat_logs", input: { query: "Mara" } };
    at(1);
    await say("what did I call the keeper?");
    expect(lastToolResult(await thread("main"))).toEqual({
      text: "The call to search_chat_logs was not run because it is part of the `chat_logs` tool now, which takes an `action`. Nothing was executed and no state changed. Issue the call again with complete, well-formed arguments.",
      failed: true,
    });

    at(2);
    await say("and now?");
    const sent = script.replies.at(-1) as SidecarRequest;
    expect(sent.messages.flatMap((message) => message.content).flatMap((block) => block.type === "tool_use" ? [block.name] : [])).toEqual(["search_chat_logs"]);
    expect(sent.tools?.map((tool) => tool.name)).toEqual(["read", "chat_logs", "send_message"]);
    expect((await thread("main")).at(-1)?.content).toBe("reply to: and now?");
  }, (app) => { app.tools.enabled.push("chat_logs"); });
});

test("a wake sends as many messages as it calls for, each in the thread it names, and one for another thread lands there unread once the wake is over", async () => {
  await withCharacter(async ({ runtime, script, data, emitted, say, wakeNow, thread }) => {
    await runtime.registry.createThread("ada", "garden");
    markThreadRead(data, "ada", "garden", 0);
    await say("hello");
    script.sends = "The lamp is lit.";
    script.beatTool = { name: "send_message", input: { text: "The beans are up.", thread: "garden" } };
    script.closing = "Lit the lamp, looked at the beans.";
    emitted.length = 0;
    at(10);
    await wakeNow();

    expect((await thread("wakes")).flatMap((message) => message.content_blocks).flatMap((block) => block.type === "tool_result" ? [[block.content, block.is_error]] : [])).toEqual([
      ["It will be posted in this thread when this wake ends.", false],
      ['It will be posted in "garden" when this wake ends.', false],
    ]);
    expect(stored((await thread("main")).slice(3))).toEqual([
      ["system", "autonomous", 'This wake\'s working is in "Wakes": 2 tool calls.'],
      ["assistant", "autonomous", "The lamp is lit."],
    ]);
    expect(stored(await thread("garden"))).toEqual([["assistant", "autonomous", "The beans are up."]]);
    expect(emitted.map((each) => [each.thread, each.msg.content])).toEqual([["main", "The lamp is lit."], ["garden", "The beans are up."]]);
    expect(threadActivityNow(data, "ada", "garden")).toMatchObject({ unread: 1 });
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "message_sent").map((event) => event.detail)).toEqual([
      "Autonomous message sent: The lamp is lit.",
      "Autonomous message sent: The beans are up.",
    ]);

    at(12);
    await say("oh, are they?", "garden");
    expect(turnsOf(script.replies.at(-1))).toEqual([
      ["user", "[wake · Friday 2026-10-30 · 12:10 PM]"],
      ["assistant", "The beans are up."],
      ["user", "oh, are they?"],
    ]);
  });
});

test("a wake's message for a thread that is archived before the wake ends isn't sent, and the log says so", async () => {
  await withCharacter(async ({ runtime, script, say, command }) => {
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    script.sends = undefined; script.closing = "Done.";
    script.beatTool = { name: "send_message", input: { text: "The beans are up.", thread: "garden" } };
    const end = hold();
    script.endHeld = end;
    at(10);
    const waking = runtime.autonomy.wakeNow("ada") === undefined ? Promise.resolve() : runtime.autonomy.runDue();
    await end.started.promise;
    expect(await command("archive_thread", { name: "garden" })).toMatchObject({ type: "command_output" });
    end.release.resolve();
    await waking;

    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "wakes"]);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "call_failed").map((event) => event.detail)).toEqual([
      'A message for the thread "garden" was not sent: that thread was gone by the time the wake in "main" ended',
    ]);
    expect(runtime.autonomy.log("ada", 100).map((event) => event.kind)).not.toContain("message_sent");
  });
});

test("a wake whose trigger names no thread runs on home's model, and its ending never compacts home, however many wakes home holds or however long its message makes home", async () => {
  await withCharacter(async ({ runtime, data, script, say, wakeNow, thread, command }) => {
    await runtime.registry.setThreadModel("ada", "main", "pinned");
    await say("hello");
    at(10);
    await wakeNow();
    at(20);
    await wakeNow();

    expect(script.wakes.map((request) => [request.model, request.context?.thread])).toEqual([["claude-pinned", "main"], ["claude-pinned", "main"], ["claude-pinned", "main"], ["claude-pinned", "main"]]);
    expect(archivedIn(data)).toBe(0);
    expect((await thread("main")).filter((message) => message.role === "user" && message.origin === "autonomous")).toHaveLength(2);
    expect(await command("compact", { keep_turns: 99 })).toMatchObject({ type: "error", code: "invalid_request", message: "insufficient messages" });
  }, (app) => {
    app.compaction.enabled = true;
    app.compaction.keep_recent_turns = 0;
    app.compaction.min_turns = 1;
    app.compaction.max_turns = 2;
  });

  await withCharacter(async ({ script, data, say, wakeNow, thread }) => {
    await say("hello");
    script.sends = "The keeper's log runs on. ".repeat(400).trim(); script.closing = "Done.";
    at(10);
    await wakeNow();
    await stopBackgroundCompactions(data);

    expect(archivedIn(data)).toBe(0);
    const home = await thread("main");
    expect(home).toHaveLength(5);
    expect(home.slice(0, 2).map((message) => message.content)).toEqual(["hello", "reply to: hello"]);
    expect(home[2]?.content).toStartWith("[wake]");
    expect(home.at(-1)?.content).toStartWith("The keeper's log runs on.");
    expect(home.at(-1)?.content.length).toBeGreaterThan(10_000);
  }, (app) => {
    app.compaction.enabled = true;
    app.compaction.keep_recent_turns = 0;
    app.compaction.min_turns = 1;
    app.compaction.max_turns = 0;
    app.compaction.max_context_tokens = 200;
  });
});

test("wakes keep the reasoning effort set for them on chat's model, and setting it for them never moves chat's", async () => {
  await withCharacter(async ({ script, say, wakeNow, command }) => {
    const effort = async (args: Record<string, unknown>): Promise<void> => {
      expect((await command("set_model_setting", { key: "reasoning_effort", ...args })).type).toBe("command_output");
    };
    const effortOf = (requests: SidecarRequest[]): (string | undefined)[] =>
      [...new Set(requests.map((request) => request.provider_options?.reasoning_effort))];

    await effort({ value: "high" });
    await effort({ value: "low", background_task: "wake" });
    await say("hello");
    await wakeNow();

    expect(effortOf(script.replies)).toEqual(["high"]);
    expect(script.wakes.map((request) => request.model)).toContain("claude-fixture");
    expect(effortOf(script.wakes)).toEqual(["low"]);

    await effort({ value: "max", background_task: "all" });
    script.wakes.length = 0;
    at(10);
    await wakeNow();
    await say("again");

    expect(effortOf(script.wakes)).toEqual(["max"]);
    expect(effortOf(script.replies)).toEqual(["high"]);

    await effort({ value: null, background_task: "wake" });
    script.wakes.length = 0;
    at(20);
    await wakeNow();

    expect(effortOf(script.wakes)).toEqual(["high"]);
  }, (app) => {
    app.compaction.enabled = true;
    app.compaction.keep_recent_turns = 0;
    app.compaction.min_turns = 1;
  });
});

test("a wake's own turn in home notifies nobody and isn't counted as unread there, while the message it sends is", async () => {
  await withCharacter(async ({ data, emitted, say, wakeNow, thread }) => {
    await say("hello");
    at(5);
    await wakeNow();
    markThreadRead(data, "ada", "main", T0 + 6 * MINUTE);

    at(10);
    await wakeNow();
    expect((await thread("main")).filter((message) => message.content.includes("I found the keeper's log.")).map((message) => message.origin)).toEqual(["autonomous", "autonomous"]);
    expect(emitted.map((event) => [event.thread, event.msg.role, event.msg.content])).toEqual([
      ["main", "assistant", "I found the keeper's log."],
      ["main", "assistant", "I found the keeper's log."],
    ]);
    expect(threadActivityNow(data, "ada", "main").unread).toBe(1);
  });
});

test("a picture in the opening of a thread the character starts is on that message, and one that can't be found starts no thread and is named", async () => {
  await withCharacter(async ({ runtime, script, workspace, say, thread }) => {
    await writeFile(join(workspace, "lamp.png"), await sizedImage(8, 8));
    await say("hello");
    script.replyTool = { name: "threads", input: { action: "start", name: "nights", label: "Nights", opening: "The lamp tonight\n![[missing.png]]" } };
    await say("start it");
    const refused = lastToolResult(await thread("main"));
    expect(refused?.failed).toBe(true);
    expect(String(refused?.text)).toStartWith("io: not started: these pictures in the opening could not be sent:\n- ![[missing.png]]: ");
    expect(String(refused?.text)).toEndWith("\nStart it again with the names fixed.");
    expect(runtime.registry.listThreads("ada").map((each) => each.id)).toEqual(["main"]);

    await writeFile(join(workspace, "lamp.md"), "Trim the wick at dusk.\n");
    script.replyTool = { name: "threads", input: { action: "start", name: "nights", label: "Nights", purpose: "Notes on the lamp.", pins: ["lamp.md"], opening: "The lamp tonight\n![[lamp.png]]" } };
    await say("start it again");
    expect(lastToolResult(await thread("main"))?.failed).toBe(false);
    expect(runtime.registry.listThreads("ada").find((each) => each.id === "nights")).toMatchObject({ label: "Nights", purpose: "Notes on the lamp.", pins: ["lamp.md"] });
    expect((await thread("nights")).map((message) => [message.content, message.images])).toEqual([
      ["The lamp tonight\n![[lamp.png]]", [{ path: expect.stringContaining("/sent/") as string, embed: "![[lamp.png]]", name: "lamp.png" }]],
    ]);
  }, (app) => { app.tools.enabled.push("threads"); });
});

test("a picture a wake sends is on the message it posts in home, and one it only mentions is nowhere", async () => {
  await withCharacter(async ({ script, workspace, say, wakeNow, thread }) => {
    await writeFile(join(workspace, "lamp.png"), await sizedImage(8, 8));
    await writeFile(join(workspace, "sketch.png"), await sizedImage(16, 16));
    script.sends = "The lamp tonight\n![[lamp.png]]"; script.closing = "I kept ![[sketch.png]] to myself.";
    await say("hello");
    at(10);
    await wakeNow();

    const delivered = (await thread("main")).at(-1);
    expect(delivered?.content).toBe("The lamp tonight\n![[lamp.png]]");
    expect(delivered?.images).toEqual([{ path: expect.stringContaining("/sent/") as string, embed: "![[lamp.png]]", name: "lamp.png" }]);
    expect((await thread("main")).slice(0, -1).flatMap((message) => message.images)).toEqual([]);
  });
});

function compactsWhenIdle(app: AppConfig): void {
  app.compaction.enabled = true;
  app.compaction.keep_recent_turns = 0;
  app.compaction.min_turns = 1;
  app.compaction.idle_after = ConfigDuration.fromSecs(50 * 60);
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

    expect(archivedIn(data)).toBe(1);
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
    await runtime.autonomy.runDue();
    expect(archivedIn(data)).toBe(1);
    expect(await shownIn(thread)).toEqual(unseen);

    at(25 * 60);
    await runtime.autonomy.runDue();
    expect(await shownIn(thread)).toEqual(unseen);
    expect(threadActivityNow(data, "ada", "main").unread).toBe(1);
  }, (app) => {
    compactsWhenIdle(app);
    app.compaction.archive_after = ConfigDuration.fromSecs(24 * 60 * 60);
  });
});

test("with triggers off an idle conversation is still compacted and later archived, which is announced, and nothing wakes the character", async () => {
  await withCharacter(async ({ runtime, data, script, say, thread }) => {
    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    await say("is the lamp lit?");
    await say("and the door?");
    markThreadRead(data, "ada", "main", T0 + MINUTE);
    expect(runtime.autonomy.wakeFor("ada", { name: "lamp", reason: "the lamp is low", at: T0 })).toBe("queued");

    at(49);
    await runtime.autonomy.runDue();
    expect(archivedIn(data)).toBe(0);

    at(50);
    await runtime.autonomy.runDue();
    expect(archivedIn(data)).toBe(1);
    expect(await shownIn(thread)).toEqual([["user", "", "and the door?"], ["assistant", "", "reply to: and the door?"]]);

    at(24 * 60 + 49);
    await runtime.autonomy.runDue();
    expect(await shownIn(thread)).toHaveLength(2);

    at(24 * 60 + 50);
    await runtime.autonomy.runDue();
    expect(await shownIn(thread)).toEqual([]);
    expect(archivedIn(data)).toBe(2);
    expect(announced.filter(([kind]) => kind === "compaction_complete")).toEqual([["compaction_complete", "Shore - ada", "Idle conversation archived (2 messages)"]]);
    expect(script.wakes).toEqual([]);
  }, (app) => {
    compactsWhenIdle(app);
    app.compaction.keep_recent_turns = 1;
    app.compaction.min_turns = 2;
    app.compaction.archive_after = ConfigDuration.fromSecs(24 * 60 * 60);
    app.triggers.enabled = false;
  });
});

test("home is compacted for the turns the user wrote, however many wakes ran there, and a reply after a wake is sent what set the wake off without the wake's prompt", async () => {
  await withCharacter(async ({ script, data, say, wakeNow }) => {
    const compactions = (): number => archivedIn(data);
    script.sends = undefined; script.closing = "Done.";
    let minute = 0;
    for (const [turn, wakes] of [["one", 2], ["two", 2], ["three", 1]] as const) {
      at(minute += 1);
      await say(turn);
      for (let wake = 0; wake < wakes; wake += 1) {
        at(minute += 1);
        await wakeNow();
      }
      await stopBackgroundCompactions(data);
    }
    expect(script.wakes).toHaveLength(10);
    expect(compactions()).toBe(0);

    at(minute += 1);
    await say("four");
    const asked = textOf(script.replies.at(-1) as SidecarRequest);
    expect(asked).toContain("[wake]\n\n[This wake was started by hand at Friday 2026-10-30 · 12:08 PM, from Shore's command line or its settings.]\n[Your working in this wake is in your thread \"wakes\", not here: 1 tool call.]\nfour");
    expect(asked).not.toContain("This is a wake in your thread");
    await stopBackgroundCompactions(data);
    expect(compactions()).toBe(1);
  }, (app) => {
    app.compaction.enabled = true;
    app.compaction.keep_recent_turns = 0;
    app.compaction.min_turns = 1;
    app.compaction.max_turns = 4;
    app.triggers.max_idle_wakes = 10;
  });
});

test("the wait before an idle conversation is compacted runs from the end of the character's reply, not from the user's message", async () => {
  await withCharacter(async ({ runtime, data, script, say }) => {
    const compactions = (): number => archivedIn(data);
    await repliedAt(20, script, () => say("is the lamp lit?"));
    at(69);
    await runtime.autonomy.runDue();
    expect(compactions()).toBe(0);
    at(70);
    await runtime.autonomy.runDue();
    expect(compactions()).toBe(1);
  }, compactsWhenIdle);
});

test("an idle conversation is compacted once the user has written min_turns turns in it, and wakes there don't count, before or after a restart", async () => {
  const fewTurns = (app: AppConfig): void => {
    compactsWhenIdle(app);
    app.compaction.min_turns = 3;
    app.triggers.max_idle_wakes = 10;
  };
  const compactions = (data: string): number => archivedIn(data);
  let root = "";
  await withCharacter(async ({ runtime, script, data, say, wakeNow }) => {
    root = dirname(data);
    script.sends = undefined; script.closing = "Done.";
    await say("one");
    for (const minute of [1, 2, 3]) {
      at(minute);
      await wakeNow();
    }
    at(4);
    await say("two");
    at(60);
    await runtime.autonomy.runDue();
    expect(compactions(data)).toBe(0);
  }, fewTurns);

  at(120);
  await withCharacter(async ({ runtime, data, say }) => {
    await runtime.autonomy.register(registrationFor("ada", runtime.registry.effectiveConfig("ada")));
    await runtime.autonomy.runDue();
    expect(compactions(data)).toBe(0);

    at(121);
    await say("three");
    at(180);
    await runtime.autonomy.runDue();
    expect(compactions(data)).toBe(1);
  }, fewTurns, root);

  at(0);
  await withCharacter(async ({ data, say }) => {
    root = dirname(data);
    for (const [minute, turn] of [[0, "one"], [1, "two"], [2, "three"]] as const) {
      at(minute);
      await say(turn);
    }
  }, fewTurns);
  at(120);
  await withCharacter(async ({ runtime, data }) => {
    await runtime.autonomy.register(registrationFor("ada", runtime.registry.effectiveConfig("ada")));
    await runtime.autonomy.runDue();
    expect(compactions(data)).toBe(1);
  }, fewTurns, root);
});

test("a side thread trimmed for room without compaction keeps its newest reply while the user hasn't read it", async () => {
  await withCharacter(async ({ runtime, data, script, say, thread }) => {
    await runtime.registry.createThread("ada", "side");
    markThreadRead(data, "ada", "side", T0 - MINUTE);
    await repliedAt(1, script, () => say(`${"the lamp ".repeat(80_000)}\nwhich lamp?`, "side"));

    expect((await thread("side")).map((message) => [message.role, message.content])).toEqual([["assistant", "reply to: which lamp?"]]);
    expect(threadActivityNow(data, "ada", "side").unread).toBe(1);
  }, (app) => {
    app.compaction.keep_recent_turns = 0;
  });
});

test("bare --background tunes wakes on their pinned model", async () => {
  await withCharacter(async ({ command }) => {
    const set = await command("set_model_setting", { key: "reasoning_effort", value: "low", background_task: "all" });
    expect(set).toMatchObject({ type: "command_output", data: { model: "chat.pinned", background_task: "wake" } });
    expect(await command("model_settings", { background_task: "all" })).toMatchObject({ type: "command_output", data: { model: "chat.pinned" } });
    const listed = await command("list_models", {});
    const roles = listed.type === "command_output" ? (listed.data as { roles: { role: string; model: string | null; source: string | null }[] }).roles : [];
    expect(roles.filter((role) => ["wake", "compaction"].includes(role.role))).toEqual([
      { role: "wake", model: "chat.pinned", source: "triggers.model" },
    ]);
  }, (app) => {
    app.triggers.model = "pinned";
  });
});

function archivedIn(data: string, thread = "main"): number {
  const store = HistoryStore.open(join(data, HISTORY_DB_FILE));
  try {
    return store.entries(archiveKey("ada", thread)).length;
  } finally {
    store.close();
  }
}

function byHand(time: string): string {
  return `[This wake was started by hand at Friday 2026-10-30 · ${time}, from Shore's command line or its settings.]`;
}

function times(text: string, part: string): number {
  return text.split(part).length - 1;
}

test("what a wake says at the end is kept only in its working: the next wake in that thread starts without it, and so does a reply there", async () => {
  await withCharacter(async ({ script, say, wakeNow, thread }) => {
    await say("hello");
    script.sends = "I found the keeper's log."; script.closing = "Read the keeper's log up to March.";
    at(10);
    await wakeNow();
    expect((await thread("main")).at(-1)?.content).toBe("I found the keeper's log.");
    expect((await thread("wakes")).at(-1)?.content).toBe("Read the keeper's log up to March.");

    script.wakes.length = 0;
    script.sends = undefined; script.closing = "Done.";
    at(70);
    await wakeNow();
    const next = textOf(script.wakes[0] as SidecarRequest);
    expect(next).toContain(`in this thread.]\n\n${byHand("1:10 PM")}\n\n[Current time: `);
    expect(next).not.toContain("up to March");

    at(80);
    await say("what did you find?");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).not.toContain("up to March");
  });
});

function hold(): { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } {
  return { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
}

test("a wake is told once, at its next step, that the user wrote in another thread while it was running, whichever thread that was", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    await runtime.registry.createThread("ada", "garden");
    await runtime.registry.createThread("ada", "study");
    await say("hello");
    at(10);
    await wakeNow();
    expect(script.wakes.map(textOf).join("\n")).not.toContain("has just written to you");

    for (const [minutes, where] of [[20, "study"], [40, "garden"]] as const) {
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

      const note = required(userWroteNote(new Texts(), T0 + (minutes + 1) * MINUTE, "User", hostZone()));
      expect(script.wakes).toHaveLength(3);
      expect(textOf(script.wakes[0] as SidecarRequest)).not.toContain("has just written to you");
      expect(textOf(script.wakes[1] as SidecarRequest)).toEndWith(note);
      expect(times(textOf(script.wakes[2] as SidecarRequest), "has just written to you")).toBe(1);
      expect((await thread("wakes")).filter((message) => message.role === "system").at(-1)?.content).toBe(note);
    }
  });
});

test("a message sent while a wake runs tells that turn a wake is running, where and since when, once in each thread, and the note stays with the message", async () => {
  const started = new Date(T0 + 20 * MINUTE).toISOString();
  const running = required(wakeRunningText(new Texts(), { started_at: started, thread: "main" }, hostZone()));
  let root = "";
  await withCharacter(async ({ runtime, script, data, say, wakeNow, thread }) => {
    root = dirname(data);
    await runtime.registry.createThread("ada", "garden");
    await runtime.registry.createThread("ada", "study");
    await say("hello");
    at(10);
    await wakeNow();
    at(11);
    await say("nothing is running now");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).not.toContain("A wake of yours");
    await say("the study is quiet", "study");

    const held = hold();
    script.beatHeld = held;
    at(20);
    const ticking = wakeNow();
    await held.started.promise;
    expect(runtime.autonomy.runningWakes()).toEqual([{ character: "ada", startedAt: T0 + 20 * MINUTE }]);
    expect(runtime.autonomy.runningWake("ada")).toMatchObject({ thread: "main", startedAt: T0 + 20 * MINUTE });
    at(21);
    await say("is the lamp lit?", "garden");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(`${running}\nis the lamp lit?`);

    at(22);
    await say("and the door?", "garden");
    const later = textOf(script.replies.at(-1) as SidecarRequest);
    expect(times(later, "A wake of yours")).toBe(1);
    expect(later).toEndWith("reply to: is the lamp lit?\nand the door?");

    at(23);
    await say("the beans are up", "study");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(`${running}\nthe beans are up`);

    held.release.resolve();
    await ticking;
    expect(runtime.autonomy.runningWakes()).toEqual([]);
    expect((await thread("garden")).flatMap((message) => message.wake_running === undefined ? [] : [[message.content, message.wake_running]])).toEqual([
      ["is the lamp lit?", { started_at: started, thread: "main" }],
    ]);
  });

  await withCharacter(async ({ script, say }) => {
    at(30);
    await say("anything new?", "garden");
    const resumed = textOf(script.replies[0] as SidecarRequest);
    expect(resumed).toContain(`${running}\nis the lamp lit?`);
    expect(times(resumed, "A wake of yours")).toBe(1);
  }, undefined, root);
});

test("what a character's wakes did is listed oldest first, the newest twenty unless a count is given, whether or not anything is waking the character yet", async () => {
  at(0);
  const root = await mkdtemp(testTmp("shore-wakes-"));
  const when = new Date(T0).toISOString();
  initializeDatabase(join(root, "data"));
  withStorage(join(root, "data"), (db) => {
    for (let n = 1; n <= 25; n += 1) {
      insertEvent(db, { character: "ada", kind: "wake", timestamp: when, content: encodeEvent({ timestamp: when, kind: "message_sent", detail: `event ${String(n)}` }) });
    }
  });
  const numbered = (from: number) => Array.from({ length: 26 - from }, (_, index) => ({ timestamp: when, kind: "message_sent", detail: `event ${String(from + index)}` }));

  await withCharacter(async ({ runtime, say, command }) => {
    const listed = async (args: Record<string, unknown>) => (await command("wake_log", args) as unknown as { data: { events: unknown[] } }).data.events;
    expect(runtime.autonomy.runnerFor("ada")).toBeUndefined();
    expect(await listed({ count: 2 })).toEqual(numbered(24));
    expect(await listed({})).toEqual(numbered(6));

    await say("hello");
    expect(runtime.autonomy.runnerFor("ada")).toBeDefined();
    expect(await listed({})).toEqual(numbered(6));
    expect(await listed({ count: 3 })).toEqual(numbered(23));
    expect(await listed({ count: 25 })).toEqual(numbered(1));
  }, undefined, root);
});

test("starting a wake by hand answers that it is queued, and making a character dormant or active says which, with a warning when a wake is asked of a dormant one", async () => {
  await withCharacter(async ({ runtime, script, say, command }) => {
    const answered = async (name: string) => (await command(name, {}) as unknown as { type: string; data?: unknown; message?: string });
    expect(await answered("wake_now")).toMatchObject({ type: "error", message: "No autonomy state for character 'ada'" });
    await say("hello");
    at(10);
    expect((await answered("wake_now")).data).toEqual({ status: "queued", character: "ada" });
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);

    expect((await answered("set_dormant")).data).toEqual({ status: "dormant", character: "ada" });
    at(20);
    expect((await answered("wake_now")).data).toEqual({
      status: "queued", character: "ada",
      warning: "ada is dormant, so nothing wakes them and this wake is dropped. Run `shore debug set_active` first.",
    });
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);

    expect((await answered("set_active")).data).toEqual({ status: "active", character: "ada" });
    at(30);
    expect((await answered("wake_now")).data).toEqual({ status: "queued", character: "ada" });
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(4);
  });
});

test("each side is told about the other in these words, with the thread the wake is in, and a note kept from when there was an own-time thread still reads as it did", () => {
  const started = new Date(T0).toISOString();
  expect(required(wakeRunningText(new Texts(), { started_at: started }, "UTC"))).toBe(
    "[A wake of yours in your own-time thread has been running since Friday 2026-10-30 · 12:00 PM. It can't see this conversation. It is only told that a message arrived.]",
  );
  expect(required(wakeRunningText(new Texts(), { started_at: started, thread: "ring" }, "UTC"))).toBe(
    '[A wake of yours in "ring" has been running since Friday 2026-10-30 · 12:00 PM. It can\'t see this conversation. It is only told that a message arrived.]',
  );
  expect(required(userWroteNote(new Texts(), T0 + MINUTE, "eve", "UTC"))).toBe(
    "[eve has just written to you, at Friday 2026-10-30 · 12:01 PM, while this wake is running. " +
    "Another turn of you is answering them, and it knows this wake is running.]",
  );
});

test("a trigger that names no thread wakes the character in home with what it said, shares that wake with whatever else fired, and nothing wakes it between firings", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow }) => {
    const events = (): string[] => runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").map((event) => event.detail);
    await say("hello");
    at(10);
    await wakeNow();
    expect(times(textOf(script.wakes[0] as SidecarRequest), "Your trigger")).toBe(0);
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain(`in this thread.]\n\n${byHand("12:10 PM")}\n\n[Current time: Friday 2026-10-30 · 12:10 PM]\n\n[This is a wake in your thread "main", not a message from `);
    expect(events()).toEqual(['Woken in "main" by a start by hand']);

    const tide = { name: "tide-table", reason: "the tide is out", at: T0 + 19 * MINUTE };
    const lamp = { name: "lamp", reason: "the lamp is low", at: T0 + 20 * MINUTE };
    script.wakes.length = 0;
    at(20);
    expect(runtime.autonomy.wakeFor("ada", tide)).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);
    const woken = textOf(script.wakes[0] as SidecarRequest);
    expect(woken).toContain(`in this thread.]\n\n${required(triggerFiredNote(new Texts(), tide, hostZone()))}\n\n${required(triggerFiredNote(new Texts(), lamp, hostZone()))}\n\n[Current time: `);
    expect(events()).toEqual(['Woken in "main" by a start by hand', 'Woken in "main" by trigger "tide-table", "lamp"']);

    script.wakes.length = 0;
    at(21);
    await runtime.autonomy.runDue();
    at(24 * 60);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(0);

    expect(runtime.autonomy.wakeFor("ada", { ...tide, at: T0 + 24 * 60 * MINUTE })).toBe("queued");
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);
    expect(events().at(-1)).toBe('Woken in "main" by trigger "tide-table"');
    expect(runtime.autonomy.wakeFor("nobody", lamp)).toBeUndefined();
  });
});

test("every wake counts towards going dormant, in a thread or not: after the user's limit nothing fires, what was waiting is dropped, and a message from the user starts it again", async () => {
  let root = "";
  const dormant = (runtime: ShoreRuntime): string[] => runtime.autonomy.log("ada", 100).filter((event) => event.kind === "dormant" || event.kind === "wake").map((event) => event.detail);
  const twoWakes = (app: AppConfig): void => { app.triggers.max_idle_wakes = 2; };
  await withCharacter(async ({ runtime, script, data, say }) => {
    root = dirname(data);
    const log = (): string[] => dormant(runtime);
    const wakeIn = async (minute: number, thread?: string): Promise<void> => {
      at(minute);
      runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minute * MINUTE, ...(thread === undefined ? {} : { thread }) });
      await runtime.autonomy.runDue();
    };
    await runtime.registry.createThread("ada", "ring");
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    await say("psst", "garden");
    expect(log()).toEqual([]);
    script.sends = undefined; script.closing = "Done.";
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
    await runtime.autonomy.runDue();
    expect(script.wakes).toEqual([]);
    expect(log()).toEqual(["User returned — idle counter reset", "Went dormant (wakes without the user: 2)"]);
  }, twoWakes);

  at(210);
  await withCharacter(async ({ runtime, script, say }) => {
    await runtime.autonomy.register(registrationFor("ada", runtime.registry.effectiveConfig("ada")));
    await runtime.autonomy.runDue();
    expect(runtime.autonomy.status("ada")?.state).toBe("Dormant");
    expect(dormant(runtime).filter((detail) => detail.startsWith("Went dormant"))).toHaveLength(1);

    at(211);
    await say("I'm back");
    expect(dormant(runtime).at(-1)).toBe("User returned — idle counter reset");
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Active", wakes_without_user: 0 });
    script.sends = undefined; script.closing = "Done.";
    at(271);
    await runtime.autonomy.runDue();
    expect(script.wakes, "what fired while it was dormant is not made up").toHaveLength(0);
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 271 * MINUTE });
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);
  }, twoWakes, root);
});

test("the user's limits on a character's wakes take hold as soon as they change them", async () => {
  await withCharacter(async ({ runtime, say, reload }) => {
    await say("hello");
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 });
    await runtime.autonomy.runDue();
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Dormant", wakes_without_user: 1, max_idle_wakes: 1, max_silent_ms: 48 * 60 * MINUTE });

    const { triggers } = runtime.registry.effectiveConfig("ada").app;
    triggers.max_idle_wakes = 4;
    await reload();
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Active", max_idle_wakes: 4 });

    triggers.idle_timeout = ConfigDuration.fromSecs(90);
    await reload();
    at(1.5);
    expect(runtime.autonomy.status("ada")).toMatchObject({ state: "Dormant", max_silent_ms: 90_000 });
    at(1.4);
    expect(runtime.autonomy.status("ada")?.state).toBe("Active");
  }, (app) => { app.triggers.max_idle_wakes = 1; });
});

test("a trigger that fires while the character is dormant, or with its triggers switched off, wakes nothing then or later", async () => {
  const lamp = { name: "lamp", reason: "the lamp is low", at: T0 + 10 * MINUTE };
  await withCharacter(async ({ runtime, script, say }) => {
    await say("hello");
    expect(runtime.autonomy.forceDormancy("ada", "dormant")).toBe(true);
    at(10);
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(0);

    at(20);
    await say("I'm back");
    at(90);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(0);
  });

  await withCharacter(async ({ runtime, script, say }) => {
    await say("hello");
    at(10);
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("queued");
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(0);
  }, (app) => { app.triggers.enabled = false; });
});

test("switching triggers on or off reaches wakes on the reload that carries it: a firing wakes the character once they are on, and nothing does once they are off, a wake started by hand included", async () => {
  const lamp = { name: "lamp", reason: "the lamp is low", at: T0 + 10 * MINUTE };
  await withCharacter(async ({ runtime, say, reload, thread }) => {
    await say("hello");
    at(10);
    runtime.registry.effectiveConfig("ada").app.triggers.enabled = true;
    await reload();
    runtime.autonomy.wakeFor("ada", lamp);
    await runtime.autonomy.runDue();
    expect((await thread("main")).at(-1)).toMatchObject({ role: "assistant", origin: "autonomous", content: "I found the keeper's log." });
  }, (app) => { app.triggers.enabled = false; });

  await withCharacter(async ({ runtime, script, say, reload, wakeNow }) => {
    await say("hello");
    at(10);
    runtime.registry.effectiveConfig("ada").app.triggers.enabled = false;
    await reload();
    runtime.autonomy.wakeFor("ada", lamp);
    await wakeNow();
    expect(script.wakes).toHaveLength(0);
  });
});

test("a trigger that fires during a wake in its thread is handed to that wake at its next step, along with word that the user wrote elsewhere", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow }) => {
    await runtime.registry.createThread("ada", "garden");
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
    await say("are you there?", "garden");
    at(13);
    expect(runtime.autonomy.wakeFor("ada", lamp)).toBe("handed");
    held.release.resolve();
    await ticking;

    expect(script.wakes).toHaveLength(3);
    expect(textOf(script.wakes[1] as SidecarRequest)).toEndWith(
      `${required(triggerFiredNote(new Texts(), tide, hostZone()))}\n\n${required(userWroteNote(new Texts(), T0 + 12 * MINUTE, "User", hostZone()))}\n\n${required(triggerFiredNote(new Texts(), lamp, hostZone()))}`,
    );
    expect(times(textOf(script.wakes[2] as SidecarRequest), "Your trigger")).toBe(2);

    script.wakes.length = 0;
    at(14);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(0);
  });
});

test("what set a wake off is told in these words, and nothing new means no note", () => {
  const tide = { name: "tide-table", reason: "the tide is out", at: T0 + MINUTE };
  expect(required(triggerFiredNote(new Texts(), tide, "UTC"))).toBe('[Your trigger "tide-table" fired at Friday 2026-10-30 · 12:01 PM: the tide is out]');
  expect(required(triggerFiredNote(new Texts(), { name: "", byHand: true, reason: "", at: T0 }, "UTC"))).toBe("[This wake was started by hand at Friday 2026-10-30 · 12:00 PM, from Shore's command line or its settings.]");
  expect(required(triggerFiredNote(new Texts(), { name: "", from: "main", reason: "Tell part two.", at: T0, thread: "ring" }, "UTC"))).toBe('[You asked for this wake from "main" at Friday 2026-10-30 · 12:00 PM: Tell part two.]');
  expect(required(triggerFiredNote(new Texts(), { name: "", seal: true, reason: "It is open.", at: T0, thread: "gift" }, "UTC"))).toBe("[The seal on this thread came off at Friday 2026-10-30 · 12:00 PM. It is open.]");
  expect(wakeNewsNote(new Texts(), [], "eve", "UTC")).toBeUndefined();
  expect(required(wakeNewsNote(new Texts(), [{ kind: "user_wrote", at: T0 }, { kind: "trigger", firing: tide }], "eve", "UTC"))).toBe(
    `${required(userWroteNote(new Texts(), T0, "eve", "UTC"))}\n\n${required(triggerFiredNote(new Texts(), tide, "UTC"))}`,
  );
});

function withTriggers(app: AppConfig): void {
  app.tools.enabled.push("bash");
}

async function firedOf(runtime: ShoreRuntime, name: string): Promise<number | undefined> {
  return (await runtime.triggers.view("ada")).triggers.find((each) => each.trigger.name === name)?.fired;
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
    changePresence(data, { on: ["home", "asleep"] }, T0 + 2 * MINUTE);
    noteSeen(data, T0 + 3 * MINUTE);
    at(11);
    await runtime.triggers.tick();
    expect(script.wakes).toHaveLength(0);
    await runtime.autonomy.runDue();

    const woken = textOf(script.wakes[0] as SidecarRequest);
    expect(woken).toContain(
      '[Your trigger "tide" fired at Friday 2026-10-30 · ',
    );
    const printed = woken.slice(woken.indexOf(" PM: tide|") + " PM: ".length, woken.indexOf("]\n\n[Current time: "));
    const [name, now, quiet, last, ...stdin] = printed.split("|");
    expect([name, now, quiet, last]).toEqual(["tide", "2026-10-30T12:11:00.000Z", "660", "2026-10-30T12:00:00.000Z"]);
    const facts = JSON.parse(stdin.join("|")) as { now: string; user: unknown; activity: { messages: number; share_of_messages_by_local_hour: number[]; median_secs_between_sessions: number | null } };
    expect(facts.now).toBe("2026-10-30T12:11:00.000Z");
    expect(facts.user).toEqual({ last_message_at: "2026-10-30T12:00:00.000Z", quiet_secs: 660, last_seen_at: "2026-10-30T12:03:00.000Z", statuses: [{ status: "home", set_at: "2026-10-30T12:02:00.000Z" }, { status: "asleep", set_at: "2026-10-30T12:02:00.000Z" }], statuses_added: [], statuses_removed: [] });
    expect(Object.keys(facts.activity)).toEqual(["messages", "share_of_messages_by_local_hour", "median_secs_between_sessions"]);
    expect(facts.activity.messages).toBe(1);
    expect(facts.activity.share_of_messages_by_local_hour).toHaveLength(24);
    expect(facts.activity.share_of_messages_by_local_hour.reduce((sum, share) => sum + share, 0)).toBe(1);
    expect(facts.activity.median_secs_between_sessions).toBeNull();
    expect((await runtime.triggers.view("ada"))).toMatchObject({ enabled: true, problems: [], triggers: [{ fired: 1, lastFiredAt: T0 + 11 * MINUTE, off: false }] });
  }, withTriggers);
});

test("a follower's turn comes once the wake its leader caused is over, whether that wake was started for it or it joined one already running", async () => {
  const file = '[lamp]\nevery = "10m"\nreason = "Trim the lamp."\ncooldown = "1m"\n\n[after]\nfollows = "lamp"\ncheck = "echo written"\nwake = false\n';
  await withCharacter(async ({ runtime, script, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), file);
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    at(11);
    await runtime.triggers.tick();
    await runtime.triggers.tick();
    expect(await firedOf(runtime, "after")).toBe(0);
    await runtime.autonomy.runDue();
    expect(script.wakes.length).toBeGreaterThan(0);
    await runtime.triggers.tick();
    expect(await firedOf(runtime, "after")).toBe(1);

    const held = hold();
    script.beatHeld = held;
    at(20);
    const ticking = runtime.autonomy.wakeNow("ada") === undefined ? Promise.resolve() : runtime.autonomy.runDue();
    await held.started.promise;
    at(21);
    await runtime.triggers.tick();
    expect((await runtime.triggers.view("ada")).triggers.map((each) => each.fired)).toEqual([2, 1]);
    held.release.resolve();
    await ticking;
    at(22);
    await runtime.triggers.tick();
    expect((await runtime.triggers.view("ada")).triggers.map((each) => each.fired)).toEqual([2, 2]);
  }, withTriggers);
});

test("a trigger that fires while a wake is writing its last words isn't lost: it wakes the character once that wake is over, and only then is its follower set off", async () => {
  const file = '[lamp]\nevery = "10m"\nreason = "Trim the lamp."\ncooldown = "1m"\n\n[after]\nfollows = "lamp"\ncheck = "echo written"\nwake = false\n';
  await withCharacter(async ({ runtime, script, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), file);
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    const end = hold();
    script.endHeld = end;
    at(10);
    const ticking = runtime.autonomy.wakeNow("ada") === undefined ? Promise.resolve() : runtime.autonomy.runDue();
    await end.started.promise;
    at(11);
    await runtime.triggers.tick();
    expect((await runtime.triggers.view("ada")).triggers.map((each) => each.fired)).toEqual([1, 0]);
    end.release.resolve();
    await ticking;
    expect(script.wakes).toHaveLength(2);
    expect(script.wakes.map(textOf).join("\n")).not.toContain("Trim the lamp.");
    at(12);
    await runtime.triggers.tick();
    expect(await firedOf(runtime, "after")).toBe(0);

    script.wakes.length = 0;
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain('[Your trigger "lamp" fired at Friday 2026-10-30 · 12:11 PM: Trim the lamp.]');
    expect(runtime.autonomy.log("ada", 100).map((event) => event.detail)).toContain('Woken in "main" by trigger "lamp"');
    await runtime.triggers.tick();
    expect((await runtime.triggers.view("ada")).triggers.map((each) => each.fired)).toEqual([1, 1]);

    script.wakes.length = 0;
    at(13);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(0);
  }, withTriggers);
});

const TOUCH = '[touch]\nevery = "10m"\ncheck = "touch ran"\n';

async function looks(runtime: ShoreRuntime): Promise<void> {
  at(1);
  await runtime.triggers.tick();
  at(11);
  await runtime.triggers.tick();
}

test("the character's triggers run whenever they are switched on, a check only when it has the bash tool, and nothing while it is dormant", async () => {
  const noBash = "`touch` isn't running: its `check` is a command, and you don't have the `bash` tool to run commands with";
  await withCharacter(async ({ runtime, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `${TOUCH}\n[lamp]\nevery = "10m"\nreason = "Trim the lamp."\n`);
    await say("hello");
    await looks(runtime);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    const view = await runtime.triggers.view("ada");
    expect([view.enabled, view.triggers.map((each) => [each.trigger.name, each.fired]), view.problems]).toEqual([true, [["lamp", 1]], [noBash]]);
  });

  await withCharacter(async ({ runtime, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), TOUCH);
    await say("hello");
    await looks(runtime);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    expect((await runtime.triggers.view("ada")).enabled).toBe(false);
  }, (app) => {
    withTriggers(app);
    app.triggers.enabled = false;
  });

  await withCharacter(async ({ runtime, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), TOUCH);
    await say("hello");
    expect(runtime.autonomy.forceDormancy("ada", "dormant")).toBe(true);
    await looks(runtime);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    expect((await runtime.triggers.view("ada")).problems).toEqual([]);
    expect(runtime.autonomy.forceDormancy("ada", "active")).toBe(true);
    at(12);
    await runtime.triggers.tick();
    at(22);
    await runtime.triggers.tick();
    expect(existsSync(join(workspace, "ran"))).toBe(true);
  }, withTriggers);
});

test("the user's settings reach the character's triggers: a longer cooldown, a shorter check limit, and a trigger switched off by name", async () => {
  await withCharacter(async ({ runtime, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `${TOUCH}\n[slow]\nevery = "10m"\ncheck = "sleep 30"\nwake = false\n\n[lamp]\nevery = "10m"\nreason = "Trim the lamp."\n`);
    await say("hello");
    const started = performance.now();
    await looks(runtime);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
    expect((await runtime.triggers.view("ada")).triggers.map((each) => [each.trigger.name, each.off, each.trigger.cooldownMs, each.nextAt, each.problem])).toEqual([
      ["touch", true, 3 * 60 * MINUTE, undefined, undefined],
      ["slow", false, 0, T0 + 21 * MINUTE, "it was still running at its time limit and was stopped"],
      ["lamp", false, 3 * 60 * MINUTE, T0 + 191 * MINUTE, undefined],
    ]);
  }, (app) => {
    withTriggers(app);
    app.triggers.off = ["touch"];
    app.triggers.wake_cooldown = ConfigDuration.fromSecs(3 * 3600);
    app.triggers.check_time_limit = ConfigDuration.fromMillis(300);
  });
});

test("a character with no triggers file has none, and a file that can't be read leaves the triggers it had running", async () => {
  await withCharacter(async ({ runtime, workspace, say }) => {
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    expect((await runtime.triggers.view("ada"))).toEqual({ enabled: true, triggers: [], problems: [] });

    await writeFile(join(workspace, "TRIGGERS.toml"), TOUCH);
    at(2);
    await runtime.triggers.tick();
    expect((await runtime.triggers.view("ada")).triggers.map((each) => each.trigger.name)).toEqual(["touch"]);
    await rm(join(workspace, "TRIGGERS.toml"));
    await mkdir(join(workspace, "TRIGGERS.toml"));
    at(3);
    await runtime.triggers.tick();
    expect((await runtime.triggers.view("ada")).triggers.map((each) => each.trigger.name)).toEqual(["touch"]);
    await rm(join(workspace, "TRIGGERS.toml"), { recursive: true });
    at(4);
    await runtime.triggers.tick();
    expect((await runtime.triggers.view("ada")).triggers).toEqual([]);
  }, withTriggers);
});

test("a check still running when Shore shuts down is stopped, and nothing is recorded as fired or failed", async () => {
  let looking: Promise<void> = Promise.resolve();
  let state = "";
  const started = performance.now();
  await withCharacter(async ({ runtime, workspace, say }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), '[slow]\nevery = "10m"\ncheck = "sleep 30"\nwake = false\n');
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    at(11);
    looking = runtime.triggers.tick();
    await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
    state = JSON.stringify((await runtime.triggers.view("ada")).triggers.map((each) => [each.fired, each.problem ?? null]));
  }, withTriggers);
  await looking;
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(state).toBe("[[0,null]]");
});

test("the runtime's clocks look at the triggers every thirty seconds until they are stopped", async () => {
  await withCharacter(async ({ runtime, say }) => {
    await say("hello");
    let looked = 0;
    runtime.triggers.tick = async () => { looked += 1; };
    jest.useFakeTimers();
    let stopping: Promise<void> | undefined;
    try {
      const clocks = startRuntimeClocks(runtime);
      jest.advanceTimersByTime(29_999);
      expect(looked).toBe(0);
      jest.advanceTimersByTime(1);
      expect(looked).toBe(1);
      jest.advanceTimersByTime(30_000);
      expect(looked).toBe(2);
      stopping = clocks.stop();
      jest.advanceTimersByTime(90_000);
      expect(looked).toBe(2);
    } finally {
      jest.useRealTimers();
    }
    await stopping;
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

test("a check is told the time, when the user last wrote and was last seen, and the statuses on with when each went on", () => {
  const activity = { messages: 3 };
  const statuses = [{ status: "home", set_at: "2026-10-30T09:00:00.000Z" }, { status: "asleep", set_at: "2026-10-30T11:00:00.000Z" }];
  expect(checkFacts(T0 + 90_500, { lastUserAt: T0, lastSeenAt: T0 + 30_000, statuses }, activity)).toEqual({
    facts: {
      now: "2026-10-30T12:01:30.500Z",
      user: { last_message_at: "2026-10-30T12:00:00.000Z", quiet_secs: 90, last_seen_at: "2026-10-30T12:00:30.000Z", statuses, statuses_added: [], statuses_removed: [] },
      activity,
    },
    env: {
      SHORE_NOW: "2026-10-30T12:01:30.500Z", SHORE_USER_LAST_MESSAGE_AT: "2026-10-30T12:00:00.000Z", SHORE_USER_QUIET_SECS: "90",
      SHORE_USER_LAST_SEEN_AT: "2026-10-30T12:00:30.000Z", SHORE_USER_STATUSES: "home\nasleep", SHORE_USER_STATUSES_ADDED: "", SHORE_USER_STATUSES_REMOVED: "",
    },
  });
  expect(checkFacts(T0, { lastUserAt: undefined, lastSeenAt: undefined, statuses: [] }, undefined)).toEqual({
    facts: { now: "2026-10-30T12:00:00.000Z", user: { last_message_at: null, quiet_secs: null, last_seen_at: null, statuses: [], statuses_added: [], statuses_removed: [] }, activity: null },
    env: { SHORE_NOW: "2026-10-30T12:00:00.000Z", SHORE_USER_LAST_MESSAGE_AT: "", SHORE_USER_QUIET_SECS: "", SHORE_USER_LAST_SEEN_AT: "", SHORE_USER_STATUSES: "", SHORE_USER_STATUSES_ADDED: "", SHORE_USER_STATUSES_REMOVED: "" },
  });
  expect(checkFacts(T0, { lastUserAt: T0, lastSeenAt: undefined, statuses: [] }, undefined).env.SHORE_USER_QUIET_SECS).toBe("0");
});

test("a check for a status change is told which statuses went on and which went off since its trigger last came due", () => {
  const statuses = [{ status: "home", set_at: "2026-10-30T09:00:00.000Z" }, { status: "in bed", set_at: "2026-10-30T11:00:00.000Z" }];
  const told = checkFacts(T0, { lastUserAt: undefined, lastSeenAt: undefined, statuses, statusesSeen: ["home", "on the couch", "sick"] }, undefined);
  expect(told.facts["user"]).toMatchObject({ statuses_added: ["in bed"], statuses_removed: ["on the couch", "sick"] });
  expect([told.env["SHORE_USER_STATUSES_ADDED"], told.env["SHORE_USER_STATUSES_REMOVED"]]).toEqual(["in bed", "on the couch\nsick"]);
  const all = checkFacts(T0, { lastUserAt: undefined, lastSeenAt: undefined, statuses: [], statusesSeen: ["home"] }, undefined);
  expect([all.env["SHORE_USER_STATUSES"], all.env["SHORE_USER_STATUSES_ADDED"], all.env["SHORE_USER_STATUSES_REMOVED"]]).toEqual(["", "", "home"]);
});

function lastToolResult(messages: readonly Message[]): { text: unknown; failed: boolean } | undefined {
  const block = messages.flatMap((message) => message.content_blocks).findLast((each) => each.type === "tool_result");
  return block?.type === "tool_result" ? { text: block.content, failed: block.is_error === true } : undefined;
}

function withTools(...names: string[]): (app: AppConfig) => void {
  return (app) => {
    withTriggers(app);
    app.tools.enabled = [...app.tools.enabled, ...names];
  };
}

test("the character can list its triggers from a conversation, and is told when it has none or its triggers are off", async () => {
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
      text: 'Your triggers, from TRIGGERS.toml in your workspace root. peggy has your triggers switched off, so nothing fires.\n\nlamp: every 1h, wakes you, "Trim the lamp.", at most every 1h\n  never fired',
      failed: false,
    });
  }, (app) => {
    app.tools.enabled = [...app.tools.enabled, "list_triggers"];
    app.triggers.enabled = false;
  });
});

test("the user's status lists the character's triggers as its file has them, and names the one due next to wake it", async () => {
  await withCharacter(async ({ runtime, workspace, say, command }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), '[lamp]\nevery = "1h"\nreason = "Trim the lamp."\n');
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    const shown = await command("status", {}) as unknown as { data: { triggers: unknown; sections: string[] } };
    expect(shown.data.triggers).toEqual({
      enabled: true,
      next_wake: { trigger: "lamp", at: "2026-10-30T13:01:00+00:00" },
      triggers: [{ name: "lamp", does: 'every 1h, wakes ada, "Trim the lamp.", at most every 1h', status: "next Friday 2026-10-30 · 1:01 PM · never fired" }],
      not_running: [],
    });
    expect(shown.data.sections).toContain("triggers");
  }, withTriggers);
});

test("from a conversation the character sends to another thread once its reply is done, and with a push the message reaches the user's topic once, at normal priority", async () => {
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
  const without = "Send it again without `push` to post it all the same.";
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  const pushLines = (): string[] => warned.mock.calls.map((call) => String(call[0])).filter((line) => !line.startsWith("shore: rejected a "));
  try {
    await withCharacter(async ({ runtime, script, fromReplies, say, thread }) => {
      await runtime.registry.createThread("ada", "garden");
      const announced: unknown[][] = [];
      runtime.notifier.notify = (...told) => { announced.push(told); };
      const result = async (): Promise<{ text: string; failed: boolean }> => {
        const last = lastToolResult(await thread("main"));
        return { text: String(last?.text), failed: last?.failed === true };
      };
      const garden = async () => (await thread("garden")).map((message) => [message.role, message.origin, message.content]);
      await say("hello");
      script.replyTool = { name: "send_message", input: { text: "  I miss you.  ", thread: "garden", push: true } };
      at(5);
      await say("you can reach my phone now");
      expect(await result()).toEqual({ text: 'It will be posted in "garden" when this turn ends. It goes to peggy\'s phone then too.', failed: false });
      expect(await garden()).toEqual([["assistant", "autonomous", "I miss you."]]);
      const reply = (await thread("main")).at(-1);
      expect(reply?.content).toBe("reply to: you can reach my phone now");
      expect(typeof reply?.model).toBe("string");
      expect((await thread("garden")).map((message) => [message.provider_key, message.model])).toEqual([[reply?.provider_key, reply?.model]]);
      expect(fromReplies.flatMap((event) => event.type === "new_message" && event.thread === "garden" ? [[event.role, event.origin, event.content]] : [])).toEqual([["assistant", "autonomous", "I miss you."]]);
      expect(pushed).toEqual([{ path: "/phone", method: "POST", title: "Shore - ada", auth: "Bearer fixture-key", priority: null, body: "I miss you." }]);
      expect(announced.filter(([kind]) => kind === "autonomous_message")).toEqual([["autonomous_message", "Shore - ada", "I miss you.", undefined]]);
      expect(pushLines()).toEqual([]);

      script.replyTool = { name: "send_message", input: { text: "Still here.", thread: "garden", push: true } };
      at(65);
      await say("try again");
      expect(await result()).toEqual({
        text: `io: not sent: your last push was Friday 2026-10-30 · 12:05 PM, and the next one is allowed from Saturday 2026-10-31 · 12:05 PM. ${without}`,
        failed: true,
      });
      script.replyTool = { name: "send_message", input: { text: "Still here.", thread: "garden" } };
      await say("without the push, then");
      expect(await result()).toEqual({ text: 'It will be posted in "garden" when this turn ends.', failed: false });
      expect(await garden()).toEqual([["assistant", "autonomous", "I miss you."], ["assistant", "autonomous", "Still here."]]);
      expect(pushed).toHaveLength(1);

      const refused = async (input: Record<string, unknown>): Promise<string> => {
        script.replyTool = { name: "send_message", input };
        await say("and again");
        const answer = await result();
        expect(answer.failed, JSON.stringify(input)).toBe(true);
        return answer.text;
      };
      const here = "io: your reply here is already a message to peggy; `send_message` is for saying something in another thread, so name one with `thread`";
      expect(await refused({ text: "Hello." })).toBe(here);
      expect(await refused({ text: "Hello.", thread: "main" })).toBe(here);
      expect(await refused({ text: "Hello.", thread: "nowhere" })).toBe('io: you have no thread "nowhere" to send it in; `threads` lists the ones you have');
      expect(await refused({ text: "Hello.", thread: "the garden" })).toBe("invalid args: thread must be a thread's id, as `threads` lists it");
      expect(await refused({ text: "   ", thread: "garden" })).toBe("invalid args: text must be a non-empty string");
      expect(await refused({ text: "Hello.", thread: "garden", loud: true })).toStartWith("The call to send_message was not run because argument `loud` is not allowed.");
      expect(await refused({ text: "Look: ![[missing.png]]", thread: "garden" })).toStartWith("io: not sent: these pictures in it could not be sent:\n- ![[missing.png]]: ");
      expect(await garden()).toHaveLength(2);
    }, (app) => {
      app.notifications.push_topic = "phone";
      app.notifications.url = `http://127.0.0.1:${String(ntfy.port)}`;
      app.notifications.token_env = KEY_ENV;
    });

    await withCharacter(async ({ runtime, script, say, thread }) => {
      await runtime.registry.createThread("ada", "garden");
      await say("hello");
      script.replyTool = { name: "send_message", input: { text: "I miss you.", thread: "garden", push: true } };
      await say("can you reach my phone?");
      expect(lastToolResult(await thread("main"))).toEqual({
        text: `io: not sent: push notifications aren't set up, because peggy hasn't given Shore a topic to send them to. ${without}`,
        failed: true,
      });
      expect(await thread("garden")).toEqual([]);
      expect(pushed).toHaveLength(1);
    });

    const gone = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const unreachable = `http://127.0.0.1:${String(gone.port)}`;
    await gone.stop(true);
    warned.mockClear();
    await withCharacter(async ({ runtime, script, say, thread }) => {
      await runtime.registry.createThread("ada", "garden");
      await say("hello");
      script.replyTool = { name: "send_message", input: { text: "I miss you.", thread: "garden", push: true } };
      await say("can you reach my phone?");
      expect((await thread("garden")).map((message) => message.content)).toEqual(["I miss you."]);
      expect(pushLines()).toHaveLength(1);
      expect(pushLines()[0]).toStartWith("shore: The push that went with a message failed: ");
    }, (app) => {
      app.notifications.push_topic = "phone";
      app.notifications.url = unreachable;
    });
  } finally {
    warned.mockRestore();
    await ntfy.stop(true);
  }
});

test("a reply's message for a thread that is archived before the reply is done isn't sent, and Shore's log says so", async () => {
  const lines: string[] = [];
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  await withCharacter(async ({ runtime, script, say, thread, command }) => {
    await runtime.registry.createThread("ada", "garden");
    await runtime.registry.createThread("ada", "attic");
    await say("hello");
    const called = hold();
    script.held = called;
    script.replyTool = { name: "send_message", input: { text: "The beans are up.", thread: "garden" } };
    const saying = say("tell the garden");
    await called.started.promise;
    const answered = hold();
    called.release.resolve();
    script.held = answered;
    await answered.started.promise;
    expect(await command("archive_thread", { name: "garden" })).toMatchObject({ type: "command_output" });
    answered.release.resolve();
    await saying;

    expect((await thread("main")).at(-1)?.content).toBe("reply to: tell the garden");
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "attic"]);
  }).finally(() => {
    lines.push(...warned.mock.calls.map(([line]) => String(line)));
    warned.mockRestore();
  });
  expect(lines).toContain('shore: A message for the thread "garden" was not sent: that thread was gone by the time the turn in "main" ended');
});

test("a wake's message with a push reaches the user's phone when the wake ends, and a push asked for too soon after is refused as it is sent", async () => {
  const pushed: string[] = [];
  const ntfy = Bun.serve({ port: 0, fetch: async (request) => { pushed.push(await request.text()); return new Response("ok"); } });
  try {
    await withCharacter(async ({ script, say, wakeNow, thread }) => {
      await say("hello");
      script.sends = undefined; script.closing = "Done.";
      script.beatTool = { name: "send_message", input: { text: "The lamp is lit.", push: true } };
      at(10);
      await wakeNow();
      expect(lastToolResult(await thread("wakes"))).toEqual({ text: "It will be posted in this thread when this wake ends. It goes to User's phone then too.", failed: false });
      expect((await thread("main")).at(-1)?.content).toBe("The lamp is lit.");
      expect(pushed).toEqual(["The lamp is lit."]);

      script.beatTool = { name: "send_message", input: { text: "Still lit.", push: true } };
      at(40);
      await wakeNow();
      expect(lastToolResult(await thread("wakes"))).toEqual({
        text: "io: not sent: your last push was Friday 2026-10-30 · 12:10 PM, and the next one is allowed from Saturday 2026-10-31 · 12:10 PM. Send it again without `push` to post it all the same.",
        failed: true,
      });
      expect((await thread("main")).filter((message) => message.role === "assistant" && message.origin === "autonomous").map((message) => message.content)).toEqual(["The lamp is lit."]);
      expect(pushed).toHaveLength(1);
    }, (app) => {
      app.notifications.push_topic = "phone";
      app.notifications.url = `http://127.0.0.1:${String(ntfy.port)}`;
    });
  } finally {
    await ntfy.stop(true);
  }
});

test("the user's statuses reach a conversation with their next message after any change, once, and a clearing once", async () => {
  let root = "";
  await withCharacter(async ({ script, data, say, thread }) => {
    root = dirname(data);
    const last = (): string => textOf(script.replies.at(-1) as SidecarRequest);
    await say("hello");
    expect(last()).not.toContain("status");
    changePresence(data, { on: ["home"] }, T0 + 5 * MINUTE);
    at(15);
    await say("you up?");
    expect(last()).toEndWith('[Their status: "home" for 10 minutes]\nyou up?');
    at(16);
    await say("hello?");
    expect(times(last(), "Their status")).toBe(1);

    changePresence(data, { on: ["on the couch", "sick"] }, T0 + 20 * MINUTE);
    at(25);
    await say("back at it");
    expect(last()).toEndWith('[Their status: "home" for 20 minutes, "on the couch" for 5 minutes, "sick" for 5 minutes]\nback at it');
    changePresence(data, { on: ["in bed"], off: ["on the couch"] }, T0 + 26 * MINUTE);
    changePresence(data, { on: ["out"] }, T0 + 27 * MINUTE);
    changePresence(data, { off: ["out"] }, T0 + 28 * MINUTE);
    at(30);
    await say("moved");
    expect(last()).toEndWith('[Their status: "home" for 25 minutes, "sick" for 10 minutes, "in bed" for 4 minutes]\nmoved');
    changePresence(data, { clear: true }, T0 + 31 * MINUTE);
    at(32);
    await say("done for the day");
    expect(last()).toEndWith("[Their status was cleared a minute ago.]\ndone for the day");
    at(33);
    await say("night");
    expect(times(last(), "Their status")).toBe(4);
    expect((await thread("main")).flatMap((message) => message.presence === undefined ? [] : [[message.content, message.presence.statuses.map((status) => status.status).join(", ")]])).toEqual([
      ["you up?", "home"], ["back at it", "home, on the couch, sick"], ["moved", "home, sick, in bed"], ["done for the day", ""],
    ]);
  });

  await withCharacter(async ({ script, say }) => {
    at(40);
    await say("anything new?");
    const resumed = textOf(script.replies[0] as SidecarRequest);
    expect(resumed).toContain('[Their status: "home" for 10 minutes]\nyou up?');
    expect(times(resumed, "Their status")).toBe(4);
  }, undefined, root);
});

test("a wake starts with the user's statuses and how long each has been on while any is on, and a change sets off the trigger for it, which is told what went on and off", async () => {
  await withCharacter(async ({ runtime, script, workspace, data, say, wakeNow }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `[status]\nwhen = "status_changed"\ncheck = 'printf "on: %s; added: %s; removed: %s" "$SHORE_USER_STATUSES" "$SHORE_USER_STATUSES_ADDED" "$SHORE_USER_STATUSES_REMOVED"'\n`);
    await say("hello");
    script.sends = undefined; script.closing = "Done.";
    at(1);
    await wakeNow();
    expect(textOf(script.wakes[0] as SidecarRequest)).not.toContain("status");

    changePresence(data, { on: ["home", "on the couch"] }, T0 + 2 * MINUTE);
    at(2);
    await runtime.triggers.tick();
    changePresence(data, { on: ["asleep"], off: ["on the couch"] }, T0 + 5 * MINUTE);
    await runtime.triggers.statusChanged();
    script.wakes.length = 0;
    at(65);
    await runtime.triggers.tick();
    await runtime.autonomy.runDue();
    expect(textOf(script.wakes[0] as SidecarRequest)).toContain(`in this thread.]\n\n[User's status: "home" for about an hour, "asleep" for about an hour]\n\n[Your trigger "status" fired at Friday 2026-10-30 · 1:05 PM: on: home\nasleep; added: asleep; removed: on the couch]\n\n[Current time: `);

    changePresence(data, { clear: true }, T0 + 70 * MINUTE);
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

test("the presence command turns statuses on and off, and sets off the trigger for a change with what was on before", async () => {
  await withCharacter(async ({ runtime, workspace, data, say, command }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), `[status]\nwhen = "status_changed"\ncheck = 'echo "added: $SHORE_USER_STATUSES_ADDED"'\nwake = false\n`);
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    expect((await command("presence", {}) as { data?: unknown }).data).toEqual({ statuses: [], history: [] });
    await runtime.triggers.tick();
    expect(await firedOf(runtime, "status")).toBe(0);

    at(5);
    const set = await command("presence", { on: ["  at work "] });
    expect(set).toMatchObject({ type: "command_output", name: "presence" });
    expect((set as { data?: unknown }).data).toEqual({ statuses: [{ status: "at work", set_at: new Date(T0 + 5 * MINUTE).toISOString() }], history: ["at work"] });
    expect(presence(data)?.statuses).toEqual([{ status: "at work", set_at: new Date(T0 + 5 * MINUTE).toISOString() }]);
    at(6);
    await runtime.triggers.tick();
    expect(await firedOf(runtime, "status")).toBe(1);

    at(7);
    const refused = await command("presence", { on: ["at work"], off: ["at work"] });
    expect(refused.type).toBe("error");
    expect(JSON.stringify(refused)).toContain(`\\"at work\\" can't be turned on and off at once`);
    expect((await command("presence", { forget: ["at work"] }) as { data?: unknown }).data).toMatchObject({ history: [] });
    await runtime.triggers.tick();
    expect(await firedOf(runtime, "status")).toBe(1);

    at(8);
    const cleared = await command("presence", { clear: true });
    expect((cleared as { data?: unknown }).data).toEqual({ statuses: [], history: [] });
    expect(presenceState(data).presence).toEqual({ statuses: [], changed_at: new Date(T0 + 8 * MINUTE).toISOString() });
    at(9);
    await runtime.triggers.tick();
    expect(await firedOf(runtime, "status")).toBe(2);
  }, withTriggers);
});

const SHOW = '[show]\nevery = "10m"\nreason = "Tell the next part."\nthread = "ring"\n';

const FIRED = '[Your trigger "show" fired at Friday 2026-10-30 · 12:11 PM: Tell the next part.]';

function wakeShown(now: string, shown: readonly string[], lines: readonly string[], limit = "30 minutes", nudgeAfter = "25 minutes", thread = "ring", working: string | null = "wakes"): string {
  return [
    "[wake]",
    ...shown,
    ...lines,
    `[Current time: Friday 2026-10-30 · ${now}]`,
    `[This is a wake in your thread "${thread}", not a message from User. What set it off is written just above this, and that says what this wake is for. You are free to use your tools as you wish.`,
    "A wake starts fresh. None of your earlier wakes' working is in front of you, only what is above, and none of this wake's working will be in front of the next one. What a later wake will need has to be in a file before you stop.",
    "Nothing from a wake reaches User unless you call `send_message`: the message is posted in this thread when the wake ends, or in another thread if you name one. " + (working === null
      ? "Everything you do in this wake stays in this thread as your working: User can read it if they look, but nothing tells them it is there. Your later turns here are shown how much of it there was, not the working itself."
      : `Everything you do in this wake is kept as your working in "${working}", the thread Shore keeps for it, where User can read it. This thread gets a line saying where it went, and your later turns here are shown how much working there was, not the working itself.`),
    `A wake here can run for up to ${limit}. After ${nudgeAfter}, you will get a nudge to wrap up, with a few more rounds to finish, and at the limit the wake is stopped wherever it is. If User writes in this thread while you are working, the wake stops at the end of the step it is on so that you can answer them, and you are woken here again to pick it up once they have been quiet here for 10 minutes. If they write in another thread, the wake goes on, and another turn of you answers them there. That turn can change your workspace too, so when you commit, stage only the files you changed.]`,
  ].join("\n\n");
}

function wakeText(now: string, lines: readonly string[], limit = "30 minutes", nudgeAfter = "25 minutes"): string {
  return wakeShown(now, [], lines, limit, nudgeAfter);
}

function wakeSeenLater(...setOff: string[]): string {
  return ["[wake]", ...setOff].join("\n\n");
}

function homeWakeShown(now: string, shown: readonly string[], lines: readonly string[], limit = "30 minutes", nudgeAfter = "25 minutes"): string {
  return wakeShown(now, shown, lines, limit, nudgeAfter, "main");
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

function turnsOf(request: SidecarRequest | undefined): [role: string, text: string][] {
  return (request?.messages ?? []).map((message) => [message.role, message.content.map((block) => block.type === "text" ? block.text : `<${block.type}>`).join("|")]);
}

async function fires(runtime: ShoreRuntime, minutes: number): Promise<void> {
  at(minutes);
  await runtime.triggers.tick();
  await runtime.autonomy.runDue();
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
    script.sends = "Part one: the fox came to the gate."; script.closing = "Told part one; the fox is at the gate.";
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
      ["claude-pinned", "wake", "ring"],
      ["claude-pinned", "wake_tool_loop", "ring"],
    ]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("12:11 PM", [
      `The last of what was said in this thread:\n\n${said("User", "12:01 PM", "tell me a story in parts")}\n\n${said("you", "12:01 PM", "reply to: tell me a story in parts")}`,
      wroteLast("10 minutes ago"),
    ], [FIRED])]]);
    expect(stored(await thread("ring"))).toEqual([
      ["user", "", "tell me a story in parts"],
      ["assistant", "", "reply to: tell me a story in parts"],
      ["user", "autonomous", wakeSeenLater(FIRED)],
      ["system", "autonomous", 'This wake\'s working is in "Wakes": 2 tool calls.'],
      ["assistant", "autonomous", "Part one: the fox came to the gate."],
    ]);
    expect(stored(await thread("wakes"))).toEqual([
      ["user", "autonomous", opener.replace("[wake]", '[wake in "ring"]')],
      ["assistant", "", ""],
      ["user", "", "<SOUL.md>"],
      ["assistant", "", 'Told part one; the fox is at the gate.'],
    ]);
    expect(emitted.map((each) => [each.thread, each.msg.content])).toEqual([["ring", "Part one: the fox came to the gate."]]);
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "ring", "wakes"]);
    expect(threadActivityNow(data, "ada", "wakes")).toMatchObject({ turns: 1, user_turns: 0, unread: 0 });
    expect(threadActivityNow(data, "ada", "ring")).toEqual({
      turns: 2, user_turns: 1, last_active: new Date(T0 + 11.5 * MINUTE).toISOString(), last_user: new Date(T0 + MINUTE).toISOString(), unread: 1,
    });

    at(12);
    await say("and then?", "ring");
    expect(turnsOf(script.replies.at(-1)).slice(2)).toEqual([
      ["user", wakeSeenLater(FIRED)],
      ["system", '[Your working in this wake is in your thread "wakes", not here: 2 tool calls.]'],
      ["user", "[wake · Friday 2026-10-30 · 12:11 PM]"],
      ["assistant", "Part one: the fox came to the gate."],
      ["user", "and then?"],
    ]);
    at(13);
    await say("anything new?");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith("reply to: hello\nanything new?");
    expect(textOf(script.replies.at(-1) as SidecarRequest)).not.toContain("fox");

    script.wakes.length = 0;
    script.sends = undefined; script.closing = "Done.";
    await fires(runtime, 71);
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring"]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("1:11 PM", [
      `What was said in this thread since your last wake here:\n\n${said("you, in a wake", "12:11 PM", "Part one: the fox came to the gate.")}\n\n${said("User", "12:12 PM", "and then?")}\n\n${said("you", "12:12 PM", "reply to: and then?")}`,
      wroteLast("58 minutes ago", 'your home thread "main"'),
    ], ['[Your trigger "show" fired at Friday 2026-10-30 · 1:11 PM: Tell the next part.]'])]]);

    script.wakes.length = 0;
    await fires(runtime, 25 * 60 + 11);
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("1:11 PM", [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("about a day ago", 'your home thread "main"'),
    ], ['[Your trigger "show" fired at Saturday 2026-10-31 · 1:11 PM: Tell the next part.]']).replace("[Current time: Friday 2026-10-30", "[Current time: Saturday 2026-10-31")]]);
  }, (app) => {
    withTriggers(app);
    app.triggers.max_idle_wakes = 10;
  });
});

test("a trigger that names a thread the character doesn't have wakes nothing, and the log says so", async () => {
  await withCharacter(async ({ runtime, script, workspace, say }) => {
    await say("hello");
    at(1);
    await writeFile(join(workspace, "TRIGGERS.toml"), '[lost]\nevery = "10m"\nreason = "r"\nthread = "nowhere"\n');
    await runtime.triggers.tick();
    await fires(runtime, 12);
    expect(script.wakes).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "nowhere" by trigger "lost"'],
      ["call_failed", 'Wake skipped: no thread "nowhere"'],
    ]);
  }, withTriggers);
});

const AFTER = '\n[after]\nfollows = "show"\ncheck = "echo written"\nwake = false\n';

test("the user's message stops a wake in that thread at the end of its step and is answered, and once they have been quiet there for ten minutes a fresh wake picks it up, told how the last one stopped", async () => {
  await withCharacter(async ({ runtime, script, workspace, emitted, say, thread }) => {
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
      ["user", "autonomous", wakeSeenLater(FIRED)],
      ["system", "autonomous", 'This wake\'s working is in "Wakes": 2 tool calls.'],
      ["system", "autonomous", stopped],
      ["user", "", "wait, what is the fox called?"],
      ["assistant", "", "reply to: wait, what is the fox called?"],
    ]);
    expect(stored(await thread("wakes"))).toEqual([
      ["user", "autonomous", opener.replace("[wake]", '[wake in "ring"]')],
      ["assistant", "", "Let me look."],
      ["user", "", "<SOUL.md>"],
      ["system", "autonomous", stopped],
    ]);
    const cutShort: [role: string, text: string][] = [
      ["user", wakeSeenLater(FIRED)],
      ["system", "[Your working in this wake is in your thread \"wakes\", not here: 2 tool calls, ending with `read`. It ended before you had finished. The last thing you wrote in it: \"Let me look.\"]"],
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
    expect(await firedOf(runtime, "after")).toBe(0);

    script.again = 0;
    script.aside = undefined;
    at(13);
    await say("is the lamp lit?");
    at(21);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(1);
    script.sends = "Part one: Rue came to the gate."; script.closing = "Told part one.";
    at(22);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(3);
    expect(turnsOf(script.wakes[1])).toEqual([["user", wakeShown("12:22 PM", [
      `The last of what was said in this thread:\n\n${said("User", "12:01 PM", "tell me a story in parts")}\n\n${said("you", "12:01 PM", "reply to: tell me a story in parts")}\n\n${said("User", "12:12 PM", "wait, what is the fox called?")}\n\n${said("you", "12:12 PM", "reply to: wait, what is the fox called?")}`,
      "[Your last wake here was stopped for User's message at Friday 2026-10-30 · 12:12 PM, after 1 round, before it had finished. Nothing from it was sent to User. The last thing it wrote: \"Let me look.\" Whatever it had already changed with its tools is still in place.]",
      wroteLast("9 minutes ago", 'your home thread "main"'),
    ], [FIRED])]]);
    expect((await thread("ring")).at(-1)?.content).toBe("Part one: Rue came to the gate.");
    await runtime.triggers.tick();
    expect(await firedOf(runtime, "after")).toBe(1);
    at(40);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(3);
  }, withTriggers);
});

const RING_FIRED = (time: string): string => `[Your trigger "show" fired at Friday 2026-10-30 · ${time}: r]`;

async function wakesInRing(runtime: ShoreRuntime, minutes: number): Promise<void> {
  runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minutes * MINUTE, thread: "ring" });
  at(minutes);
  await runtime.autonomy.runDue();
}

test("a wake's working goes to the wakes thread for the user, and a reply in the thread it ran in and the request rebuilt from disk are sent how it opened, the line and its message, while a later wake there starts fresh", async () => {
  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    script.aside = "Let me find my place.";
    script.again = 1;
    script.sends = "Part one: the fox came to the gate."; script.closing = "Told part one.";
    await wakesInRing(runtime, 11);

    const first = wakeText("12:11 PM", [RING_FIRED("12:11 PM")]);
    expect(stored(await thread("ring")).slice(2)).toEqual([
      ["user", "autonomous", wakeSeenLater(RING_FIRED("12:11 PM"))],
      ["system", "autonomous", 'This wake\'s working is in "Wakes": 3 tool calls.'],
      ["assistant", "autonomous", "Part one: the fox came to the gate."],
    ]);
    expect(stored(await thread("wakes"))).toEqual([
      ["user", "autonomous", first.replace("[wake]", '[wake in "ring"]')],
      ["assistant", "", "Let me find my place."],
      ["user", "", "<SOUL.md>"],
      ["assistant", "", ""],
      ["user", "", "<SOUL.md>"],
      ["assistant", "", 'Told part one.'],
    ]);
    expect((await thread("wakes")).at(-1)?.content_blocks.map((block) => block.type)).toEqual(["thinking", "text"]);
    const firstSeen: [role: string, text: string][] = [
      ["user", "tell me a story in parts"],
      ["assistant", "reply to: tell me a story in parts"],
      ["user", wakeSeenLater(RING_FIRED("12:11 PM"))],
      ["system", '[Your working in this wake is in your thread "wakes", not here: 3 tool calls.]'],
      ["user", "[wake · Friday 2026-10-30 · 12:11 PM]"],
      ["assistant", "Part one: the fox came to the gate."],
    ];

    script.wakes.length = 0;
    script.aside = undefined;
    script.sends = undefined; script.closing = "Nothing to add yet.";
    await wakesInRing(runtime, 12);
    const second = wakeText("12:12 PM", [RING_FIRED("12:12 PM")]);
    const shownSecond = wakeShown("12:12 PM", [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("11 minutes ago"),
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
      ["user", wakeSeenLater(RING_FIRED("12:12 PM"))],
      ["system", '[Your working in this wake is in your thread "wakes", not here: 1 tool call.]'],
      ["user", "and then?"],
    ];
    expect(turnsOf(script.replies.at(-1))).toEqual(bothSeen);
    expect((await thread("ring")).filter(isWakeOpener).map((message) => [message.content, message.shown_later])).toEqual([
      [wakeSeenLater(RING_FIRED("12:11 PM")), undefined],
      [wakeSeenLater(RING_FIRED("12:12 PM")), undefined],
    ]);
    expect((await thread("wakes")).filter(isWakeOpener).map((message) => [message.content, message.shown_later])).toEqual([
      [first.replace("[wake]", '[wake in "ring"]'), undefined],
      [second.replace("[wake]", '[wake in "ring"]'), undefined],
    ]);
    expect((await thread("ring")).filter((message) => message.content_blocks.some((block) => block.type === "tool_use"))).toHaveLength(0);
    expect((await thread("wakes")).filter((message) => message.content_blocks.some((block) => block.type === "tool_use"))).toHaveLength(3);

    const answered: [role: string, text: string][] = [...bothSeen, ["assistant", "reply to: and then?"]];
    const rebuilt = await rebuildRequestFromDisk("ada", data, runtime.config, { ...NO_MCP, thread: "ring" });
    expect(turnsOf(rebuilt?.request)).toEqual(answered);

    markThreadRead(data, "ada", "ring", T0 + 14 * MINUTE);
    await compactByHand(runtime, "ring");
    expect(await thread("ring")).toEqual([]);
  }, keepNothing);
});

test("a wake's working doesn't count towards its thread's size, which it isn't kept in, however much the wake wrote or ended on, and the wakes thread is trimmed once its working fills it", async () => {
  const aLot = "the lamp ".repeat(80_000);
  await withCharacter(async ({ runtime, script, say, thread, command }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    script.aside = aLot;
    script.sends = undefined; script.closing = "Told part one.";
    await wakesInRing(runtime, 11);
    at(12);
    await say("and then?", "ring");
    expect((await thread("ring")).map((message) => message.content.length > 100_000 ? "a lot" : message.role)).toEqual([
      "user", "assistant", "user", "system", "user", "assistant",
    ]);
    expect((await thread("wakes")).map((message) => message.content.length > 100_000 ? "a lot" : message.role)).toEqual([
      "user", "a lot", "user", "assistant",
    ]);
    const status = await command("status", {}, "ring");
    expect(status.type === "command_output" ? (status.data as { context_tokens: number }).context_tokens : undefined).toBeLessThan(1000);

    script.aside = undefined;
    script.closing = aLot;
    await wakesInRing(runtime, 23);
    expect((await thread("ring")).map((message) => message.content.length > 100_000 ? "a lot" : message.role)).toEqual([
      "user", "assistant", "user", "system", "user", "assistant", "user", "system",
    ]);
    expect((await thread("wakes")).map((message) => message.content.length > 100_000 ? "a lot" : message.role)).toEqual([
      "user", "assistant", "user", "a lot",
    ]);
    const after = await command("status", {}, "ring");
    expect(after.type === "command_output" ? (after.data as { context_tokens: number }).context_tokens : undefined).toBeLessThan(1000);
  }, (app) => {
    app.compaction.keep_recent_turns = 0;
  });

  const compactions = (data: string): number => archivedIn(data, "ring");
  await withCharacter(async ({ runtime, script, data, say }) => {
    await runtime.registry.createThread("ada", "ring", { compaction: true });
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    script.aside = aLot;
    script.sends = undefined; script.closing = "Told part one.";
    await wakesInRing(runtime, 11);
    await stopBackgroundCompactions(data);
    expect(compactions(data)).toBe(0);

    script.aside = undefined;
    script.closing = aLot;
    await wakesInRing(runtime, 12);
    await stopBackgroundCompactions(data);
    expect(compactions(data)).toBe(0);
  }, (app) => {
    app.compaction.enabled = true;
    app.compaction.keep_recent_turns = 0;
    app.compaction.min_turns = 1;
    app.compaction.max_context_tokens = 100_000;
  });
});

test("a wake waits for the user to have been quiet in its thread for ten minutes, however lately they wrote elsewhere", async () => {
  await withCharacter(async ({ runtime, script, say }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(5);
    await say("one more thing", "ring");
    script.sends = undefined; script.closing = "Done.";
    expect(runtime.autonomy.wakeFor("ada", { name: "show", reason: "Tell the next part.", at: T0 + 6 * MINUTE, thread: "ring" })).toBe("queued");
    at(14);
    await say("is the lamp lit?");
    await runtime.autonomy.runDue();
    at(14.999);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(0);
    at(15);
    await runtime.autonomy.runDue();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring"]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("12:15 PM", [
      `The last of what was said in this thread:\n\n${said("User", "12:05 PM", "one more thing")}\n\n${said("you", "12:05 PM", "reply to: one more thing")}`,
      wroteLast("a minute ago", 'your home thread "main"'),
    ], ['[Your trigger "show" fired at Friday 2026-10-30 · 12:06 PM: Tell the next part.]'])]]);
  }, withTriggers);
});

function handOff(...names: string[]): (app: AppConfig) => void {
  return (app) => {
    app.tools.enabled = [...app.tools.enabled, "wake_in_thread", ...names];
    app.triggers.max_wake_limit = ConfigDuration.fromSecs(2 * 3600);
    app.triggers.max_idle_wakes = 10;
  };
}

test("from a wake in home the character hands off into another thread, and is woken there next with its reason and the limit it asked for, held to the user's ceiling", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.beatTool = { name: "wake_in_thread", input: { thread: " ring ", reason: " Tell part two. ", limit: "6h" } };
    script.sends = undefined; script.closing = "Done.";
    at(10);
    await wakeNow();
    expect(lastToolResult(await thread("wakes"))).toEqual({
      text: 'Shore will wake you in "ring" for up to 2 hours, once this turn is over and peggy has been quiet there for 10 minutes.', failed: false,
    });
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["main", "main"]);

    script.sends = "Part two: the gate opened."; script.closing = "Told part two.";
    at(11);
    await runtime.autonomy.runDue();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["main", "main", "ring", "ring"]);
    expect(turnsOf(script.wakes[2])).toEqual([
      ["user", wakeShown("12:11 PM", ["Nothing has been said in this thread yet.", wroteLast("11 minutes ago", 'your home thread "main"')], ['[You asked for this wake from "main" at Friday 2026-10-30 · 12:10 PM: Tell part two.]'], "2 hours", "105 minutes")],
    ]);
    expect((await thread("ring")).at(-1)?.content).toBe("Part two: the gate opened.");
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").at(-1)?.detail).toBe('Woken in "ring" by a hand-off from "main"');

    script.beatTool = { name: "wake_in_thread", input: { thread: "ring", reason: "Tell part three." } };
    script.sends = undefined; script.closing = "Done.";
    at(30);
    await wakeNow();
    expect(lastToolResult(await thread("wakes"))?.text).toBe('Shore will wake you in "ring" for up to 30 minutes, once this turn is over and peggy has been quiet there for 10 minutes.');
    script.beatTool = { name: "wake_in_thread", input: { thread: "main", reason: "And tell them." } };
    at(31);
    await runtime.autonomy.runDue();
    expect(turnsOf(script.wakes.at(-2)).at(-1)?.[1]).toContain("A wake here can run for up to 30 minutes. After 25 minutes,");
    expect(lastToolResult(await thread("wakes"))).toEqual({ text: "io: a wake can't be handed on from here", failed: true });
    expect(script.wakes).toHaveLength(8);
    at(32);
    await runtime.autonomy.runDue();
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
    expect(await refused({ thread: "nowhere", reason: "r" })).toBe('io: you have no thread "nowhere" to be woken in; `threads` lists the ones you have');
    expect(await refused({ thread: "main", reason: "r" })).toBe('io: you are in "main" now, so there is nothing to hand over');
    expect(await refused({ thread: "the ring", reason: "r" })).toContain("thread must be a thread's id, as `threads` lists it");
    expect(await refused({ thread: "  ", reason: "r" })).toContain("thread must be a thread's id, as `threads` lists it");
    expect(await refused({ thread: "ring", reason: "  " })).toContain("reason must be a non-empty string");
    expect(await refused({ thread: "ring", reason: "r", limit: "soon" })).toContain('limit must be a length of time, like "45m" or "2h"');
    expect(await refused({ thread: "ring", reason: "r", limit: "59s" })).toContain("limit can't be shorter than a minute");
    expect(await refused({ thread: "r", reason: "r" })).toBe('io: you have no thread "r" to be woken in; `threads` lists the ones you have');
    expect(await refused({ thread: "t".repeat(64), reason: "r" })).toBe(`io: you have no thread "${"t".repeat(64)}" to be woken in; \`threads\` lists the ones you have`);
    expect(await refused({ thread: "t".repeat(65), reason: "r" })).toStartWith("The call to wake_in_thread was not run because argument `thread` must NOT have more than 64 characters.");
    expect(await refused({ thread: "ring", reason: "r", urgent: true })).toStartWith("The call to wake_in_thread was not run because argument `urgent` is not allowed.");
    script.sends = undefined; script.closing = "Done.";
    at(20);
    await runtime.autonomy.runDue();
    expect(script.wakes).toEqual([]);

    script.replyTool = { name: "wake_in_thread", input: { thread: "ring", reason: "Tell the next part.", limit: "1m" } };
    await say("off you go");
    expect(lastToolResult(await thread("main"))).toEqual({
      text: 'Shore will wake you in "ring" for up to 1 minute, once this turn is over and peggy has been quiet there for 10 minutes.', failed: false,
    });
    await runtime.autonomy.runDue();
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

    script.sends = undefined; script.closing = "Done.";
    at(40);
    await runtime.autonomy.runDue();
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
    const waking = runtime.autonomy.runDue();
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
    script.sends = undefined; script.closing = "Done.";
    at(30);
    await runtime.autonomy.runDue();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring"]);
    const pickUp = turnsOf(script.wakes[0]).at(-1)?.[1] ?? "";
    expect(pickUp).toContain("\n\n[Your last wake here was stopped for User's message at Friday 2026-10-30 · 12:12 PM, after 1 round, before it had finished. Nothing from it was sent to User. Whatever it had already changed with its tools is still in place.]\n\n");
    expect(setOffBy(pickUp)).toEqual([
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:01 PM: Tell part two.]',
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:14 PM: Tell part three.]',
    ]);
  }, handOff());
});

test("a hand-off is refused when the character's triggers are switched off", async () => {
  await withCharacter(async ({ script, say, thread, runtime }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.replyTool = { name: "wake_in_thread", input: { thread: "ring", reason: "r" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: "io: peggy has your triggers switched off, so nothing would wake you", failed: true });
  }, (app) => {
    handOff()(app);
    app.triggers.enabled = false;
  });
});

test("a wake's turn can't be regenerated, and a wake in the home thread isn't taken for the user writing there", async () => {
  await withCharacter(async ({ runtime, script, say, regenerate, thread }) => {
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    at(2);
    await say("the beans are up", "garden");
    script.sends = "The lamp is lit."; script.closing = "Looked in.";
    runtime.autonomy.wakeFor("ada", { name: "lamp", reason: "Look in.", at: T0 + 60 * MINUTE, thread: "main" });
    at(60);
    await runtime.autonomy.runDue();
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
    await runtime.registry.createThread("ada", "study");
    await say("hello");
    script.sends = undefined; script.closing = "Done.";

    let held = hold();
    script.beatHeld = held;
    script.again = 1;
    at(10);
    expect(runtime.autonomy.wakeFor("ada", fired("show", 9, "ring"))).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", fired("show", 10, "ring"))).toBe("queued");
    let waking = runtime.autonomy.runDue();
    await held.started.promise;
    expect(turnsOf(script.wakes[0])).toEqual([["user", wakeShown("12:10 PM", ["Nothing has been said in this thread yet.", wroteLast("10 minutes ago", 'your home thread "main"')], [required(triggerFiredNote(new Texts(), fired("show", 10), zone))])]]);
    at(11);
    expect(runtime.autonomy.wakeFor("ada", fired("encore", 11, "ring"))).toBe("handed");
    expect(runtime.autonomy.wakeFor("ada", fired("lamp", 11))).toBe("queued");
    expect(runtime.autonomy.wakeFor("ada", fired("beans", 11, "garden"))).toBe("queued");
    await say("is the lamp lit?", "study");
    held.release.resolve();
    await waking;
    expect(where()).toEqual(["ring", "ring", "ring"]);
    expect(textOf(script.wakes[1] as SidecarRequest)).toEndWith(
      `${required(triggerFiredNote(new Texts(), fired("encore", 11), zone))}\n\n[User has just written to you, at Friday 2026-10-30 · 12:11 PM, while this wake is running. Another turn of you is answering them, and it knows this wake is running.]`,
    );
    expect(textOf(script.replies.at(-1) as SidecarRequest)).toEndWith(
      `[A wake of yours in "ring" has been running since Friday 2026-10-30 · 12:10 PM. It can't see this conversation. It is only told that a message arrived.]\nis the lamp lit?`,
    );
    expect((await thread("ring")).some((message) => message.content.includes("Shore stopped it"))).toBe(false);

    at(12);
    await runtime.autonomy.runDue();
    expect(where().slice(3)).toEqual(["main", "main", "garden", "garden"]);
    expect(textOf(script.wakes[3] as SidecarRequest)).toContain(required(triggerFiredNote(new Texts(), fired("lamp", 11), zone)));
    expect(textOf(script.wakes[3] as SidecarRequest)).not.toContain("beans");
    expect(setOffBy(turnsOf(script.wakes[5]).at(-1)?.[1])).toEqual([required(triggerFiredNote(new Texts(), fired("beans", 11), zone))]);

    script.wakes.length = 0;
    held = hold();
    script.beatHeld = held;
    script.again = 2;
    at(40);
    expect(runtime.autonomy.wakeFor("ada", fired("show", 40, "ring"))).toBe("queued");
    waking = runtime.autonomy.runDue();
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
    await runtime.autonomy.runDue();
    expect(where()).toEqual(["ring"]);
    at(51);
    await runtime.autonomy.runDue();
    expect(where()).toEqual(["ring", "ring", "ring"]);
    const pickUp = turnsOf(script.wakes[1]).at(-1)?.[1] ?? "";
    expect(turnsOf(script.wakes[1])).toHaveLength(1);
    expect(pickUp).toContain("[Your last wake here was stopped for User's message at Friday 2026-10-30 · 12:41 PM, after 1 round, before it had finished.");
    expect(setOffBy(pickUp)).toEqual([
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:41 PM:  is due]',
      required(triggerFiredNote(new Texts(), fired("encore", 41), zone)),
      required(triggerFiredNote(new Texts(), fired("show", 45), zone)),
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
    script.sends = undefined; script.closing = "Done.";
    const held = hold();
    script.beatHeld = held;
    at(9);
    expect(runtime.autonomy.wakeFor("ada", show("the early show", 9))).toBe("queued");
    at(10);
    expect(runtime.autonomy.wakeFor("ada", show("the late show", 10))).toBe("queued");
    const waking = runtime.autonomy.runDue();
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
    await runtime.autonomy.runDue();
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

test("a wake doesn't bring a thread nearer its compaction, which counts the turns the user wrote, and a side thread grown long by a wake compacts once the wake is over", async () => {
  const long = (app: AppConfig): void => {
    app.compaction.enabled = true;
    app.compaction.keep_recent_turns = 0;
    app.compaction.min_turns = 1;
    app.compaction.max_turns = 2;
  };
  const compactions = (data: string): number => archivedIn(data, "ring");
  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await runtime.registry.createThread("ada", "ring", { compaction: true });
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    script.sends = undefined; script.closing = "Told part one.";
    for (const minute of [20, 21]) {
      runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minute * MINUTE, thread: "ring" });
      at(minute);
      await runtime.autonomy.runDue();
      await stopBackgroundCompactions(data);
    }
    expect(compactions(data)).toBe(0);
    expect((await thread("ring")).filter(isWakeOpener)).toHaveLength(2);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind !== "tool_use").map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["message_skipped", "Wake completed — no message sent"],
    ]);

    const held = hold();
    script.beatHeld = held;
    script.again = 1;
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 40 * MINUTE, thread: "ring" });
    at(40);
    const waking = runtime.autonomy.runDue();
    await held.started.promise;
    const reply = hold();
    script.held = reply;
    const asking = say("wait", "ring");
    held.release.resolve();
    await waking;
    await reply.started.promise;
    expect(compactions(data)).toBe(0);
    expect((await thread("ring")).at(-2)?.content).toStartWith("[User wrote here while this wake was running");
    reply.release.resolve();
    await asking;
    await stopBackgroundCompactions(data);
    expect(compactions(data), "the user's second turn there").toBe(1);
    expect(await thread("ring")).toEqual([]);
  }, long);

  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await say("hello");
    script.sends = undefined; script.closing = "Looked in.";
    runtime.autonomy.wakeFor("ada", { name: "lamp", reason: "r", at: T0 + 20 * MINUTE, thread: "main" });
    at(20);
    await runtime.autonomy.runDue();
    await stopBackgroundCompactions(data);
    expect(compactions(data)).toBe(0);
    expect(await thread("main")).toHaveLength(4);
  }, long);

  await withCharacter(async ({ runtime, script, data, say, thread }) => {
    await runtime.registry.createThread("ada", "ring", { compaction: true });
    await say("tell me a story in parts", "ring");
    script.sends = undefined; script.closing = "Told part one.";
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    await runtime.autonomy.runDue();
    await stopBackgroundCompactions(data);
    expect(compactions(data), "by the size of the thread, which the wake itself was never sent").toBe(1);
    expect(await thread("ring")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind !== "tool_use").map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["message_skipped", "Wake completed — no message sent"],
    ]);
  }, (app) => {
    long(app);
    app.compaction.max_turns = 0;
    app.compaction.max_context_tokens = 20;
  });
});

interface WakesIn {
  wake: (minute: number, closing: string, sends?: string) => Promise<void>;
  openers: () => Promise<string[]>;
}

async function wakesIn(name: string, compaction: boolean, configure: (app: AppConfig) => void, run: (h: Harness, wakes: WakesIn) => Promise<void>): Promise<void> {
  await withCharacter(async (h) => {
    await h.runtime.registry.createThread("ada", name, { compaction });
    await h.say("hello");
    await run(h, {
      wake: async (minute, closing, sends) => {
        h.script.closing = closing;
        h.script.sends = sends;
        h.runtime.autonomy.wakeFor("ada", { name: "show", reason: `at ${String(minute)}`, at: T0 + minute * MINUTE, thread: name });
        at(minute);
        await h.runtime.autonomy.runDue();
        await stopBackgroundCompactions(h.data);
      },
      openers: async () => (await h.thread(name)).filter(isWakeOpener).map((message) => /fired at [^:]+:\d\d [AP]M: at (\d+)\]/.exec(message.content)?.[1] ?? ""),
    });
  }, (app) => {
    app.compaction.enabled = true;
    app.compaction.min_turns = 1;
    app.triggers.max_idle_wakes = 10;
    configure(app);
  });
}

test("a thread holding nothing but the character's own wakes is put away once it would compact, down to the newest wake", async () => {
  await wakesIn("log", true, (app) => {
    app.compaction.keep_recent_turns = 0;
    app.compaction.max_turns = 2;
  }, async ({ thread, script }, { wake, openers }) => {
    await wake(10, "One.");
    expect(await openers()).toEqual(["10"]);
    await wake(20, "Two.");
    expect(await openers()).toEqual(["20"]);
    expect((await thread("log")).map((message) => message.role)).toEqual(["user", "system"]);
    script.wakes.length = 0;
    await wake(30, "Three.");
    expect(await openers()).toEqual(["30"]);
    expect(setOffBy(turnsOf(script.wakes[0]).at(-1)?.[1])).toEqual(['[Your trigger "show" fired at Friday 2026-10-30 · 12:30 PM: at 30]']);
    expect(turnsOf(script.wakes[0]).at(-1)?.[1]).not.toContain("Two.");
  });
});

test("what Shore keeps to undo a wake's file changes is kept with the message it sent, or with its working when it sent nothing, and goes once that is no longer in its thread", async () => {
  await wakesIn("log", true, (app) => {
    app.compaction.keep_recent_turns = 0;
    app.compaction.max_turns = 2;
    app.tools.enabled = [...app.tools.enabled, "bash"];
  }, async ({ runtime, script, thread }, { wake, openers }) => {
    const turns = workspaceTurnsFor(runtime.config.dirs, "ada", characterWorkspace(runtime.config, "ada"));
    const wrote = async (minute: number, closing: string, keptIn: string, sends?: string): Promise<string> => {
      script.beatTool = { name: "bash", input: { command: `printf 'page' > at-${String(minute)}.md` } };
      await wake(minute, closing, sends);
      return replyVersions(await thread(keptIn)).at(-1) ?? "";
    };
    const working = await wrote(10, "Wrote a page.", "wakes");
    expect(await recordedTurns(turns, "wakes", [working])).toEqual([working]);
    expect(await recordedTurns(turns, "log", replyVersions(await thread("log")))).toEqual([]);
    const first = await wrote(20, "Done.", "log", "A page.");
    const second = await wrote(30, "Done.", "log", "Another page.");
    expect(await openers()).toEqual(["30"]);
    expect(await recordedTurns(turns, "log", [first, second])).toEqual([first, second]);
    const third = await wrote(40, "Done.", "log", "One more page.");
    expect(await openers()).toEqual(["40"]);
    expect(await recordedTurns(turns, "log", [first, second, third])).toEqual([second, third]);
  });
});

test("wakes from before the user first wrote in a thread are put away the same way, and what was said from then on is left for a compaction", async () => {
  await wakesIn("log", true, (app) => {
    app.compaction.keep_recent_turns = 0;
    app.compaction.max_turns = 4;
  }, async ({ thread, say }, { wake, openers }) => {
    await wake(10, "One.");
    await wake(12, "Two.");
    at(15);
    await say("how is it going?", "log");
    expect(await openers()).toEqual(["10", "12"]);
    await wake(30, "Three.");
    expect(await openers()).toEqual(["30"]);
    expect((await thread("log")).slice(0, 2).map((message) => message.content)).toEqual(["how is it going?", "reply to: how is it going?"]);
  });

  await wakesIn("log", true, (app) => {
    app.compaction.keep_recent_turns = 0;
    app.compaction.max_turns = 0;
    app.compaction.max_context_tokens = 1_000;
  }, async ({ thread, say }, { wake, openers }) => {
    await wake(10, "One.");
    await wake(12, "Two.");
    at(15);
    await say("how is it going?", "log");
    expect(await openers()).toEqual(["10", "12"]);
    await wake(30, "Done.", "The keeper's log runs on. ".repeat(400).trim());
    expect(await openers()).toEqual(["30"]);
    expect((await thread("log")).slice(0, 2).map((message) => message.content)).toEqual(["how is it going?", "reply to: how is it going?"]);
    expect((await thread("log")).at(-1)?.content).toStartWith("The keeper's log runs on.");
  });
});

test("in a thread whose compaction is off a wake's turns stay while there is room, and when it runs out the oldest turns are put away", async () => {
  await wakesIn("ring", false, (app) => {
    app.compaction.keep_recent_turns = 1;
    app.compaction.max_turns = 2;
  }, async ({ thread, say }, { wake, openers }) => {
    await wake(10, "One.");
    await wake(20, "Two.");
    await wake(30, "Three.");
    expect(await openers()).toEqual(["10", "20", "30"]);

    at(35);
    await say(`${"the lamp ".repeat(80_000)}\nwhich lamp?`, "ring");
    expect((await thread("ring")).map((message) => message.content.slice(-11))).toEqual(["which lamp?", "which lamp?"]);
    await wake(50, "Four.");
    expect(await openers()).toEqual(["50"]);
    expect((await thread("ring")).map((message) => message.role)).toEqual(["user", "system"]);
  });
});

function keepNothing(app: AppConfig): void {
  app.compaction.keep_recent_turns = 0;
  app.compaction.min_turns = 1;
}

async function compactByHand(runtime: ShoreRuntime, thread: string): Promise<void> {
  await runCompactionPass("ada", { config: runtime.config }, { thread });
}

test("after a compaction that kept nothing, the next reply and the request rebuilt from disk open with how long it had been", async () => {
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
    await runtime.autonomy.runDue();
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
      await runtime.autonomy.runDue();
      return systemOf(script.wakes.find((request) => request.context?.thread === thread));
    };
    await mkdir(join(workspace, "notes"), { recursive: true });
    await writeFile(join(workspace, "notes", "ring.md"), "the fox is at the gate");
    await runtime.registry.createThread("ada", "ring", { pins: ["notes/ring.md"] });
    await say("hello");
    script.sends = undefined; script.closing = "Done.";

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
    app.triggers.max_idle_wakes = 10;
  });
});

test("the message a wake sends in a side thread is announced, and deleting it puts back the files that wake changed", async () => {
  await withCharacter(async ({ runtime, script, workspace, say, thread, command }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    script.beatTool = { name: "bash", input: { command: "printf 'part one' > story.md" } };
    script.sends = "Part one is written."; script.closing = "Wrote it down.";
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    await runtime.autonomy.runDue();
    expect(announced).toEqual([["autonomous_message", "Shore - ada", "Part one is written.", undefined]]);
    expect(await Bun.file(join(workspace, "story.md")).text()).toBe("part one");

    const sent = (await thread("ring")).at(-1);
    expect(sent?.content).toBe("Part one is written.");
    await command("delete", { refs: sent?.msg_id }, "ring");
    expect(existsSync(join(workspace, "story.md"))).toBe(false);
  }, (app) => { app.tools.enabled = [...app.tools.enabled, "bash"]; });
});

test("a wake in any thread opens with the user's statuses while any is on and with none of what a wake elsewhere ended on, and is made with the keys Shore was started with", async () => {
  await withCharacter(async ({ runtime, script, data, say, wakeNow }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    script.sends = undefined; script.closing = "The log is read up to March.";
    at(5);
    await wakeNow();
    changePresence(data, { on: ["home"] }, T0 + 2 * MINUTE);
    changePresence(data, { on: ["asleep"] }, T0 + 6 * MINUTE);
    unsetTestEnv(KEY_ENV);
    script.wakes.length = 0;
    script.sends = undefined; script.closing = "Done.";
    for (const minutes of [20, 40]) {
      runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + minutes * MINUTE, thread: "ring" });
      at(minutes);
      await runtime.autonomy.runDue();
    }
    const [first, , second] = script.wakes;
    expect(turnsOf(first)).toEqual([["user", wakeShown("12:20 PM", [
      "Nothing has been said in this thread yet.",
      wroteLast("20 minutes ago", 'your home thread "main"'),
      '[User\'s status: "home" for 18 minutes, "asleep" for 14 minutes]',
    ], ['[Your trigger "show" fired at Friday 2026-10-30 · 12:20 PM: r]'])]]);
    expect(first?.api_key).toBe("fixture-key");
    expect(turnsOf(second)).toEqual([["user", wakeShown("12:40 PM", [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("40 minutes ago", 'your home thread "main"'),
      '[User\'s status: "home" for 38 minutes, "asleep" for 34 minutes]',
    ], ['[Your trigger "show" fired at Friday 2026-10-30 · 12:40 PM: r]'])]]);
  });
});

test("a wake whose trigger names no thread runs in home, is shown what was said there and is told where it is, word for word, and runs for the limit its trigger asks for", async () => {
  await withCharacter(async ({ runtime, script, workspace, say, thread }) => {
    await writeFile(join(workspace, "TRIGGERS.toml"), '[tide]\nevery = "10m"\nreason = "Look at the tide."\nlimit = "45m"\n\n[long]\nevery = "10m"\nreason = "Stay a while."\nlimit = "9h"\ncooldown = "50m"\n');
    await say("hello");
    at(1);
    await runtime.triggers.tick();
    script.sends = undefined; script.closing = "The tide is out.";
    await fires(runtime, 11);

    const tide = '[Your trigger "tide" fired at Friday 2026-10-30 · 12:11 PM: Look at the tide.]';
    const long = '[Your trigger "long" fired at Friday 2026-10-30 · 12:11 PM: Stay a while.]';
    expect(script.wakes.map((request) => [request.model, request.context?.call_type, request.context?.thread])).toEqual([
      ["claude-fixture", "wake", "main"],
      ["claude-fixture", "wake_tool_loop", "main"],
    ]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", homeWakeShown("12:11 PM", [
      `The last of what was said in this thread:\n\n${said("User", "12:00 PM", "hello")}\n\n${said("you", "12:00 PM", "reply to: hello")}`,
      wroteLast("11 minutes ago"),
    ], [tide, long], "2 hours", "105 minutes")]]);
    expect(stored(await thread("main")).slice(2)).toEqual([
      ["user", "autonomous", wakeSeenLater(tide, long)],
      ["system", "autonomous", 'This wake\'s working is in "Wakes": 1 tool call.'],
    ]);
    expect(stored(await thread("wakes"))).toEqual([
      ["user", "autonomous", homeWakeShown("12:11 PM", [], [tide, long], "2 hours", "105 minutes").replace("[wake]", '[wake in "main"]')],
      ["assistant", "", ""],
      ["user", "", "<SOUL.md>"],
      ["assistant", "", "The tide is out."],
    ]);

    script.wakes.length = 0;
    await fires(runtime, 21);
    expect(turnsOf(script.wakes[0])).toEqual([["user", homeWakeShown("12:21 PM", [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("21 minutes ago"),
    ], ['[Your trigger "tide" fired at Friday 2026-10-30 · 12:21 PM: Look at the tide.]'], "45 minutes", "37 minutes")]]);
  }, (app) => {
    app.triggers.wake_cooldown = ConfigDuration.fromSecs(60);
    app.triggers.max_idle_wakes = 10;
  });
});

test("the model and settings the user chose for wakes hold in whichever thread a wake runs", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, command }) => {
    await runtime.registry.createThread("ada", "ring");
    expect((await command("set_model_setting", { key: "reasoning_effort", value: "low", background_task: "wake" })).type).toBe("command_output");
    await say("hello");
    await wakeNow();
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0, thread: "ring" });
    await runtime.autonomy.runDue();
    expect(script.wakes.map((request) => [request.context?.thread, request.model, request.provider_options?.reasoning_effort])).toEqual([
      ["main", "claude-pinned", "low"], ["main", "claude-pinned", "low"], ["ring", "claude-pinned", "low"], ["ring", "claude-pinned", "low"],
    ]);
    expect(script.replies.map((request) => request.model)).toEqual(["claude-fixture"]);
    const asked = script.wakes[0];
    expect((asked?.system ?? []).map((block) => block.text).join("\n")).toContain("Ada");
    expect((asked?.tools ?? []).map((tool) => tool.name)).toEqual(["read", "send_message"]);
  }, (app) => {
    app.triggers.model = "pinned";
    app.triggers.max_idle_wakes = 10;
  });
});

test("a model chosen for wakes that isn't in the catalog, or can't be called, leaves wakes on the chat model", async () => {
  await withCharacter(async ({ script, say, wakeNow }) => {
    await say("hello");
    await wakeNow();
    expect(script.wakes.map((request) => request.model)).toEqual(["claude-fixture", "claude-fixture"]);
  }, (app) => { app.triggers.model = "missing"; });

  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    const pinned = runtime.config.models.chat.get("chat.pinned");
    if (pinned === undefined) throw new Error("no pinned model");
    runtime.config.models.chat.set("chat.keyless", { ...pinned, name: "keyless", qualifiedName: "chat.keyless", apiKeyEnv: "SHORE_NO_SUCH_KEY" });
    await say("hello");
    await wakeNow();
    expect(script.wakes.map((request) => request.model)).toEqual(["claude-fixture", "claude-fixture"]);
    expect((await thread("main")).at(-1)?.content).toBe("I found the keeper's log.");
  }, (app) => { app.triggers.model = "keyless"; });
});

test("a model chosen for wakes is used, and takes their settings, even when its provider's list keeps it out of the pickers", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, command }) => {
    await say("hello");
    runtime.registry.setRuntimeEffectiveConfig("ada", {
      ...runtime.registry.effectiveConfig("ada"),
      providers: ProviderRegistry.fromSection({ anthropic: { sdk: "anthropic", api_key_env: KEY_ENV, discover: true, ignore_models: ["claude-tucked-*"] } }),
    });
    await wakeNow();
    expect(script.wakes.map((request) => request.model)).toEqual(["claude-tucked-away", "claude-tucked-away"]);
    expect(await command("model_settings", { background_task: "wake" })).toMatchObject({ type: "command_output", data: { model: "anthropic:claude-tucked-away" } });
  }, (app) => { app.triggers.model = "anthropic:claude-tucked-away"; });
});

test("a wake set off by a trigger can hand on from whichever thread it runs in, and one that was itself handed over can't, even when a trigger joined it", async () => {
  await withCharacter(async ({ runtime, script, say, thread }) => {
    await runtime.registry.createThread("ada", "ring");
    await runtime.registry.createThread("ada", "garden");
    await say("hello");
    script.sends = undefined; script.closing = "Done.";
    const refused = { text: "io: a wake can't be handed on from here", failed: true };

    at(10);
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "Tell part one.", at: T0 + 10 * MINUTE, thread: "ring" });
    script.beatTool = { name: "wake_in_thread", input: { thread: "garden", reason: "Water the beans." } };
    await runtime.autonomy.runDue();
    expect(lastToolResult(await thread("wakes"))).toEqual({
      text: 'Shore will wake you in "garden" for up to 30 minutes, once this turn is over and peggy has been quiet there for 10 minutes.', failed: false,
    });

    at(11);
    script.beatTool = { name: "wake_in_thread", input: { thread: "ring", reason: "And back." } };
    await runtime.autonomy.runDue();
    expect(script.wakes.map((request) => request.context?.thread)).toEqual(["ring", "ring", "garden", "garden"]);
    expect(lastToolResult(await thread("wakes"))).toEqual(refused);

    at(12);
    runtime.autonomy.wakeFor("ada", { name: "weeds", reason: "Pull the weeds.", at: T0 + 12 * MINUTE, thread: "garden" });
    runtime.autonomy.requestWake("ada", { name: "", from: "main", reason: "Tie up the beans.", at: T0 + 12 * MINUTE, thread: "garden" }, false);
    script.beatTool = { name: "wake_in_thread", input: { thread: "ring", reason: "And back." } };
    await runtime.autonomy.runDue();
    expect(setOffBy(turnsOf(script.wakes.at(-2)).at(-1)?.[1])).toHaveLength(2);
    expect(lastToolResult(await thread("wakes"))).toEqual(refused);
    at(13);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(6);
  }, handOff());
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
    await runtime.autonomy.runDue();
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
    await runtime.autonomy.runDue();
    expect(script.wakes).toEqual([]);
    expect(await thread("ring")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["budget_paused", 'Wake paused before round 0 — budget "beats" is over its month limit ($0.00/$0.00); resets 2026-11-01 12:00 AM'],
    ]);
  }, (app) => {
    app.budgets = [{
      name: "beats", period: "month", cost_usd: 0, warn_fractions: [], limit_action: "block", character: undefined, provider: undefined,
      api_key: undefined, model: undefined, call_type: "wake", usage_kinds: [], allow_compaction: false,
      reset_hour: undefined, reset_day_of_week: undefined, reset_day_of_month: undefined, pace_period: undefined,
      pace_action: undefined, pace_warn_fractions: undefined, warn_action: undefined, pace_warn_action: undefined,
    }];
  });
});

test("a wake started by hand runs at the next look, one for a dormant character is dropped with word of how to change that, and making the character active again starts nothing by itself", async () => {
  await withCharacter(async ({ runtime, script, say, command }) => {
    const answered = async (name: string): Promise<unknown> => {
      const reply = await command(name, {});
      return reply.type === "command_output" ? reply.data : reply;
    };
    expect(await answered("session_activate")).toEqual({ character: "ada", registered: true, keepalive: { status: "off" }, triggers: "Active" });
    await say("hello");
    at(1);
    expect(await answered("wake_now")).toEqual({ status: "queued", character: "ada" });
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);

    expect(await answered("set_dormant")).toEqual({ status: "dormant", character: "ada" });
    expect(await answered("session_activate")).toEqual({ character: "ada", registered: false, keepalive: { status: "off" }, triggers: "Dormant" });
    expect(await answered("wake_now")).toEqual({
      status: "queued", character: "ada",
      warning: "ada is dormant, so nothing wakes them and this wake is dropped. Run `shore debug set_active` first.",
    });
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);

    expect(await answered("set_active")).toEqual({ status: "active", character: "ada" });
    expect(runtime.autonomy.status("ada")?.state).toBe("Active");
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);
  });
});

test("with daemon.cache_forensics on a reply's request says where to keep what was sent, and with it off it says nothing", async () => {
  const asked = async (forensics: boolean): Promise<unknown[]> => {
    const seen: unknown[] = [];
    await withCharacter(async ({ runtime, script, say }) => {
      await say("hello");
      seen.push(script.replies[0]?.context?.forensics_dir, runtime.config.dirs.cache);
    }, (app) => { app.daemon.cache_forensics = forensics; });
    return seen;
  };
  const [on, cacheDir] = await asked(true);
  expect(on).toBe(cacheDir);
  expect(typeof cacheDir).toBe("string");
  expect((await asked(false))[0]).toBeUndefined();
});

test("a wake for a character left with no chat model at all is skipped, and the log says so", async () => {
  await withCharacter(async ({ runtime, script, say, thread, wakeNow }) => {
    await say("hello");
    runtime.config.models.chat.clear();
    at(20);
    await wakeNow();
    expect(script.wakes).toEqual([]);
    expect((await thread("main")).map((message) => message.content)).toEqual(["hello", "reply to: hello"]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "main" by a start by hand'],
      ["call_failed", "Wake skipped: no chat model resolves"],
    ]);
  });
});

test("the ledger records which triggers set off each of a wake's calls, a wake started by hand has none, and usage can be grouped by trigger", async () => {
  await withCharacter(async ({ runtime, data, say, wakeNow, command }) => {
    await say("hello");
    at(20);
    runtime.autonomy.wakeFor("ada", { name: "tide-table", reason: "the tide is out", at: T0 + 19 * MINUTE });
    runtime.autonomy.wakeFor("ada", { name: "lamp", reason: "the lamp is low", at: T0 + 20 * MINUTE });
    runtime.autonomy.wakeFor("ada", { name: "lamp", reason: "the lamp is lower", at: T0 + 20 * MINUTE });
    await runtime.autonomy.runDue();
    at(200);
    await wakeNow();

    const ledger = new Database(join(data, "shore.db"), { readonly: true });
    try {
      expect(ledger.query("SELECT call_type, wake_trigger FROM calls ORDER BY id").values()).toEqual([
        ["message", null],
        ["wake", "tide-table, lamp"], ["wake_tool_loop", "tide-table, lamp"],
        ["wake", null], ["wake_tool_loop", null],
      ]);
    } finally {
      ledger.close();
    }
    const grouped = await command("usage", { group_by: "trigger" });
    if (grouped.type !== "command_output") throw new Error(`usage answered ${grouped.type}`);
    const report = grouped.data as { mode: string; dimension: string; summary: { group: string; call_count: number }[] };
    expect([report.mode, report.dimension, Object.fromEntries(report.summary.map((row) => [row.group, row.call_count]))]).toEqual(["summary_by", "trigger", { none: 3, "tide-table, lamp": 2 }]);
  });
});

test("each round of a wake is kept for the trace of what wakes thought and did", async () => {
  await withCharacter(async ({ runtime, say, wakeNow }) => {
    await say("hello");
    at(1);
    await wakeNow();
    const kept = runtime.callStore?.queryTranscripts("wake", "ada", 100).map((row) => [row.call_type, row.iteration, row.finish_reason]);
    expect(kept?.reverse()).toEqual([
      ["wake", 0, "tool_use"],
      ["wake_tool_loop", 1, "end_turn"],
    ]);
  });
});

test("the log shows each tool a wake called with the start of what came back", async () => {
  await withCharacter(async ({ runtime, script, workspace, say, wakeNow }) => {
    await writeFile(join(workspace, "tides.md"), "high water ".repeat(40));
    await say("hello");
    script.sends = undefined;
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

test("a wake whose model call ends in an error is logged as failed on that round, with the reason the provider gave", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow }) => {
    await say("hello");
    script.finishes = ["error"];
    at(1);
    await wakeNow();

    expect(script.wakes).toHaveLength(2);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "call_failed").map((event) => event.detail)).toEqual([
      "Model call failed on round 1 — Wake generation ended with error",
    ]);
  });
});

test("a wake's message with a picture Shore can't find is refused as it is sent, with the picture's name, and nothing is posted or asked for again", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    script.sends = "The lamp tonight\n![[missing.png]]"; script.closing = "Done.";
    await say("hello");
    at(1);
    await wakeNow();

    expect(script.wakes).toHaveLength(2);
    const refused = (await thread("wakes")).flatMap((message) => message.content_blocks).flatMap((block) => block.type === "tool_result" && block.is_error === true && typeof block.content === "string" ? [block.content] : []);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toStartWith("io: not sent: these pictures in it could not be sent:\n- ![[missing.png]]: ");
    expect(refused[0]).toEndWith("\nSend it again with the names fixed.");
    expect((await thread("main")).filter((message) => message.role === "assistant" && message.origin === "autonomous")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).at(-1)).toEqual(["message_skipped", "Wake completed — no message sent"]);
  });
});

test("a wake whose tool call breaks off leaves its thread with an answer to that call, and the log says what went wrong", async () => {
  await withCharacter(async ({ runtime, script, say, thread, wakeNow }) => {
    await say("hello");
    script.sends = undefined;
    const broken = spyOn(execute, "runToolUse").mockRejectedValueOnce(new Error("the tool runner broke"));
    try {
      at(1);
      await wakeNow();
    } finally {
      broken.mockRestore();
    }
    expect(script.wakes).toHaveLength(1);
    const shape = (messages: readonly Message[]): unknown[] => messages.map((message) => [message.role, message.content_blocks.map((block) => block.type === "tool_result" ? [block.type, block.is_error, block.content] : block.type)]);
    expect(shape((await thread("main")).slice(2))).toEqual([
      ["user", ["text"]],
      ["system", ["text"]],
      ["system", ["text"]],
    ]);
    expect((await thread("main")).at(-2)?.shown_later).toBe('[Your working in this wake is in your thread "wakes", not here: 1 tool call, ending with `read`. It ended before you had finished.]');
    expect((await thread("main")).at(-1)?.content).toBe('[This wake failed here, before it had finished, with this error: "the tool runner broke".]');
    expect(shape(await thread("wakes"))).toEqual([
      ["user", ["text"]],
      ["assistant", ["tool_use"]],
      ["user", [["tool_result", true, "The wake ended before this tool returned a result."]]],
      ["system", ["text"]],
    ]);
    expect((await thread("main")).filter((message) => message.role === "assistant" && message.origin === "autonomous")).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "main" by a start by hand'],
      ["call_failed", "Model call failed on round 0 — the tool runner broke"],
    ]);
  });
});

test("a wake whose thread the user edits while it runs writes nothing more there", async () => {
  await withCharacter(async ({ runtime, script, say, thread, command }) => {
    await runtime.registry.createThread("ada", "ring");
    await say("hello");
    at(1);
    await say("tell me a story in parts", "ring");
    const asked = (await thread("ring"))[0];
    const held = hold();
    script.beatHeld = held;
    script.sends = "Part one."; script.closing = "Told part one.";
    runtime.autonomy.wakeFor("ada", { name: "show", reason: "r", at: T0 + 20 * MINUTE, thread: "ring" });
    at(20);
    const waking = runtime.autonomy.runDue();
    await held.started.promise;
    const deleting = command("delete", { refs: asked?.msg_id }, "ring");
    held.release.resolve();
    await waking;
    await deleting;
    expect(stored(await thread("ring"))).toEqual([
      ["assistant", "", "reply to: tell me a story in parts"],
      ["user", "autonomous", wakeSeenLater('[Your trigger "show" fired at Friday 2026-10-30 · 12:20 PM: r]')],
    ]);
    expect(stored(await thread("wakes")).map(([role]) => role)).toEqual(["user"]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "ring" by trigger "show"'],
      ["call_failed", 'Wake in "ring" stopped: the thread was changed while it ran'],
    ]);
  });
});

test("the wakes thread is for reading: nothing is sent or regenerated there, it is never home or compacted, no wake runs there, the character's list says what it is, and the next wake makes it again once it is archived", async () => {
  await withCharacter(async ({ runtime, script, say, regenerate, wakeNow, thread, command }) => {
    await say("hello");
    script.sends = undefined; script.closing = "Done.";
    at(10);
    await wakeNow();
    const listed = await command("list_threads", {});
    expect(listed.type === "command_output" ? (listed.data as ThreadListing).threads.map((view) => [view.id, view.label, view.wakes, view.compaction]) : listed).toEqual([
      ["main", undefined, undefined, true],
      ["wakes", "Wakes", true, false],
    ]);

    const refused = "\"wakes\" is where Shore keeps the working from ada's wakes, so you can read it but not write there. Write to ada in another thread.";
    expect(String(await rejectionOf(say("hi", "wakes")))).toBe(`WakesThreadError: ${refused}`);
    expect(String(await rejectionOf(regenerate("wakes")))).toBe(`WakesThreadError: ${refused}`);
    expect(await command("thread_home", { name: "wakes" })).toMatchObject({ type: "error", message: 'thread "wakes" is where Shore keeps ada\'s working from wakes, so it can\'t be home' });
    expect(await command("thread_compaction", { name: "wakes", compaction: true })).toMatchObject({ type: "error", message: 'thread "wakes" is where Shore keeps ada\'s working from wakes, and it is never compacted' });
    expect(await command("thread_compaction", { name: "wakes", compaction: false })).toMatchObject({ type: "command_output" });
    expect(String(await rejectionOf(compactByHand(runtime, "wakes")))).toBe('CompactionError: "wakes" is where Shore keeps the working from ada\'s wakes. It is only a log, so it is never compacted');
    expect(await command("compact", {}, "wakes")).toMatchObject({ type: "error", code: "invalid_request" });
    expect(runtime.registry.homeThread("ada")).toBe("main");

    script.replyTool = { name: "wake_in_thread", input: { thread: "wakes", reason: "Look back." } };
    at(11);
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: 'io: "wakes" is where Shore keeps the working from your wakes, so no wake runs there', failed: true });
    script.replyTool = { name: "threads", input: { action: "list" } };
    await say("which threads do you have?");
    expect(String(lastToolResult(await thread("main"))?.text)).toContain('\n\nwakes "Wakes" (where Shore keeps the working from your wakes) · compaction off\n');

    script.wakes.length = 0;
    runtime.autonomy.wakeFor("ada", { name: "look", reason: "r", at: T0 + 30 * MINUTE, thread: "wakes" });
    at(30);
    await runtime.autonomy.runDue();
    expect(script.wakes).toEqual([]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).at(-1)).toEqual(["call_failed", 'Wake skipped: "wakes" keeps the working from wakes']);

    expect(await command("archive_thread", { name: "wakes" })).toMatchObject({ type: "command_output" });
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main"]);
    expect(runtime.registry.wakesThread("ada")).toBeUndefined();
    at(40);
    await wakeNow();
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "wakes"]);
    expect((await thread("wakes")).filter(isWakeOpener).map((message) => message.content.split("\n")[0])).toEqual(['[wake in "main"]']);
  }, handOff("threads"));
});

test("a character's own thread called wakes is left alone, and Shore keeps the working in one named after it", async () => {
  await withCharacter(async ({ runtime, say, wakeNow, thread }) => {
    await runtime.registry.createThread("ada", "wakes", { label: "Mine" });
    await say("hello");
    at(10);
    await wakeNow();
    expect(runtime.registry.listThreads("ada").map((record) => [record.id, record.label])).toEqual([["main", undefined], ["wakes", "Mine"], ["wakes-2", "Wakes"]]);
    expect(runtime.registry.wakesThread("ada")).toBe("wakes-2");
    expect(await thread("wakes")).toEqual([]);
    expect((await thread("wakes-2")).map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect((await thread("main")).at(-2)?.content).toBe('This wake\'s working is in "Wakes": 2 tool calls.');
    expect((await thread("main")).at(-2)?.shown_later).toStartWith('[Your working in this wake is in your thread "wakes-2", not here:');
    await say("hi", "wakes");
    expect((await thread("wakes")).map((message) => message.content)).toEqual(["hi", "reply to: hi"]);
  });
});

test("a wake whose first call fails leaves how it opened and a line saying it failed with what error, in its thread and its working thread, and the next wake there is told", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread }) => {
    await say("hello");
    script.fails = new Error("overloaded");
    const quiet = spyOn(shoreLog, "error").mockImplementation(() => {});
    try {
      at(10);
      await wakeNow();
    } finally {
      quiet.mockRestore();
    }
    const failed = '[This wake failed here, before it had finished, with this error: "overloaded".]';
    expect(stored((await thread("main")).slice(2))).toEqual([["user", "autonomous", wakeSeenLater(byHand("12:10 PM"))], ["system", "autonomous", failed]]);
    expect(stored(await thread("wakes")).map(([role, origin, content]) => [role, origin, role === "system" ? content : ""])).toEqual([["user", "autonomous", ""], ["system", "autonomous", failed]]);
    expect(runtime.autonomy.log("ada", 100).map((event) => event.kind).slice(-2)).toEqual(["tick_fired", "call_failed"]);

    script.wakes.length = 0;
    at(20);
    await wakeNow();
    expect(turnsOf(script.wakes[0]).at(-1)?.[1]).toContain("\n\n[Your last wake here failed at Friday 2026-10-30 · 12:10 PM, after 0 rounds, before it had finished, with this error: \"overloaded\". Nothing from it was sent to User. Whatever it had already changed with its tools is still in place.]\n\n");
  });
});

test("a wake whose working can't be kept still runs to its end and posts what it sent, and the log says why the working is missing", async () => {
  await withCharacter(async ({ runtime, say, wakeNow, thread }) => {
    await say("hello");
    at(10);
    await wakeNow();
    const kept = await runtime.registry.getOrCreate("ada", "wakes");
    const before = kept.messages().length;
    const full = spyOn(kept, "appendMessage").mockRejectedValue(new Error("the disk is full"));
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    let warnings: string[];
    try {
      at(20);
      await wakeNow();
      warnings = warned.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("working"));
    } finally {
      full.mockRestore();
      warned.mockRestore();
    }
    expect(kept.messages()).toHaveLength(before);
    expect(stored((await thread("main")).slice(-3))).toEqual([
      ["user", "autonomous", wakeSeenLater(byHand("12:20 PM"))],
      ["system", "autonomous", 'This wake\'s working is in "Wakes": 2 tool calls.'],
      ["assistant", "autonomous", "I found the keeper's log."],
    ]);
    expect(warnings).toEqual(Array.from({ length: 4 }, () => 'shore: could not keep a wake\'s working in "wakes": Error: the disk is full'));
  });
});

function sealing(app: AppConfig): void {
  app.tools.enabled = [...app.tools.enabled, "threads", "wake_in_thread", "chat_logs"];
}

const SEALED_LIST = "[Your sealed threads. Only a wake inside one can see what is in it, and `wake_in_thread` takes you there.\n- `gift` \"Something for you\", opens Saturday 2026-10-31 · 8:00 AM]";

function giftWake(now: string, lines: readonly string[], shown: readonly string[] = [], working: string | null = "wakes"): string {
  return wakeShown(now, shown, lines, "30 minutes", "25 minutes", "ring", working).replace('your thread "ring"', 'your thread "gift"');
}

async function sealsGift(h: Pick<Harness, "script" | "say" | "wakeNow">): Promise<void> {
  await h.say("hello");
  h.script.beatTool = { name: "threads", input: { action: "start", name: " gift ", label: " Something for you ", sealed_until: "2026-10-31 08:00" } };
  h.script.sends = undefined; h.script.closing = "Done.";
  at(10);
  await h.wakeNow();
}

test("a wake in a sealed thread is refused a message for another thread, and what it sends there stays inside", async () => {
  await withCharacter(async (h) => {
    const { runtime, script, emitted, wakeNow, thread } = h;
    await sealsGift(h);
    script.beatTool = { name: "wake_in_thread", input: { thread: "gift", reason: "Start on it." } };
    at(20);
    await wakeNow();
    script.sends = "Happy birthday!"; script.closing = "Made a card.";
    script.beatTool = { name: "send_message", input: { text: "It's nearly ready.", thread: "main" } };
    emitted.length = 0;
    at(21);
    await runtime.autonomy.runDue();
    const gift = (await runtime.registry.sealedEngine("ada", "gift"))?.messages() ?? [];
    expect(gift.flatMap((message) => message.content_blocks).flatMap((block) => block.type === "tool_result" ? [[block.content, block.is_error === true]] : [])).toEqual([
      ["It will be posted in this thread when this wake ends.", false],
      ["io: a wake in a sealed thread sends nothing outside it: leave `thread` out, and the message waits here until the thread opens", true],
    ]);
    expect(gift.at(-1)).toMatchObject({ role: "assistant", origin: "autonomous", content: "Happy birthday!" });
    expect((await thread("main")).map((message) => message.content)).not.toContain("It's nearly ready.");
    expect(emitted).toEqual([]);
  }, sealing);
});

test("a sealed thread is kept out of the user's thread list and the character's other turns, which are shown only its label and when it opens", async () => {
  await withCharacter(async (h) => {
    const { runtime, script, data, say, wakeNow, thread, command } = h;
    await sealsGift(h);
    const filesDir = join(data, "ada", "sealed", "gift");
    expect(lastToolResult(await thread("wakes"))).toEqual({
      text: `Sealed the thread "gift" (Something for you) until Saturday 2026-10-31 · 8:00 AM. peggy can't see it until then, and your other turns are shown only its label and that time. ` +
        `\`wake_in_thread\` takes you into it. Keep what you make for it in ${filesDir}, which is outside your workspace.`,
      failed: false,
    });
    expect(existsSync(filesDir)).toBe(true);
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "wakes"]);
    expect(runtime.registry.sealedThreads("ada")).toEqual([
      { id: "gift", label: "Something for you", unseal_at: "2026-10-31T08:00:00.000Z", created_at: "2026-10-30T12:10:00.000Z" },
    ]);
    expect(JSON.stringify(await command("list_threads", {}))).not.toContain("gift");

    script.replyTool = { name: "threads", input: { action: "list" } };
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
    script.replyTool = { name: "threads", input: { action: "start", name: "gift", label: "Another", sealed_until: "2026-11-02 08:00" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: 'io: thread "gift" already exists for ada', failed: true });
    script.replyTool = { name: "threads", input: { action: "start", name: "main", label: "Another", sealed_until: "2026-11-02 08:00" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: 'io: thread "main" already exists for ada', failed: true });
    script.replyTool = { name: "threads", input: { action: "start", name: "late", label: "Too late", sealed_until: "2026-10-30 12:20" } };
    await say("go on");
    expect(lastToolResult(await thread("main"))).toEqual({ text: "io: a sealed thread has to open at a time that is still to come", failed: true });
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift"]);

    const answered = async (input: Record<string, unknown>): Promise<string> => {
      script.replyTool = { name: "threads", input: { action: "start", ...input } };
      await say("go on");
      return String(lastToolResult(await thread("main"))?.text);
    };
    expect(await answered({ name: "t".repeat(65), label: "A", sealed_until: "2026-11-02 08:00" })).toStartWith("The call to threads was not run because argument `name` must NOT have more than 64 characters.");
    expect(await answered({ name: "box", label: "A", sealed_until: "2026-11-02 08:00", purpose: "a secret", folder: "Gifts" })).toBe("invalid args: a sealed thread takes only name, label and sealed_until, not purpose or folder: this call stays where peggy can read it, so say what the thread is for inside it, in your first wake there");
    expect(await answered({ name: "b", label: "A", sealed_until: "2026-11-02 08:00" })).toStartWith('Sealed the thread "b" (A) until Monday 2026-11-02 · 8:00 AM.');
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift", "b"]);

    await rm(join(data, "ada", "sealed"), { recursive: true });
    await writeFile(join(data, "ada", "sealed"), "in the way");
    expect(await answered({ name: "box", label: "A", sealed_until: "2026-11-02 08:00" })).toStartWith(`io: nothing was sealed, because the folder for its files, ${join(data, "ada", "sealed", "box")}, could not be made: mkdir:`);
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift", "b"]);
  }, sealing);
});

test("a wake in a sealed thread, whose working stays there, saves what it opened with on the opener there", async () => {
  await withCharacter(async (h) => {
    const { runtime, script, wakeNow } = h;
    await sealsGift(h);
    script.beatTool = { name: "wake_in_thread", input: { thread: "gift", reason: "Start on it." } };
    at(20);
    await wakeNow();
    script.wakes.length = 0;
    at(21);
    await runtime.autonomy.runDue();

    const [[, read] = ["", ""]] = turnsOf(script.wakes[0]);
    const opener = required((await runtime.registry.sealedEngine("ada", "gift"))?.messages()[0]);
    expect(read).toContain("[This thread is sealed until Saturday 2026-10-31 · 8:00 AM.");
    expect(opener.content).not.toContain("Nothing has been said in this thread yet.");
    expect(opener.notes).toEqual([{ place: "instead", text: read }]);
  }, sealing);
});

test("a wake inside a sealed thread sends, announces and logs nothing outside it, and its next wake there starts fresh, with none of what the last one ended on", async () => {
  await withCharacter(async (h) => {
    const { runtime, script, data, emitted, say, wakeNow, thread } = h;
    await sealsGift(h);
    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    script.beatTool = { name: "wake_in_thread", input: { thread: "gift", reason: "Start on it." } };
    at(20);
    await wakeNow();
    expect(lastToolResult(await thread("wakes"))?.failed).toBe(false);
    const captured = runtime.callStore?.callCount();
    const transcripts = runtime.callStore?.queryTranscripts("wake", "ada", 100).length;
    script.wakes.length = 0;
    emitted.length = 0;
    script.sends = "Happy birthday!"; script.closing = "Made a card.";
    at(21);
    await runtime.autonomy.runDue();

    expect(turnsOf(script.wakes[0])).toEqual([["user", giftWake("12:21 PM", [
      '[You asked for this wake from "main" at Friday 2026-10-30 · 12:20 PM: Start on it.]',
      `[This thread is sealed until Saturday 2026-10-31 · 8:00 AM. User can't see it, or anything you do or send here, until then, and your other threads are shown only its label, "Something for you". ` +
        `What you send here waits in the thread for them. Keep what you make for it in ${join(data, "ada", "sealed", "gift")}, which is outside your workspace.]`,
    ], ["Nothing has been said in this thread yet.", wroteLast("21 minutes ago", 'your home thread "main"')], null)]]);
    expect(script.wakes.map((request) => [request.context?.thread, request.context?.sealed])).toEqual([["gift", true], ["gift", true]]);
    expect(emitted).toEqual([]);
    expect(announced).toEqual([]);
    expect([runtime.callStore?.callCount(), runtime.callStore?.queryTranscripts("wake", "ada", 100).length]).toEqual([captured, transcripts]);
    expect(runtime.autonomy.log("ada", 100).map((event) => [event.kind, event.detail]).slice(-2)).toEqual([
      ["tick_fired", 'Woken in "gift" by a hand-off from "main"'],
      ["message_sent", "A message was left in a sealed thread"],
    ]);
    const sealedEngine = await runtime.registry.sealedEngine("ada", "gift");
    expect(stored(sealedEngine?.messages() ?? []).slice(-2)).toEqual([
      ["assistant", "", "Made a card."],
      ["assistant", "autonomous", "Happy birthday!"],
    ]);
    expect(await runtime.registry.sealedEngine("ada", "gift")).toBe(sealedEngine);
    expect(h.heard("gift")).toBe(false);
    expect(h.events.filter((event) => event.type === "threads_changed" && event.thread === "gift")).toEqual([]);

    at(22);
    await say("anything new?");
    const asked = textOf(script.replies.at(-1) as SidecarRequest);
    expect(asked).toEndWith("\nanything new?");
    expect(asked).not.toContain("Made a card.");
    expect(asked).not.toContain("Happy birthday!");
    script.replyTool = { name: "chat_logs", input: { action: "search", query: "birthday" } };
    await say("did you say something about a birthday?");
    expect(String(lastToolResult(await thread("main"))?.text)).toStartWith("birthday: 0 matches.\n");
    script.replyTool = { name: "chat_logs", input: { action: "search", query: "birthday", thread: "wakes" } };
    await say("not even while you were working?");
    expect(String(lastToolResult(await thread("main"))?.text)).toStartWith("birthday: 0 matches in thread wakes.\n");
    script.sends = undefined; script.closing = "Done.";
    at(30);
    await wakeNow();
    expect(textOf(script.wakes.at(-2) as SidecarRequest)).not.toContain("Made a card.");

    script.wakes.length = 0;
    expect(runtime.autonomy.requestWake("ada", { name: "", from: "main", reason: "Wrap it.", at: T0 + 31 * MINUTE, thread: "gift" }, false).kind).toBe("queued");
    at(31);
    await runtime.autonomy.runDue();
    const again = turnsOf(script.wakes[0]).at(-1)?.[1] ?? "";
    expect(again).toContain('in your home thread "main".]\n\n[You asked for this wake from "main" at ');
    expect(again).not.toContain("Made a card.");

    runtime.autonomy.forceDormancy("ada", "dormant");
    script.sends = "Open the card."; script.closing = "Gave it.";
    at(20 * 60);
    await runtime.autonomy.runDue();
    await h.shown("gift", (message) => message.content === "Open the card.");
    expect(h.events.filter((event) => event.type === "threads_changed" && event.thread === "gift")).toEqual([{ type: "threads_changed", character: "ada", thread: "gift" }]);
    expect(await runtime.registry.sealedEngine("ada", "gift")).toBeUndefined();
  }, sealing);
});

test("at its time the seal comes off: the thread joins the user's list with what was sent waiting unread, the character is woken there even when dormant", async () => {
  let root = "";
  await withCharacter(async (h) => {
    const { runtime, script, data, wakeNow } = h;
    root = dirname(data);
    await sealsGift(h);
    script.beatTool = { name: "wake_in_thread", input: { thread: "gift", reason: "Start on it." } };
    at(20);
    await wakeNow();
    script.sends = "Happy birthday!"; script.closing = "Made a card.";
    at(21);
    await runtime.autonomy.runDue();
  }, sealing);

  await withCharacter(async ({ runtime, script, data, emitted, say, thread, shown }) => {
    at(19 * 60 + 59);
    await say("good morning");
    expect(runtime.autonomy.forceDormancy("ada", "dormant")).toBe(true);
    await runtime.autonomy.runDue();
    expect(runtime.registry.sealedThreads("ada").map((sealed) => sealed.id)).toEqual(["gift"]);
    expect(script.wakes).toEqual([]);

    const announced: unknown[][] = [];
    runtime.notifier.notify = (...told) => { announced.push(told); };
    script.sends = "Open the card."; script.closing = "Gave it.";
    emitted.length = 0;
    at(20 * 60);
    await runtime.autonomy.runDue();
    expect(runtime.registry.sealedThreads("ada")).toEqual([]);
    expect(runtime.registry.listThreads("ada").at(-1)).toEqual({ id: "gift", label: "Something for you", created_at: "2026-10-30T12:10:00.000Z", created_by: "character", compaction: true });
    expect(script.wakes.map((request) => [request.context?.thread, request.context?.sealed])).toEqual([["gift", undefined], ["gift", undefined]]);
    expect(turnsOf(script.wakes[0])).toEqual([["user", giftWake("8:00 AM", [
      "[The seal on this thread came off at Saturday 2026-10-31 · 8:00 AM. User can see this thread and everything in it from now on. This wake is for giving them what you made.]",
    ], [
      "Nothing has been said in this thread since your last wake here.",
      wroteLast("a minute ago", 'your home thread "main"'),
    ]).replace("[Current time: Friday 2026-10-30 · 8:00 AM]", "[Current time: Saturday 2026-10-31 · 8:00 AM]")]]);
    expect(emitted.map((each) => [each.thread, each.msg.content])).toEqual([["gift", "Open the card."]]);
    expect(announced).toEqual([["autonomous_message", "Shore - ada", "Open the card.", undefined]]);
    expect(threadActivityNow(data, "ada", "gift").unread).toBe(2);
    expect(runtime.autonomy.log("ada", 100).filter((event) => event.kind === "tick_fired").at(-1)?.detail).toBe('Woken in "gift" by its seal coming off');
    expect((await thread("gift")).at(-1)?.content).toBe("Open the card.");
    await shown("gift", (message) => message.content === "Open the card.");
    script.replyTool = { name: "chat_logs", input: { action: "search", query: "birthday" } };
    await say("did you say something about a birthday?");
    expect(String(lastToolResult(await thread("main"))?.text)).toContain("ada    [gift] (wake) Happy [birthday]!");
    at(20 * 60 + 1);
    await runtime.autonomy.runDue();
    expect(script.wakes).toHaveLength(2);
  }, sealing, root);
});

test("with the character's triggers switched off a seal still comes off at its time, and nothing wakes", async () => {
  let root = "";
  await withCharacter(async (h) => {
    root = dirname(h.data);
    await sealsGift(h);
  }, sealing);
  await withCharacter(async ({ runtime, script, say }) => {
    at(20 * 60);
    await say("good morning");
    await runtime.autonomy.runDue();
    expect(runtime.registry.listThreads("ada").map((record) => record.id)).toEqual(["main", "wakes", "gift"]);
    expect(script.wakes).toEqual([]);
  }, (app) => {
    sealing(app);
    app.triggers.enabled = false;
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
    await runtime.autonomy.runDue();
    expect((await thread("main")).filter((message) => message.role === "user").map((message) => message.origin === "autonomous" ? "wake" : message.content_blocks[0]?.type)).toEqual([
      "text", "text", "tool_result", "wake",
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
    app.tools.enabled = [...app.tools.enabled, "activity_heatmap"];
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

const MARKED = TEXTS.filter((spec) => !spec.fixed);

function declared(spec: TextSpec): string[] {
  return Object.keys(spec.values).filter((value) => value !== "<tool>");
}

function marker(spec: TextSpec): string {
  return `⟦${spec.name}${declared(spec).map((value) => `{{#if ${value}}}|${value}={{${value}}}{{/if}}`).join("")}⟧`;
}

function leftOver(text: string, theirs: readonly string[]): string {
  let left = text;
  for (let before = ""; before !== left;) {
    before = left;
    left = left.replace(/⟦[^⟦⟧]*⟧/g, "");
  }
  for (const words of theirs) left = left.split(words).join("");
  return left.trim();
}

function requestTexts(request: SidecarRequest): string[] {
  const inner = (content: unknown): string[] => typeof content === "string" ? [content]
    : Array.isArray(content) ? content.flatMap((block: { type: string; text?: string }) => block.type === "text" ? [block.text ?? ""] : []) : [];
  const described = (schema: unknown): string[] => {
    if (typeof schema !== "object" || schema === null) return [];
    return Object.entries(schema).flatMap(([key, value]) => key === "description" && typeof value === "string" ? [value] : described(value));
  };
  return [
    ...(request.system ?? []).map((block) => block.text),
    ...request.messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : block.type === "tool_result" ? inner(block.content) : [])),
    ...(request.tools ?? []).flatMap((tool) => [tool.description, ...described(tool.input_schema)]),
  ];
}

test("with every text Shore writes pointed at a marker, a reply carrying every kind of note and a wake hold nothing of Shore's but the markers, and each text is given the values the list names", async () => {
  const watching = spyOn(Texts.prototype, "render");
  const rendered: Parameters<Texts["render"]>[] = [];
  const enabled = ALL_TOOLS.map((tool) => tool.name);
  try {
    await withCharacter(async ({ runtime, script, data, workspace, say, thread }) => {
      const config = join(dirname(data), "config");
      await mkdir(join(config, "texts"), { recursive: true });
      for (const spec of MARKED) await writeFile(join(config, "texts", `${spec.name}.md`), `${marker(spec)}\n`);
      await writeFile(join(workspace, "notes.md"), "The fox is called Rue.");
      await writeFile(join(workspace, "lamp.png"), await sizedImage(8, 8));
      await writeFile(join(workspace, "TRIGGERS.toml"), SHOW);
      await runtime.registry.createThread("ada", "ring", { label: "The ring", purpose: "A story in parts", pins: ["notes.md"] });
      const engine = await runtime.registry.getOrCreate("ada", "main");
      const message = (id: string, role: Message["role"], text: string, minutes: number, extra: Partial<Message> = {}): Message => ({
        msg_id: id, role, content: text, images: [], content_blocks: text === "" ? [] : [{ type: "text", text }], alternatives: [], timestamp: new Date(T0 + minutes * MINUTE).toISOString(), ...extra,
      });
      for (const each of [
        message("a0", "assistant", "I was waiting for you.", 0),
        message("u1", "user", "here is the lamp", 1, { images: [{ path: join(workspace, "lamp.png") }, { path: join(workspace, "gone.png") }], presence: { statuses: [{ status: "home", set_at: new Date(T0).toISOString() }], changed_at: new Date(T0).toISOString() } }),
        message("a1", "assistant", "It glows: ![[nowhere.png]]", 2, { images: [{ path: "", embed: "![[nowhere.png]]", problem: "no picture matches" }, { path: join(workspace, "drawn.png"), caption: "a drawing" }] }),
        message("w1", "assistant", "I lit it while you were away.", 50, { origin: "autonomous" }),
        message("u2", "user", "thank you", 120, { wake_running: { started_at: new Date(T0 + 110 * MINUTE).toISOString(), thread: "ring" }, last_elsewhere: { thread: "garden", at: new Date(T0 + 100 * MINUTE).toISOString() }, presence: { statuses: [], changed_at: new Date(T0 + 115 * MINUTE).toISOString() } }),
        message("a2", "assistant", "You're welcome.", 121),
        message("u3", "user", "one from before", 122, { wake_running: { started_at: new Date(T0 + 110 * MINUTE).toISOString() } }),
        message("a3", "assistant", "I remember.", 123),
      ]) await engine.appendMessage(each);
      at(124);
      await say("tell me a story in parts", "ring");
      await runtime.triggers.tick();
      await say("go on");
      script.again = 1;
      script.aside = "Let me look.";
      script.sends = undefined;
      changePresence(data, { on: ["reading"] }, T0 + 130 * MINUTE);
      const held = hold();
      script.beatHeld = held;
      const waking = fires(runtime, 135);
      await held.started.promise;
      at(136);
      const asking = say("wait, what is the fox called?", "ring");
      held.release.resolve();
      await waking;
      await asking;
      at(150);
      await runtime.autonomy.runDue();

      const theirs = [
        "here is the lamp", "thank you", "one from before", "tell me a story in parts", "go on", "wait, what is the fox called?",
        "I was waiting for you.", "It glows: ![[nowhere.png]]", "I lit it while you were away.", "You're welcome.", "I remember.",
        "reply to: tell me a story in parts", "reply to: go on", "reply to: wait, what is the fox called?", "reply to: thank you", "reply to: one from before",
        "Let me look.", "Done.", `${join(workspace, "SOUL.md")}: lines 1–1\n1\tAda\nEnd of file.`, SOUL_READ, "Ada",
      ].sort((a, b) => b.length - a.length);
      const requests = [...script.replies, ...script.wakes];
      expect(script.wakes.length).toBeGreaterThanOrEqual(2);
      expect(requests.flatMap((request) => requestTexts(request).filter((text) => leftOver(text, theirs) !== ""))).toEqual([]);
      expect((await thread("ring")).flatMap((each) => each.role === "system" ? [leftOver(each.shown_later ?? each.content, [])] : [])).toEqual(["", "", ""]);
    }, (app) => {
      withTriggers(app);
      app.tools.enabled = enabled;
      app.chat.user_timestamps = "always";
      app.texts = Object.fromEntries(MARKED.map((spec) => [spec.name, `texts/${spec.name}.md`]));
    });
  } finally {
    rendered.push(...watching.mock.calls);
    watching.mockRestore();
  }
  const given = new Map<string, Set<string>[]>();
  for (const [name, values = {}] of rendered) given.set(name, [...given.get(name) ?? [], new Set(Object.keys(values))]);

  const toolTexts = ALL_TOOLS.flatMap((tool) => [toolText(tool.name), ...Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties).map((parameter) => parameterText(tool.name, parameter))]);
  expect([...given.keys()].filter((name) => !toolTexts.includes(name)).sort()).toEqual([
    "digest_first", "digest_user", "digest_you", "fired_trigger", "last_wake_interrupted", "last_wrote_here", "last_wrote_home",
    "opened_by_you", "picture", "picture_gone", "pictures_not_sent", "pinned_file", "sent_picture", "status", "status_cleared", "status_item",
    "stopped_interrupted", "thread", "thread_pins", "time", "time_later", "wake", "wake_opener", "wake_opener_kept", "wake_running", "wake_running_own_time",
    "wake_status", "wake_turn", "working_kept", "working_kept_unfinished",
  ].sort());
  expect(toolTexts.filter((name) => !given.has(name))).toEqual([]);
  const mismatched = [...given].flatMap(([name, calls]) => {
    const spec = required(TEXT_SPECS.get(name));
    return calls.flatMap((keys) => {
      const extra = [...keys].filter((key) => !declared(spec).includes(key) && !(name.startsWith("tool_") && enabled.includes(key)));
      const missing = declared(spec).filter((key) => !keys.has(key));
      return extra.length === 0 && missing.length === 0 ? [] : [`${name}: given ${extra.join(", ") || "nothing extra"}, not given ${missing.join(", ") || "nothing"}`];
    });
  });
  expect([...new Set(mismatched)]).toEqual([]);
});

test("a wake whose text the user pointed at a file that can't be read is skipped before anything is sent or written, and the log says which and why", async () => {
  await withCharacter(async ({ runtime, script, say, wakeNow, thread, data, reload }) => {
    await say("hello");
    const before = await thread("main");
    runtime.config.app.texts = { wake: "texts/gone.md" };
    await reload();
    at(10);
    await wakeNow();
    expect(script.wakes).toHaveLength(0);
    expect(await thread("main")).toEqual(before);
    const missing = join(dirname(data), "config", "texts", "gone.md");
    expect(runtime.autonomy.log("ada", 10).map((event) => [event.kind, event.detail]).at(-1)).toEqual([
      "call_failed", `Wake skipped: text "wake" could not be read at ${missing}: ENOENT: no such file or directory, open '${missing}'`,
    ]);
  });
});
