import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { readdirSync, readlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import type { AppConfig } from "../src/config/app.ts";
import type { ModelCatalog } from "../src/config/models.ts";
import { characterActiveJsonl, threadDataDir } from "../src/config/dirs.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { segments as segmentsCommand } from "../src/commands/segments.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps, labelNewSegments } from "../src/handler/deps.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { shoreLog } from "../src/log.ts";
import { LABEL_CONVERSATION_BYTES, LABEL_MESSAGE_BYTES, labelConversation, labelFromReply, prepareLabelCall } from "../src/memory/compaction/label.ts";
import { required } from "../src/util/required.ts";
import { readDurable } from "../src/storage/files.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { afterFirstChat, type ChatWorld } from "./support/chat_world.ts";
import { restoreTestEnv, unsetTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
import { eventsForResponse } from "./support/stream.ts";

const KEY_ENV = "SHORE_TEST_SEGMENT_LABELS_KEY";
const HOUR = 60 * 60_000;
const PROMPT = "Above is a conversation between ada and Mara. Write a one-line label for it that says what happened in it, so they can tell later what it was about. Keep it under twenty words, in the third person, with no \"I\", \"we\" or \"you\". Reply with only the label.";
const FIRST_TURN = "Mara: hello\nada: The lamp is lit.";

afterEach(() => {
  setSystemTime();
  restoreTestEnv();
});

interface Script {
  calls: SidecarRequest[];
  label: string | Error;
  held: PromiseWithResolvers<void> | undefined;
}

function provider(script: Script): SidecarProvider {
  const respond = (request: SidecarRequest, blocks: GenerateResponse["content_blocks"]): GenerateResponse => ({
    model: request.model,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    content_blocks: blocks,
    finish_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  });
  const answer = async (request: SidecarRequest): Promise<GenerateResponse> => {
    script.calls.push(structuredClone(request));
    if (request.context?.call_type !== "label") return respond(request, [{ type: "text", text: "The lamp is lit." }]);
    await script.held?.promise;
    if (script.label instanceof Error) throw script.label;
    if (script.label === "refuse") return { ...respond(request, [{ type: "text", text: "I can't help with that." }]), finish_reason: "refusal" };
    return respond(request, [{ type: "text", text: script.label }]);
  };
  return {
    generate: answer,
    stream: async function* (request) { yield* eventsForResponse(await answer(request)); },
  };
}

interface World extends ChatWorld {
  script: Script;
  command: (name: string, args: Record<string, unknown>, thread?: string) => Promise<unknown>;
  settled: () => Promise<void>;
  stop: () => void;
  segments: (thread?: string) => { idx: number; label: string | undefined }[];
  of: (callType: string) => SidecarRequest[];
}

async function world(run: (world: World) => Promise<void>, tune?: (app: AppConfig, models: ModelCatalog) => void, prepare?: (workspace: string) => Promise<void>): Promise<void> {
  const script: Script = { calls: [], label: "Lighting the lamp", held: undefined };
  const env = { [KEY_ENV]: "fixture-key" };
  let settled = async (): Promise<void> => {};
  let stop = (): void => {};
  await afterFirstChat({
    name: "segment-labels", keyEnv: KEY_ENV, provider: provider(script), tools: ["read"], autonomy: true, models: ["fixture", "pinned"],
    tune: (app, models) => {
      app.chat.display_name = "Mara";
      tune?.(app, models);
    },
    ...(prepare === undefined ? {} : { prepare }),
    started: (runtime) => {
      const labels = labelNewSegments({
        runtime, providers: runtime.providers, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(), env, emitEvent: () => {},
      });
      settled = labels.settled;
      stop = labels.stop;
      return labels.stop;
    },
  }, async (chat) => {
    const { runtime, config } = chat;
    await run({
      ...chat,
      script,
      settled: () => settled(),
      stop: () => { stop(); },
      of: (callType) => script.calls.filter((call) => call.context?.call_type === callType),
      command: async (name, args, thread = "main") => await dispatchCommand(buildCommandPathDeps({
        runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(), router: new SessionRouter(),
        handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env,
      }), { name, args }, {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: thread },
        rid: name,
        kind: "command",
      }),
      segments: (thread = "main") => {
        const store = HistoryStore.open(join(config.dirs.data, HISTORY_DB_FILE));
        try {
          return store.entries(thread === "main" ? "ada" : `ada/${thread}`).map((entry) => ({ idx: entry.idx, label: entry.label }));
        } finally {
          store.close();
        }
      },
    });
  });
}

function blocksOf(request: SidecarRequest): string[] {
  return request.messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []));
}

test("a label is the first line the model wrote, trimmed, and one over 160 characters ends at the last whole word that fits, then an ellipsis", () => {
  expect(labelFromReply("  Lighting the lamp  \nand more")).toBe("Lighting the lamp");
  expect(labelFromReply("\n\n  \nSecond thoughts")).toBe("Second thoughts");
  expect(labelFromReply(" \n ")).toBeUndefined();
  expect(labelFromReply("x".repeat(160))).toBe("x".repeat(160));
  expect(labelFromReply(`a${" word".repeat(40)}`)).toBe(`a${" word".repeat(31)}…`);
  expect(labelFromReply(`${"word ".repeat(32)}more`)).toBe(`${"word ".repeat(31)}word…`);
  expect(labelFromReply(`${"x".repeat(150)}  ${"y".repeat(20)}`)).toBe(`${"x".repeat(150)}…`);
  expect(labelFromReply("🌊".repeat(161))).toBe(`${"🌊".repeat(159)}…`);
});

const NAMES = { char: "ada", user: "Mara" };

function said(role: Message["role"], blocks: ContentBlock[], origin?: Message["origin"]): Message {
  return { msg_id: "m", role, content: "", images: [], content_blocks: blocks, timestamp: "2026-11-27T00:00:00Z", ...(origin === undefined ? {} : { origin }) };
}

const words = (text: string): ContentBlock => ({ type: "text", text });

test("a segment is written out for its label as who said what, leaving out tool calls and results, thinking, notes and the turns Shore wrote, but keeping what the character wrote in a wake", () => {
  expect(labelConversation([
    said("user", [words("Where is the lamp?")]),
    said("assistant", [{ type: "thinking", thinking: "Hidden reasoning.", signature: "s" }, words("Let me look."), { type: "tool_use", id: "t1", name: "read", input: { file_path: "SOUL.md" } }]),
    said("user", [{ type: "tool_result", tool_use_id: "t1", content: "Tool output." }]),
    said("assistant", [words("  On the shelf.  ")]),
    said("system", [words("A note for the model.")]),
    said("user", [words("Wake up and check the lamp.")], "autonomous"),
    said("assistant", [words("The lamp is still lit.")], "autonomous"),
  ], NAMES)).toEqual({ text: "Mara: Where is the lamp?\nada: Let me look.\nada: On the shelf.\nada: The lamp is still lit.", cut: false });
});

test("a message over 1,000 bytes is cut after the last whole character that fits, with an ellipsis, and one of exactly 1,000 bytes is kept whole", () => {
  const whole = "🌊".repeat(LABEL_MESSAGE_BYTES / 4);
  expect(labelConversation([said("user", [words(whole)])], NAMES)).toEqual({ text: `Mara: ${whole}`, cut: false });
  const waves = "🌊".repeat(LABEL_MESSAGE_BYTES / 4 - 1);
  expect(labelConversation([said("assistant", [words(`${waves} and more`)])], NAMES)).toEqual({ text: `ada: ${waves} and…`, cut: true });
  expect(labelConversation([said("assistant", [words(`${waves} an 🌊`)])], NAMES), "a character that would cross the limit is left out whole")
    .toEqual({ text: `ada: ${waves} an…`, cut: true });
});

test("a conversation over 30,000 bytes keeps whole lines from both ends, a line from the start first, with an ellipsis line between", () => {
  const line = (index: number): string => `${String(index)}:`.padEnd(LABEL_MESSAGE_BYTES - 7, "x");
  const messages = Array.from({ length: 40 }, (_, index) => said("user", [words(line(index))]));
  const lines = messages.map((_, index) => `Mara: ${line(index)}`);
  const fitted = labelConversation(messages, NAMES);
  expect(fitted.text.split("\n")).toEqual([...lines.slice(0, 15), "…", ...lines.slice(26)]);
  expect(Buffer.byteLength(fitted.text)).toBeLessThanOrEqual(LABEL_CONVERSATION_BYTES);
  expect(fitted.cut).toBe(true);

  const exactly = Array.from({ length: LABEL_CONVERSATION_BYTES / LABEL_MESSAGE_BYTES }, (_, index) => said("user", [words(line(index))]));
  expect(labelConversation(exactly, NAMES), "lines that fit exactly, counting one newline each, are all kept").toMatchObject({ cut: false });
  const over = [...exactly.slice(0, -1), said("user", [words(`${line(29)}x`)])];
  expect(labelConversation(over, NAMES).text.split("\n")[15]).toBe("…");
});

test("a label asked for a segment with something cut says long messages were cut short", async () => {
  await world(async ({ command, settled, say, of }) => {
    await say("y".repeat(LABEL_MESSAGE_BYTES + 1));
    await command("compact", { keep_turns: 0 });
    await settled();
    expect(of("label").map(blocksOf)).toEqual([[
      `${FIRST_TURN}\nMara: ${"y".repeat(LABEL_MESSAGE_BYTES)}…\nada: The lamp is lit.`,
      PROMPT.replace("between ada and Mara.", "between ada and Mara, with long messages cut short."),
    ]]);
  });
});

test("a label is asked for without the chat model's effort or thinking budget, with the shortest cache lifetime, and with the model's other settings", async () => {
  await world(async ({ command, settled, of }) => {
    await command("compact", { keep_turns: 0 });
    await settled();
    const [chat] = of("message");
    expect(chat?.provider_options).toEqual({ reasoning_effort: "max", reasoning_budget_tokens: 2048, cache_ttl: "1h", openrouter_routing: { order: ["somewhere"] } });
    expect(of("label").map((request) => request.provider_options)).toEqual([{ thinking_enabled: false, cache_ttl: "5m", openrouter_routing: { order: ["somewhere"] } }]);
  }, (_app, models) => {
    Object.assign(required(models.chat.get("chat.fixture")), { reasoningEffort: "max", reasoningBudgetTokens: 2048, cacheTtl: "1h", openrouterRouting: { order: ["somewhere"] } });
  });
});

test("a model whose provider has no cache lifetime to set is asked for a label with none", async () => {
  await world(async ({ config }) => {
    const sent: SidecarRequest[] = [];
    const ask = await prepareLabelCall("ada", "main", [said("user", [words("hello")])], {
      config, generate: async (request) => { sent.push(request); return { model: "m", content: "A label", content_blocks: [], finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } }; },
    }, config, { model: "pinned" });
    expect(await ask?.()).toBe("A label");
    expect(sent.map((request) => [request.sdk, request.provider_options])).toEqual([["openai", { thinking_enabled: false }]]);
  }, (_app, models) => {
    Object.assign(required(models.chat.get("chat.pinned")), { sdk: "openai", cacheTtl: "1h" });
  });
});

test("a segment with nothing either of them said in it is archived with no label asked for, and label --auto refuses it", async () => {
  await world(async ({ runtime, config, command, settled, segments, of }) => {
    await runtime.registry.createThread("ada", "side");
    const quiet = [
      said("user", [words("Wake up and look around.")], "autonomous"),
      said("assistant", [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "SOUL.md" } }]),
      said("user", [{ type: "tool_result", tool_use_id: "t1", content: "Ada" }]),
    ];
    await archiveAndRetain(threadDataDir(config.dirs.data, "ada", "side"), { dbPath: join(config.dirs.data, HISTORY_DB_FILE), archiveKey: "ada/side" }, 0, serializeMessages(quiet));
    await settled();
    expect(segments("side")).toEqual([{ idx: 0, label: undefined }]);
    expect(await command("segments", { action: "label", index: 0, auto: true }, "side")).toMatchObject({ type: "error", code: "invalid_request", message: "segment 0 has nothing said in it to label" });
    expect(of("label")).toEqual([]);
  });
});

test("archiving a conversation asks the chat's model for a label with one message, the segment written out and then the label text, with no system prompt, tools or thinking, and the segment gets it", async () => {
  await world(async ({ command, settled, segments, of, config }) => {
    unsetTestEnv(KEY_ENV);
    await command("compact", { keep_turns: 0 });
    await settled();

    expect(segments()).toEqual([{ idx: 0, label: "Lighting the lamp" }]);
    const [chat] = of("message");
    const labels = of("label");
    const [label] = labels;
    if (chat === undefined || label === undefined) throw new Error("a request is missing");
    expect(chat.system).toBeDefined();
    expect(chat.tools).toBeDefined();
    expect(labels).toHaveLength(1);
    expect(label.model).toBe(chat.model);
    expect([label.system, label.tools]).toEqual([undefined, undefined]);
    expect(label.messages.map((message) => message.role)).toEqual(["user"]);
    expect(blocksOf(label)).toEqual([FIRST_TURN, PROMPT]);
    expect([label.provider_options, label.reasoning_replay]).toEqual([{ thinking_enabled: false, cache_ttl: "5m" }, "none"]);
    expect(label.context?.foreground).toBe(false);

    expect(readDurable(characterActiveJsonl(config.dirs.data, "ada", "main"))).toBe("");
    const store = HistoryStore.open(join(config.dirs.data, HISTORY_DB_FILE));
    try {
      expect(store.readSegment("ada", 0).map((message) => message.content)).toEqual(["hello", "The lamp is lit."]);
    } finally {
      store.close();
    }
  });
});

test("the label text pointed at the user's own file is the message the label is asked for with", async () => {
  await world(async ({ command, settled, of }) => {
    await command("compact", { keep_turns: 0 });
    await settled();
    expect(of("label").map((request) => blocksOf(request).at(-1))).toEqual(["Name this talk between ada and Mara."]);
  }, (app) => {
    app.texts = { label: "texts/label.md" };
  }, async (workspace) => {
    const texts = join(workspace, "..", "..", "..", "texts");
    await mkdir(texts, { recursive: true });
    await writeFile(join(texts, "label.md"), "Name this talk between {{char}} and {{user}}.\n");
  });
});

test("a label set by hand while the model is still answering is kept", async () => {
  await world(async ({ script, command, settled, segments }) => {
    script.held = Promise.withResolvers<void>();
    await command("compact", { keep_turns: 0 });
    await command("segments", { action: "label", index: 0, value: "By hand" });
    script.held.resolve();
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: "By hand" }]);
  });
});

test("a label call that fails, is refused or answers with nothing leaves the segment unlabelled and the archive done", async () => {
  await world(async ({ script, command, settled, segments, say, of }) => {
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    try {
      script.label = new Error("provider fell over");
      await command("compact", { keep_turns: 0 });
      await settled();
      expect(warned.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("unlabelled"))).toEqual([
        "shore: segment 0 of ada was left unlabelled: Error: provider fell over",
      ]);
    } finally {
      warned.mockRestore();
    }

    script.label = "refuse";
    await say("and the door?");
    await command("compact", { keep_turns: 0 });
    await settled();

    script.label = "  \n";
    await say("and the stairs?");
    await command("compact", { keep_turns: 0 });
    await settled();

    expect(segments()).toEqual([{ idx: 0, label: undefined }, { idx: 1, label: undefined }, { idx: 2, label: undefined }]);
    expect(of("label")).toHaveLength(3);
  });
});

test("with compaction.label_segments off no label is asked for", async () => {
  await world(async ({ command, settled, segments, of }) => {
    await command("compact", { keep_turns: 0 });
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: undefined }]);
    expect(of("label")).toEqual([]);
  }, (app) => { app.compaction.label_segments = false; });
});

test("archiving a side thread labels the segment it makes", async () => {
  await world(async ({ runtime, command, settled, segments, say, of }) => {
    await runtime.registry.createThread("ada", "side");
    await say("which lamp?", "side");
    await command("archive_thread", { name: "side" });
    await settled();
    expect(segments("side")).toEqual([{ idx: 0, label: "Lighting the lamp" }]);
    expect(of("label").map(blocksOf)).toEqual([["Mara: which lamp?\nada: The lamp is lit.", PROMPT]]);
  });
});

test("a conversation compacted for being idle is labelled, and one archived after a long idle stretch is not", async () => {
  await world(async ({ runtime, settled, segments, say, of }) => {
    await say("and the door?");
    const start = Date.now();
    setSystemTime(new Date(start + HOUR));
    await runtime.autonomy.runDue();
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: "Lighting the lamp" }]);
    expect(of("label").map(blocksOf), "only the turns archived are written out, not the one kept").toEqual([[FIRST_TURN, PROMPT]]);

    setSystemTime(new Date(start + 30 * HOUR));
    await runtime.autonomy.runDue();
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: "Lighting the lamp" }, { idx: 1, label: undefined }]);
    expect(of("label")).toHaveLength(1);
  }, (app) => {
    app.compaction.enabled = true;
    app.compaction.keep_recent_turns = 1;
    app.compaction.min_turns = 2;
    app.compaction.idle_after = ConfigDuration.fromSecs(50 * 60);
    app.compaction.archive_after = ConfigDuration.fromSecs(24 * 60 * 60);
  });
});

test("label --auto asks for a label for an archived segment, leaves a labelled one alone, and replaces it or uses another model when told to", async () => {
  await world(async ({ script, command, of }) => {
    unsetTestEnv(KEY_ENV);
    await command("compact", { keep_turns: 0 });
    expect(of("label")).toEqual([]);

    const first = await command("segments", { action: "label", index: 0, auto: true });
    expect(first).toMatchObject({ type: "command_output", data: { character: "ada", thread: "main", action: "label", skipped: false, segment: { index: 0, label: "Lighting the lamp" } } });
    const [asked] = of("label");
    expect(asked === undefined ? [] : blocksOf(asked)).toEqual([FIRST_TURN, PROMPT]);
    expect(asked?.model).toBe("claude-fixture");
    expect(asked?.context?.foreground).toBe(true);

    script.label = "Second thoughts";
    const again = await command("segments", { action: "label", index: 0, auto: true });
    expect(again).toMatchObject({ type: "command_output", data: { skipped: true, segment: { index: 0, label: "Lighting the lamp" } } });
    expect(of("label")).toHaveLength(1);

    const replaced = await command("segments", { action: "label", index: 0, auto: true, replace: true, model: "pinned" });
    expect(replaced).toMatchObject({ type: "command_output", data: { skipped: false, segment: { index: 0, label: "Second thoughts" } } });
    expect(of("label").map((request) => request.model)).toEqual(["claude-fixture", "claude-pinned"]);
  }, (app) => { app.compaction.label_segments = false; });
});

test("label --auto is refused with a label, without a segment to label, or when the model gives none, and replace and model need it", async () => {
  await world(async ({ script, command, segments, of }) => {
    await command("compact", { keep_turns: 0 });
    const refused = async (args: Record<string, unknown>): Promise<unknown> => {
      const answer = await command("segments", { action: "label", index: 0, ...args }) as { type: string; code?: string; message?: string };
      return [answer.type, answer.code, answer.message];
    };
    expect(await refused({ auto: true, value: "By hand" })).toEqual(["error", "invalid_request", "give a label or auto, not both"]);
    expect(await refused({ replace: true })).toEqual(["error", "invalid_request", "replace and model only apply with auto"]);
    expect(await refused({ model: "pinned" })).toEqual(["error", "invalid_request", "replace and model only apply with auto"]);
    expect(await refused({ auto: true, action: "note" })).toEqual(["error", "invalid_request", "auto only applies to the label action"]);
    expect(await refused({ auto: true, index: 7 })).toEqual(["error", "not_found", "segment 7 not found for ada"]);
    expect(of("label")).toEqual([]);

    script.label = " \n";
    expect(await refused({ auto: true })).toEqual(["error", "internal_error", "the model gave no label for segment 0"]);
    script.label = new Error("provider fell over");
    expect(await refused({ auto: true })).toEqual(["error", "internal_error", "could not label segment 0: provider fell over"]);
    expect(await refused({ auto: true, model: "nobody" })).toEqual(["error", "internal_error", expect.stringMatching(/^could not label segment 0: .*nobody/) as string]);
    expect(segments()).toEqual([{ idx: 0, label: undefined }]);
  }, (app) => { app.compaction.label_segments = false; });
});

test("settled waits for a label that is still being asked for", async () => {
  await world(async ({ script, command, settled, segments }) => {
    script.held = Promise.withResolvers<void>();
    await command("compact", { keep_turns: 0 });
    let done = false;
    const waiting = settled().then(() => { done = true; });
    await Bun.sleep(20);
    expect(done).toBe(false);
    expect(segments()).toEqual([{ idx: 0, label: undefined }]);
    script.held.resolve();
    await waiting;
    expect(segments()).toEqual([{ idx: 0, label: "Lighting the lamp" }]);
  });
});

test("once labelling is stopped, a new segment is no longer labelled", async () => {
  await world(async ({ command, settled, stop, segments, of }) => {
    stop();
    await command("compact", { keep_turns: 0 });
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: undefined }]);
    expect(of("label")).toEqual([]);
  });
});

test("label --auto reports a segment as skipped when a label was set by hand while the model was answering", async () => {
  await world(async ({ script, command, segments }) => {
    await command("compact", { keep_turns: 0 });
    script.held = Promise.withResolvers<void>();
    const asking = command("segments", { action: "label", index: 0, auto: true });
    await Bun.sleep(20);
    await command("segments", { action: "label", index: 0, value: "By hand" });
    script.held.resolve();
    expect(await asking).toMatchObject({ type: "command_output", data: { skipped: true, segment: { index: 0, label: "By hand" } } });
    expect(segments()).toEqual([{ idx: 0, label: "By hand" }]);
  }, (app) => { app.compaction.label_segments = false; });
});

test("labelling a segment, as it is archived or by command, leaves the history database with no more open handles than before", async () => {
  await world(async ({ command, settled, say, config, runtime }) => {
    const history = join(config.dirs.data, HISTORY_DB_FILE);
    const open = (): number => readdirSync("/proc/self/fd").filter((descriptor) => {
      try {
        return readlinkSync(`/proc/self/fd/${descriptor}`).startsWith(history);
      } catch {
        return false;
      }
    }).length;
    await command("compact", { keep_turns: 0 });
    await settled();
    const endIndexHold = runtime.historyIndex.beginForeground();
    await runtime.historyIndex.runOnce();
    const before = open();

    await say("and the door?");
    await command("compact", { keep_turns: 0 });
    await settled();
    expect(open()).toBe(before);

    await command("segments", { action: "label", index: 1, auto: true, replace: true });
    await command("segments", { action: "label", index: 1, auto: true });
    expect(open()).toBe(before);
    endIndexHold();
  });
});

test("label --auto is refused by a daemon that has no model to ask", async () => {
  await world(async ({ command, config }) => {
    await command("compact", { keep_turns: 0 });
    expect(await outcomeOf(segmentsCommand(config.dirs.data, "ada", "main", { action: "label", index: 0, auto: true }))).toThrow("this daemon has no model to ask for a label");
  }, (app) => { app.compaction.label_segments = false; });
});
