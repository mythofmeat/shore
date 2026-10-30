import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import type { Message } from "../src/engine/types.ts";
import { buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
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
    generate: async (request) => respond(request, [{ type: "text", text: "hello" }]),
    stream: async function* (request) {
      if (request.context?.call_type.startsWith("heartbeat") !== true) {
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
  say: (text: string, thread?: string) => Promise<void>;
  heartbeat: () => Promise<void>;
  thread: (id: string) => Promise<readonly Message[]>;
  emitted: (match: (event: Emitted) => boolean) => Promise<void>;
}

async function withCharacter(run: (h: Harness) => Promise<void>): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  at(0);
  const root = await mkdtemp(testTmp("shore-heartbeat-thread-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = ["read", "set_next_wake"];
  app.behavior.autonomy.enabled = true;
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV,
    maxContextTokens: 200_000, maxOutputTokens: 4096,
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  const script: Script = { heartbeats: [], held: undefined };
  const seen: Emitted[] = [];
  const waiting: { match: (event: Emitted) => boolean; resolve: () => void }[] = [];
  const env = { [KEY_ENV]: "fixture-key" };
  const runtime = await createRuntime({
    config, providers: { anthropic: scriptedProvider(script) }, env,
    emit: (_character, _revision, msg, thread) => {
      const event = { thread, msg: structuredClone(msg) };
      seen.push(event);
      for (const waiter of waiting.filter((entry) => entry.match(event))) waiter.resolve();
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
      emitted: async (match) => {
        if (seen.some(match)) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        waiting.push({ match, resolve });
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
  await withCharacter(async ({ runtime, script, say, heartbeat, thread, emitted }) => {
    await say("hello");
    const held = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    script.held = held;
    at(1);
    const replying = say("is the lamp lit?");
    await held.started.promise;

    at(2);
    const ticking = heartbeat();
    await emitted((event) => event.thread === "heartbeat" && event.msg.role === "assistant");
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

test("the heartbeat's own turn stays in its thread, and the next one opens with what was said in home since", async () => {
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
    expect(textOf(script.heartbeats.at(-2) as SidecarRequest)).toContain("the keeper's name is Mara");
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
