import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { readdirSync, readlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import type { AppConfig } from "../src/config/app.ts";
import { characterActiveJsonl } from "../src/config/dirs.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { segments as segmentsCommand } from "../src/commands/segments.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps, labelNewSegments } from "../src/handler/deps.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { shoreLog } from "../src/log.ts";
import { labelFromReply } from "../src/memory/compaction/label.ts";
import { readDurable } from "../src/storage/files.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { afterFirstChat, type ChatWorld } from "./support/chat_world.ts";
import { restoreTestEnv, unsetTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
import { eventsForResponse } from "./support/stream.ts";

const KEY_ENV = "SHORE_TEST_SEGMENT_LABELS_KEY";
const HOUR = 60 * 60_000;
const PROMPT = "Give a short label for this conversation so Mara can find it later. Reply with only the label.";

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
    if (script.label === "call a tool") return respond(request, [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "read", input: { file_path: "SOUL.md" } }]);
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

async function world(run: (world: World) => Promise<void>, tune?: (app: AppConfig) => void, prepare?: (workspace: string) => Promise<void>): Promise<void> {
  const script: Script = { calls: [], label: "Lighting the lamp", held: undefined };
  const env = { [KEY_ENV]: "fixture-key" };
  let settled = async (): Promise<void> => {};
  let stop = (): void => {};
  await afterFirstChat({
    name: "segment-labels", keyEnv: KEY_ENV, provider: provider(script), tools: ["read"], autonomy: true, models: ["fixture", "pinned"],
    tune: (app) => {
      app.defaults.display_name = "Mara";
      tune?.(app);
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

function textOf(request: SidecarRequest): string[] {
  return request.messages.map((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""));
}

test("a label is the first line the model wrote, trimmed and cut at 60 characters", () => {
  expect(labelFromReply("  Lighting the lamp  \nand more")).toBe("Lighting the lamp");
  expect(labelFromReply("\n\n  \nSecond thoughts")).toBe("Second thoughts");
  expect(labelFromReply("x".repeat(61))).toBe("x".repeat(60));
  expect(labelFromReply("é".repeat(61))).toBe("é".repeat(60));
  expect(labelFromReply(" \n ")).toBeUndefined();
});

test("clearing a conversation asks the chat's model for a label with the chat's own request plus one message, and the segment gets it", async () => {
  await world(async ({ command, settled, segments, of, config }) => {
    unsetTestEnv(KEY_ENV);
    await command("clear", {});
    await settled();

    expect(segments()).toEqual([{ idx: 0, label: "Lighting the lamp" }]);
    const [chat] = of("message");
    const labels = of("label");
    const [label] = labels;
    if (chat === undefined || label === undefined) throw new Error("a request is missing");
    expect(labels).toHaveLength(1);
    expect(label.model).toBe(chat.model);
    expect(label.system).toEqual(chat.system);
    expect(label.tools).toEqual(chat.tools);
    expect(textOf(label)).toEqual([...textOf(chat), "The lamp is lit.", PROMPT]);
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

test("a character's own label.md is the message the label is asked for with", async () => {
  await world(async ({ command, settled, of }) => {
    await command("clear", {});
    await settled();
    expect(of("label").map((request) => textOf(request).at(-1))).toEqual(["Name this talk between ada and Mara."]);
  }, undefined, async (workspace) => {
    const prompts = join(workspace, "..", "prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "label.md"), "Name this talk between {{char}} and {{user}}.\n");
  });
});

test("a label set by hand while the model is still answering is kept", async () => {
  await world(async ({ script, command, settled, segments }) => {
    script.held = Promise.withResolvers<void>();
    await command("clear", {});
    await command("segments", { action: "label", index: 0, value: "By hand" });
    script.held.resolve();
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: "By hand" }]);
  });
});

test("a label call that fails, or answers with a tool call or with nothing, leaves the segment unlabelled and the clear done", async () => {
  await world(async ({ script, command, settled, segments, say, of }) => {
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    try {
      script.label = new Error("provider fell over");
      await command("clear", {});
      await settled();
      expect(warned.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("unlabelled"))).toEqual([
        "shore: segment 0 of ada was left unlabelled: CompactionError: llm: provider fell over",
      ]);
    } finally {
      warned.mockRestore();
    }

    script.label = "call a tool";
    await say("and the door?");
    await command("clear", {});
    await settled();

    script.label = "  \n";
    await say("and the stairs?");
    await command("clear", {});
    await settled();

    expect(segments()).toEqual([{ idx: 0, label: undefined }, { idx: 1, label: undefined }, { idx: 2, label: undefined }]);
    expect(of("label")).toHaveLength(3);
  });
});

test("with compaction.label_segments off no label is asked for", async () => {
  await world(async ({ command, settled, segments, of }) => {
    await command("clear", {});
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: undefined }]);
    expect(of("label")).toEqual([]);
  }, (app) => { app.memory.compaction.label_segments = false; });
});

test("archiving a side thread labels the segment it makes", async () => {
  await world(async ({ runtime, command, settled, segments, say, of }) => {
    await runtime.registry.createThread("ada", "side");
    await say("which lamp?", "side");
    await command("archive_thread", { name: "side" });
    await settled();
    expect(segments("side")).toEqual([{ idx: 0, label: "Lighting the lamp" }]);
    expect(of("label").map((request) => textOf(request).slice(-3))).toEqual([["which lamp?", "The lamp is lit.", PROMPT]]);
  });
});

test("a conversation compacted for being idle is labelled, and one archived after a long idle stretch is not", async () => {
  await world(async ({ runtime, settled, segments, say, of }) => {
    await say("and the door?");
    const start = Date.now();
    setSystemTime(new Date(start + HOUR));
    await runtime.autonomy.tick();
    await settled();
    expect(of("compaction")).toHaveLength(1);
    expect(segments()).toEqual([{ idx: 0, label: "Lighting the lamp" }]);
    expect(of("label")).toHaveLength(1);

    setSystemTime(new Date(start + 30 * HOUR));
    await runtime.autonomy.tick();
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: "Lighting the lamp" }, { idx: 1, label: undefined }]);
    expect(of("label")).toHaveLength(1);
  }, (app) => {
    app.memory.compaction.enabled = true;
    app.memory.compaction.keep_recent_turns = 1;
    app.memory.compaction.min_turns = 2;
    app.memory.compaction.idle_trigger = ConfigDuration.fromSecs(50 * 60);
    app.memory.compaction.archive_after = ConfigDuration.fromSecs(24 * 60 * 60);
  });
});

test("label --auto asks for a label for an archived segment, leaves a labelled one alone, and replaces it or uses another model when told to", async () => {
  await world(async ({ script, command, of }) => {
    unsetTestEnv(KEY_ENV);
    await command("clear", {});
    expect(of("label")).toEqual([]);

    const first = await command("segments", { action: "label", index: 0, auto: true });
    expect(first).toMatchObject({ type: "command_output", data: { character: "ada", thread: "main", action: "label", skipped: false, segment: { index: 0, label: "Lighting the lamp" } } });
    const [asked] = of("label");
    expect(asked === undefined ? [] : textOf(asked)).toEqual(["hello", "The lamp is lit.", PROMPT]);
    expect(asked?.model).toBe("claude-fixture");
    expect(asked?.context?.foreground).toBe(true);

    script.label = "Second thoughts";
    const again = await command("segments", { action: "label", index: 0, auto: true });
    expect(again).toMatchObject({ type: "command_output", data: { skipped: true, segment: { index: 0, label: "Lighting the lamp" } } });
    expect(of("label")).toHaveLength(1);

    const replaced = await command("segments", { action: "label", index: 0, auto: true, replace: true, model: "pinned" });
    expect(replaced).toMatchObject({ type: "command_output", data: { skipped: false, segment: { index: 0, label: "Second thoughts" } } });
    expect(of("label").map((request) => request.model)).toEqual(["claude-fixture", "claude-pinned"]);
  }, (app) => { app.memory.compaction.label_segments = false; });
});

test("label --auto is refused with a label, without a segment to label, or when the model gives none, and replace and model need it", async () => {
  await world(async ({ script, command, segments, of }) => {
    await command("clear", {});
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
    expect(await refused({ auto: true })).toEqual(["error", "internal_error", "could not label segment 0: llm: provider fell over"]);
    expect(await refused({ auto: true, model: "nobody" })).toEqual(["error", "internal_error", expect.stringMatching(/^could not label segment 0: .*nobody/) as string]);
    expect(segments()).toEqual([{ idx: 0, label: undefined }]);
  }, (app) => { app.memory.compaction.label_segments = false; });
});

test("settled waits for a label that is still being asked for", async () => {
  await world(async ({ script, command, settled, segments }) => {
    script.held = Promise.withResolvers<void>();
    await command("clear", {});
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
    await command("clear", {});
    await settled();
    expect(segments()).toEqual([{ idx: 0, label: undefined }]);
    expect(of("label")).toEqual([]);
  });
});

test("label --auto reports a segment as skipped when a label was set by hand while the model was answering", async () => {
  await world(async ({ script, command, segments }) => {
    await command("clear", {});
    script.held = Promise.withResolvers<void>();
    const asking = command("segments", { action: "label", index: 0, auto: true });
    await Bun.sleep(20);
    await command("segments", { action: "label", index: 0, value: "By hand" });
    script.held.resolve();
    expect(await asking).toMatchObject({ type: "command_output", data: { skipped: true, segment: { index: 0, label: "By hand" } } });
    expect(segments()).toEqual([{ idx: 0, label: "By hand" }]);
  }, (app) => { app.memory.compaction.label_segments = false; });
});

test("labelling a segment, as it is archived or by command, leaves the history database with no more open handles than before", async () => {
  await world(async ({ command, settled, say, config }) => {
    const history = join(config.dirs.data, HISTORY_DB_FILE);
    const open = (): number => readdirSync("/proc/self/fd").filter((descriptor) => {
      try {
        return readlinkSync(`/proc/self/fd/${descriptor}`).startsWith(history);
      } catch {
        return false;
      }
    }).length;
    await command("clear", {});
    await settled();
    const before = open();

    await say("and the door?");
    await command("clear", {});
    await settled();
    expect(open()).toBe(before);

    await command("segments", { action: "label", index: 1, auto: true, replace: true });
    await command("segments", { action: "label", index: 1, auto: true });
    expect(open()).toBe(before);
  });
});

test("label --auto is refused by a daemon that has no model to ask", async () => {
  await world(async ({ command, config }) => {
    await command("clear", {});
    expect(await outcomeOf(segmentsCommand(config.dirs.data, "ada", "main", { action: "label", index: 0, auto: true }))).toThrow("this daemon has no model to ask for a label");
  }, (app) => { app.memory.compaction.label_segments = false; });
});
