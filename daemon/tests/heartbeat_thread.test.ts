import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { History } from "../src/engine/conversation.ts";
import { markThreadRead, threadActivityNow } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { runCompactionPass } from "../src/memory/compaction/run.ts";
import { createRuntime, type ShoreRuntime } from "../src/runtime.ts";
import { eventsForResponse } from "./support/stream.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
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
        yield* eventsForResponse(respond(request, [{ type: "text", text: `reply to: ${textOf(request).split("\n").at(-1) ?? ""}` }]));
        return;
      }
      script.heartbeats.push(structuredClone(request));
      const resultsIn = request.messages.at(-1)?.content.some((block) => block.type === "tool_result") === true;
      yield* eventsForResponse(respond(request, resultsIn
        ? [
            { type: "thinking", thinking: "She asked about the lamp, so I'll tell her.", signature: "sig-1" },
            { type: "text", text: "<sendMessage>I found the keeper's log.</sendMessage>" },
          ]
        : [{ type: "tool_use", id: `read-${String(script.heartbeats.length)}`, name: "read", input: { file_path: "SOUL.md" } }]));
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
  emitted: Emitted[];
  say: (text: string, thread?: string) => Promise<void>;
  heartbeat: () => Promise<void>;
  thread: (id: string) => Promise<readonly Message[]>;
  shown: (thread: string, match: (message: Message) => boolean) => Promise<void>;
}

async function withCharacter(run: (h: Harness) => Promise<void>, configure?: (app: AppConfig) => void): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  at(0);
  const root = await mkdtemp(testTmp("shore-heartbeat-thread-"));
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
  const script: Script = { heartbeats: [], replies: [], calls: [], held: undefined };
  const emitted: Emitted[] = [];
  const histories: History[] = [];
  const waiting: { thread: string; match: (message: Message) => boolean; resolve: () => void }[] = [];
  const env = { [KEY_ENV]: "fixture-key" };
  const runtime = await createRuntime({
    config, providers: { anthropic: scriptedProvider(script) }, env,
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
      emitted,
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
      heartbeat: async () => {
        expect(runtime.autonomy.forceHeartbeatNow("ada")).toBeDefined();
        await runtime.autonomy.tick();
      },
      thread: async (id) => (await runtime.registry.getOrCreate("ada", id)).messages(),
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

test("with defer_on_activity, each message and the end of each reply push the next heartbeat to min_interval after them, in a side thread too", async () => {
  await withCharacter(async ({ runtime, script, say }) => {
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
