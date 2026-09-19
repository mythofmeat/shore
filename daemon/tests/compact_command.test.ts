import { listDurableFiles } from "../src/storage/files.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./command_captures/compact_command.json" with { type: "json" };
import { ConversationEngine } from "../src/engine/conversation.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { queueDeferredEdit } from "../src/memory/deferred_edits.ts";
import { tryBeginCompaction } from "../src/memory/compaction/manager.ts";
import { createThread, setThreadModel } from "../src/engine/threads.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { newMessageVersion } from "../src/engine/versions.ts";
import { claimUncovered } from "../src/memory/coverage.ts";
import { loadCompactionCheckpoint, saveCompactionCheckpoint } from "../src/memory/compaction/checkpoint.ts";
import {
  CompactionError,
  type CompactionErrorKind,
  type CompactionOutcome,
} from "../src/memory/compaction/types.ts";
import {
  buildCompactionResponse,
  compact,
  compactionError,
  parseCompactArgs,
  type CompactContext,
} from "../src/commands/compact.ts";
import { CommandError } from "../src/commands/errors.ts";
import { testTmp } from "./support/tmp.ts";
import { DEFAULT_COMPACT_PROMPT } from "../src/memory/compaction/prompts.ts";
import type { SidecarRequest } from "../src/llm/types.ts";

const SEEDED = [
  ["m_1", "user", "first question"],
  ["m_2", "assistant", "first answer"],
].map(([id, role, text]) => ({
  msg_id: id,
  role,
  content: text,
  images: [],
  content_blocks: [{ type: "text", text }],
  alternatives: [],
  timestamp: "2026-01-01T10:00:00-05:00",
}));

interface World {
  config: LoadedConfig;
  engine: ConversationEngine;
  ctx: CompactContext;
  completed: [string, number][];
  charDataDir: string;
  conversationDir: string;
}

async function world(messages: unknown[]): Promise<World> {
  const root = await mkdtemp(testTmp("shore-compact-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const charDataDir = join(dirs.data, "ada");
  const conversationDir = join(charDataDir, "threads", "main");
  await mkdir(join(charDataDir, "threads", "main"), { recursive: true });
  const workspace = join(dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "# ada");
  await writeFile(
    join(charDataDir, "threads", "main", "active.jsonl"),
    messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length === 0 ? "" : "\n"),
  );

  const config: LoadedConfig = {
    app: defaultAppConfig(),
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs,
    rawTable: undefined,
  };

  const completed: [string, number][] = [];
  const engine = await ConversationEngine.load("ada", dirs.data, undefined);

  return {
    config,
    engine,
    completed,
    charDataDir,
    conversationDir,
    ctx: {
      config,
      autonomy: {
        onCompactionComplete: (character, turnCount) => completed.push([character, turnCount]),
      },
      run: {
        generate: () => {
          throw new Error("the pass ran, and this case was meant to answer before it could");
        },
      },
    },
  };
}

async function listing(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names: string[] = [];
  for (const e of entries) {
    if (e.name === "threads") {
      const inner = await readdir(join(dir, "threads", "main"), { withFileTypes: true });
      names.push(...inner.map((i) => (i.isDirectory() ? `${i.name}/` : i.name)));
      continue;
    }
    names.push(e.isDirectory() ? `${e.name}/` : e.name);
  }
  names.push(...listDurableFiles(dir).filter((name) => name !== "threads").map((name) => name === "active_prompt" ? `${name}/` : name));
  names.push(...listDurableFiles(join(dir, "threads", "main")));
  return [...new Set(names)].filter((name) => name !== "autonomy_state.json").sort();
}

async function refusal(call: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    const data = await call();
    return { kind: "ok", data };
  } catch (e) {
    if (e instanceof CommandError) return { kind: "err", code: e.code, message: e.message };
    throw e;
  }
}

describe("parseCompactArgs", () => {
  for (const c of fixture.parse_args) {
    test(c.note, () => {
      const got = parseCompactArgs(c.args);
      expect(got.dryRun).toBe(c.dry_run);
      expect(got.restart).toBe(("restart" in c ? c.restart : false) as never);
      expect(got.keepTurnsOverride).toBe((c.keep_turns ?? undefined) as never);
    });
  }
});

describe("the refusals compact makes before the assembly", () => {
  for (const c of fixture.guards) {
    test(c.note, async () => {
      const w = await world(c.messages === 0 ? [] : SEEDED);

      const twice = c.note.startsWith("a second call");
      const held = c.guard_held ? tryBeginCompaction(w.config.dirs.data, "ada") : undefined;
      expect(c.guard_held).toBe(held !== undefined);

      if (twice) await refusal(async () => await compact(w.engine, w.ctx, {}));
      const got = await refusal(async () => await compact(w.engine, w.ctx, {}));
      held?.release();

      expect(got).toEqual(c.output as never);
    });
  }
});

describe("compaction model selection and claim ownership", () => {
  async function configuredChat(): Promise<World> {
    const w = await world(SEEDED.map((message) => ({ ...message, version: newMessageVersion() })));
    w.config.providers = ProviderRegistry.fromSection({ claude_agent: { sdk: "claude_agent" } });
    await setThreadModel(w.config.dirs.data, "ada", "main", "claude_agent:claude-opus-4-8", "2026-09-15T00:00:00Z");
    return w;
  }

  test.each([
    { name: "character prompt", files: { "characters/ada/prompts/compact.md": "Preserve {{char}}'s memories for {{user}}." } },
    { name: "global prompt", files: { "prompts/compact.md": "Preserve {{char}}'s memories for {{user}}." } },
    { name: "character prompt before global prompt", files: {
      "characters/ada/prompts/compact.md": "Preserve {{char}}'s memories for {{user}}.",
      "prompts/compact.md": "Global prompt.",
    } },
    { name: "old split files are ignored", files: {
      "characters/ada/prompts/compact.md": "Preserve {{char}}'s memories for {{user}}.",
      "characters/ada/prompts/compact_rules.md": "Old character rules.",
      "characters/ada/prompts/compact_system.md": "Old character system.",
      "prompts/compact_rules.md": "Old global rules.",
      "prompts/compact_system.md": "Old global system.",
    } },
    { name: "empty character prompt before global prompt", files: {
      "characters/ada/prompts/compact.md": "",
      "prompts/compact.md": "Global prompt.",
    }, expected: "" },
    { name: "combined default prompt", files: {}, expected: DEFAULT_COMPACT_PROMPT.replaceAll("{{char}}", "ada").replaceAll("{{user}}", "Tom") },
  ])("compact sends and resumes one complete prompt: $name", async ({ files, expected }) => {
    const w = await configuredChat();
    w.config.app.memory.git_push = false;
    w.config.app.defaults.display_name = "Tom";
    const prompts = join(w.config.dirs.config, "characters", "ada", "prompts");
    await mkdir(prompts, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      const path = join(w.config.dirs.config, file);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text);
    }
    const requests: SidecarRequest[] = [];
    w.ctx.run.generate = async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) throw new Error("provider unavailable");
      return {
        content: "Summary complete", content_blocks: [{ type: "text", text: "Summary complete" }],
        finish_reason: "end_turn", model: request.model,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    };
    expect(await compact(w.engine, w.ctx, { keep_turns: 0 })).toMatchObject({ status: "paused" });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(request?.messages.at(-1)?.content).toEqual([
      { type: "text", text: expected ?? "Preserve ada's memories for Tom." },
    ]);
    expect(request?.messages.at(-1)?.transient_tail).toBe(1);
    expect(JSON.stringify(request?.system)).not.toContain("Preserve ada's memories for Tom.");
    const checkpoint = await loadCompactionCheckpoint(w.config.dirs.data, "ada", "main");
    expect(checkpoint?.request.messages).toEqual(request?.messages);
    expect(w.engine.turnCount()).toBe(1);
    await writeFile(join(prompts, "compact.md"), "Changed prompt for the next pass.");
    expect(await compact(w.engine, w.ctx, { keep_turns: 0 })).toMatchObject({ status: "compacted" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual(request?.messages);
    expect(w.engine.turnCount()).toBe(0);
  });

  test("missing model errors stay actionable on every retry and fixing the model allows immediate compaction", async () => {
    const w = await world(SEEDED.map((message) => ({ ...message, version: newMessageVersion() })));
    const before = structuredClone(w.engine.messages());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await refusal(() => compact(w.engine, w.ctx, { keep_turns: 0 }))).toEqual({
        kind: "err", code: "internal_error", message: "llm: No chat model configured for compaction prefix rebuild",
      });
      expect(w.engine.turnCount()).toBe(1);
      expect(w.engine.messages()).toEqual(before);
    }

    w.config.providers = ProviderRegistry.fromSection({ claude_agent: { sdk: "claude_agent" } });
    await setThreadModel(w.config.dirs.data, "ada", "main", "claude_agent:claude-opus-4-8", "2026-09-15T00:00:00Z");
    w.config.app.memory.git_push = false;
    w.ctx.run.generate = async () => ({
      content: "Summary complete", content_blocks: [{ type: "text", text: "Summary complete" }],
      finish_reason: "end_turn", model: "claude-opus-4-8",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    });
    expect(await compact(w.engine, w.ctx, { keep_turns: 0 })).toMatchObject({
      status: "compacted", compacted_turns: 1, retained_turns: 0,
    });
    expect(w.engine.turnCount()).toBe(0);
    const store = HistoryStore.open(join(w.config.dirs.data, HISTORY_DB_FILE));
    try {
      expect(store.readSegment("ada", 0).map((message) => message.msg_id)).toEqual(before.map((message) => message.msg_id));
    } finally {
      store.close();
    }
  });

  test.each([
    ["main", undefined, "claude-opus-4-8"],
    ["side", undefined, "claude-sonnet-4-6"],
    ["main", "missing-model", "claude-opus-4-8"],
    ["main", "claude_agent:claude-sonnet-4-6", "claude-sonnet-4-6"],
  ] as const)("compact uses its thread's chat model unless overridden (%s, %s)", async (thread, override, expectedModel) => {
    const w = await configuredChat();
    let engine = w.engine;
    if (thread === "side") {
      await createThread(w.config.dirs.data, "ada", thread, "2026-09-15T00:00:00Z", {
        chat_model: "claude_agent:claude-sonnet-4-6",
      });
      engine = await ConversationEngine.load("ada", w.config.dirs.data, undefined, thread);
      for (const message of w.engine.messages()) await engine.appendMessage(structuredClone(message));
    }
    w.config.app.defaults.background.compaction = override;
    w.config.app.memory.git_push = false;
    const seen: string[] = [];
    w.ctx.run.generate = async (request) => {
      seen.push(request.model);
      return {
        content: "Summary complete", content_blocks: [{ type: "text", text: "Summary complete" }],
        finish_reason: "end_turn", model: request.model,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    };
    expect(await compact(engine, w.ctx, { keep_turns: 0 })).toMatchObject({
      status: "compacted", compacted_turns: 1, retained_turns: 0,
    });
    expect(seen).toEqual([expectedModel]);
    expect(engine.turnCount()).toBe(0);
    if (thread === "side") expect(w.engine.turnCount()).toBe(1);
  });

  test("a claim held by another pass reports busy and preserves the conversation and its claim", async () => {
    const w = await configuredChat();
    const store = HistoryStore.open(join(w.config.dirs.data, HISTORY_DB_FILE));
    try {
      const held = claimUncovered(store, "ada", "compaction", w.engine.messages());
      expect(await refusal(() => compact(w.engine, w.ctx, { keep_turns: 0 }))).toEqual({
        kind: "err", code: "busy",
        message: "Compaction for ada/main is waiting for another pass's memory claim to finish or expire; conversation kept",
      });
      expect(w.engine.turnCount()).toBe(1);
      expect(store.commitMemoryCoverage("ada", "compaction", held.claim)).toBe(2);
    } finally {
      store.close();
    }
  });

  test.each([
    [true, "claude_agent:claude-opus-4-8", "claude_agent", "claude-opus-4-8"],
    [false, "claude_agent:claude-sonnet-4-6", "claude_agent", "claude-sonnet-4-6"],
    [false, "zai-sub:glm-5.3", "zai", "glm-5.3"],
    [true, "zai-sub:glm-5.3", "zai", "glm-5.3"],
  ] as const)("paused compaction honors restart=%s and current model %s", async (restart, selected, sdk, model) => {
    const w = await configuredChat();
    w.config.app.memory.git_push = false;
    w.ctx.run.generate = async () => { throw new Error("session limit"); };
    expect(await compact(w.engine, w.ctx, { keep_turns: 0 })).toMatchObject({ status: "paused" });
    const checkpoint = await loadCompactionCheckpoint(w.config.dirs.data, "ada", "main");
    if (checkpoint === undefined) throw new Error("missing paused checkpoint");
    checkpoint.resumeAt = "2099-01-01T00:00:00Z";
    await saveCompactionCheckpoint(w.config.dirs.data, checkpoint, "main");

    const keyName = "SHORE_TEST_COMPACTION_MODEL_SWITCH_KEY";
    const previousKey = process.env[keyName];
    process.env[keyName] = "test-key";
    try {
      w.config.providers = ProviderRegistry.fromSection({
        claude_agent: { sdk: "claude_agent" },
        "zai-sub": { sdk: "zai", api_key_env: keyName },
      });
      await setThreadModel(w.config.dirs.data, "ada", "main", selected, "2026-09-15T01:00:00Z");
      const seen: { sdk: string; model: string }[] = [];
      w.ctx.run.generate = async (request) => {
        seen.push({ sdk: request.sdk, model: request.model });
        return {
          content: "Summary complete", content_blocks: [{ type: "text", text: "Summary complete" }],
          finish_reason: "end_turn", model: request.model,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          timing: { total_ms: 1, time_to_first_token_ms: 1 },
        };
      };
      expect(await compact(w.engine, w.ctx, { keep_turns: 0, restart })).toMatchObject({
        status: "compacted", compacted_turns: 1, retained_turns: 0,
      });
      expect(seen).toEqual([{ sdk, model }]);
      expect(w.engine.turnCount()).toBe(0);
      expect(await loadCompactionCheckpoint(w.config.dirs.data, "ada", "main")).toBeUndefined();
    } finally {
      if (previousKey === undefined) delete process.env[keyName];
      else process.env[keyName] = previousKey;
    }
  });

  test("a paused checkpoint keeps its claim even when the next attempt fails during setup", async () => {
    const w = await configuredChat();
    w.config.app.defaults.background.compaction = "claude_agent:claude-opus-4-8";
    w.ctx.run.generate = async () => { throw new Error("provider offline"); };
    expect(await compact(w.engine, w.ctx, { keep_turns: 0 })).toMatchObject({ status: "paused" });
    const checkpoint = await loadCompactionCheckpoint(w.config.dirs.data, "ada", "main");
    expect(checkpoint?.coverageClaim).toBeString();

    w.ctx.run.tools = { mcpToolDefs: () => { throw new Error("tools unavailable"); } };
    expect(await refusal(() => compact(w.engine, w.ctx, { keep_turns: 0 }))).toEqual({
      kind: "err", code: "internal_error", message: "tools unavailable",
    });
    const store = HistoryStore.open(join(w.config.dirs.data, HISTORY_DB_FILE));
    try {
      for (const message of w.engine.messages()) {
        expect(store.memoryCoverageState("ada", "compaction", message.version ?? "")).toMatchObject({
          state: "claimed", claim: checkpoint?.coverageClaim,
        });
      }
    } finally {
      store.close();
    }
    delete w.ctx.run.tools;
    expect(await compact(w.engine, w.ctx, { keep_turns: 0 })).toMatchObject({
      status: "paused", checkpoint_id: checkpoint?.id,
    });
    expect(w.engine.turnCount()).toBe(1);
  });
});

const CONSTRUCTORS: Record<string, ((detail: string) => CompactionError) | undefined> = {
  "llm: ": (d) => CompactionError.llm(d),
  "conversation: ": (d) => CompactionError.conversationManager(d),
  "markdown store: ": (d) => CompactionError.markdownStore(d),
};

describe("compactionError", () => {
  for (const c of fixture.errors) {
    test(c.note, () => {
      const prefix = Object.keys(CONSTRUCTORS).find((p) => c.message.startsWith(p));
      const built =
        c.message === "insufficient messages"
          ? CompactionError.insufficientMessages()
          : prefix === undefined
            ? undefined
            : CONSTRUCTORS[prefix]?.(c.message.slice(prefix.length));

      if (built === undefined) {
        expect(c.code).toBe("internal_error");
        return;
      }
      expect(built.message).toBe(c.message);
      const mapped = compactionError(built);
      expect(mapped.code).toBe(c.code as never);
      expect(mapped.message).toBe(c.message);
    });
  }

  test("the guard's refusal is busy, and carries no prefix", () => {
    const mapped = compactionError(CompactionError.busy("ada"));
    expect(mapped.code).toBe("busy");
    expect(mapped.message).toBe("Compaction already running for ada");
  });

  test("a failure from under the assembly keeps its own message", () => {
    const mapped = compactionError(new Error("API key environment variable SHORE_K is not set"));
    expect(mapped.code).toBe("internal_error");
    expect(mapped.message).toBe("API key environment variable SHORE_K is not set");
  });
});

function outcomeFor(data: Record<string, unknown>): CompactionOutcome {
  const n = (k: string): number => data[k] as number;
  const s = (k: string): string[] => data[k] as string[];

  if (data["status"] === "compacted") {
    return {
      kind: "compacted",
      memoryFilesWritten: s("memory_files_written"),
      conversationId: "ada",
      newConversationId: data["new_conversation_id"] as string,
      messageCount: n("message_count"),
      compactedTurns: n("compacted_turns"),
      retainedCount: n("retained_count"),
      retainedTurns: n("retained_turns"),
      markdownPaths: [],
      toolRounds: n("tool_rounds"),
      toolsCalled: s("tools_called"),
    };
  }
  return {
    kind: "dry_run",
    wouldWriteFiles: n("would_write_files"),
    fileOpsPreview: (data["file_ops_preview"] as { path: string; content_preview: string }[]).map(
      (p) => ({ path: p.path, content: expand(p.content_preview) }),
    ),
    messageCount: n("message_count"),
    compactedTurns: n("compacted_turns"),
    retainedCount: n("retained_count"),
    retainedTurns: n("retained_turns"),
    markdownPreview: [],
    toolRounds: n("tool_rounds"),
    toolsCalled: s("tools_called"),
  };
}

function expand(preview: string): string {
  const chars = Array.from(preview);
  if (chars.length < 200) return preview;
  return preview + (chars.at(-1) ?? "").repeat(50);
}

describe("buildCompactionResponse", () => {
  for (const c of fixture.renderings) {
    test(c.note, async () => {
      const w = await world(SEEDED);
      if (c.deferred !== null) await queueDeferredEdit(w.charDataDir, c.deferred);

      expect(await listing(w.charDataDir)).toEqual(c.data_dir_before);

      const data = (c.output as { data: Record<string, unknown> }).data;
      const got = await buildCompactionResponse(w.engine, w.ctx, "ada", outcomeFor(data));

      expect(got).toEqual(data as never);
      expect(await listing(w.charDataDir)).toEqual(c.data_dir_after);

      expect(w.completed).toEqual(
        data["status"] === "compacted" ? [["ada", data["retained_turns"] as number]] : [],
      );
    });
  }

  test("a reload that fails is the command's failure, before anything is applied", async () => {
    const w = await world(SEEDED);
    await queueDeferredEdit(w.charDataDir, "SOUL.md");
    const engine = {
      characterName: "ada",
      reload: () => Promise.reject(new Error("active.jsonl: permission denied")),
    };

    const got = await refusal(
      async () =>
        await buildCompactionResponse(engine, w.ctx, "ada", outcomeFor({
          status: "compacted",
          memory_files_written: [],
          new_conversation_id: "conv_1",
          message_count: 1,
          compacted_turns: 1,
          retained_count: 1,
          retained_turns: 1,
          tool_rounds: 0,
          tools_called: [],
        })),
    );

    expect(got).toEqual({
      kind: "err",
      code: "internal_error",
      message: "active.jsonl: permission denied",
    });
    expect(await listing(w.charDataDir)).toContain("deferred_edits.jsonl");
    expect(w.completed).toEqual([]);
  });

  test("a deferred-edit failure only warns; the pass still succeeded", async () => {
    const w = await world(SEEDED);
    w.ctx.config.dirs.config = join(w.charDataDir, "threads", "main", "active.jsonl");

    const got = await buildCompactionResponse(w.engine, w.ctx, "ada", outcomeFor({
      status: "compacted",
      memory_files_written: [],
      new_conversation_id: "conv_1",
      message_count: 1,
      compacted_turns: 1,
      retained_count: 1,
      retained_turns: 2,
      tool_rounds: 0,
      tools_called: [],
    }));

    expect((got as Record<string, unknown>)["status"]).toBe("compacted");
    expect(w.completed).toEqual([["ada", 2]]);
  });
});

test("every error kind maps to a code", () => {
  const kinds: CompactionErrorKind[] = [
    "llm",
    "insufficient_messages",
    "conversation",
    "markdown_store",
    "busy",
  ];
  const codes = kinds.map((k) => compactionError(new CompactionError(k, "detail")).code);
  expect(codes).toEqual([
    "internal_error",
    "invalid_request",
    "internal_error",
    "internal_error",
    "busy",
  ]);
});

describe("write_memory = false", () => {
  const SIX = [
    ["m_1", "user", "first question"],
    ["m_2", "assistant", "first answer"],
    ["m_3", "user", "second question"],
    ["m_4", "assistant", "second answer"],
    ["m_5", "user", "third question"],
    ["m_6", "assistant", "third answer"],
  ].map(([id, role, text]) => ({
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp: "2026-01-01T10:00:00-05:00",
  }));

  async function disableWriteMemory(w: World): Promise<void> {
    await writeFile(
      join(w.config.dirs.config, "characters", "ada", "config.toml"),
      "[memory.compaction]\nwrite_memory = false\n",
    );
  }

  test("shore compact rotates instead of running the memory model", async () => {
    const w = await world(SIX);
    await disableWriteMemory(w);

    const got = (await compact(w.engine, w.ctx, { keep_turns: 1 })) as Record<string, unknown>;

    expect(got["status"]).toBe("rotated");
    expect(got["memory_files_written"]).toEqual([]);
    expect(got["archived_messages"]).toBe(4);
    expect(got["compacted_turns"]).toBe(2);
    expect(got["retained_turns"]).toBe(1);
    expect(w.completed).toEqual([["ada", 1]]);
  });

  test("a dry run archives nothing", async () => {
    const w = await world(SIX);
    await disableWriteMemory(w);

    const got = (await compact(w.engine, w.ctx, {
      keep_turns: 1,
      dry_run: true,
    })) as Record<string, unknown>;

    expect(got["status"]).toBe("rotated");
    expect(got["dry_run"]).toBe(true);
    expect(got["archived_messages"]).toBe(4);
    expect(w.completed).toEqual([]);
    expect(await listing(w.charDataDir)).toEqual(["active.jsonl"]);
  });

  test("the prefix a compaction reuses is built on the thread's own model", async () => {
    const chatModel = (name: string, replay: string | undefined) =>
      ({
        name,
        qualifiedName: `chat.${name}`,
        category: "chat",
        providerKey: "anthropic",
        sdk: "anthropic",
        modelId: `claude-${name}`,
        apiKeyEnv: "SHORE_COMPACT_TEST_KEY",
        maxContextTokens: 200_000,
        maxOutputTokens: 4096,
        ...(replay === undefined ? {} : { replayPriorThinking: replay }),
      }) as never;

    async function replayOf(
      pins: { main?: string; scratch?: string },
      thread?: string,
    ): Promise<string | undefined> {
      const w = await world(SIX);
      w.config.models.chat.set("chat.plain", chatModel("plain", undefined));
      w.config.models.chat.set("chat.quiet", chatModel("quiet", "none"));
      w.config.app.defaults.model = "plain";
      const now = "2026-09-03T12:00:00.000Z";
      if (pins.main !== undefined) {
        await setThreadModel(w.config.dirs.data, "ada", "main", pins.main, now);
      }
      if (thread !== undefined) {
        await createThread(
          w.config.dirs.data,
          "ada",
          thread,
          now,
          pins.scratch === undefined ? {} : { chat_model: pins.scratch },
        );
        await writeFile(
          join(w.charDataDir, "threads", thread, "active.jsonl"),
          SIX.map((m) => JSON.stringify(m)).join("\n") + "\n",
        );
      }

      let seen: { replay_prior_thinking?: string } | undefined;
      const engine = await ConversationEngine.load(
        "ada",
        w.config.dirs.data,
        undefined,
        thread ?? "main",
      );
      const ctx: CompactContext = {
        ...w.ctx,
        run: {
          generate: (request: { replay_prior_thinking?: string }) => {
            seen = request;
            throw new Error("captured");
          },
        },
      };

      await compact(engine, ctx, { keep_turns: 1 }).catch(() => undefined);
      return seen?.replay_prior_thinking;
    }

    process.env["SHORE_COMPACT_TEST_KEY"] = "sk-test";
    try {
      expect(await replayOf({})).toBe("all");
      expect(await replayOf({ main: "chat.quiet" })).toBe("none");
      expect(await replayOf({ scratch: "chat.quiet" }, "scratch")).toBe("none");
      expect(await replayOf({ main: "chat.quiet" }, "scratch")).toBe("all");
    } finally {
      delete process.env["SHORE_COMPACT_TEST_KEY"];
    }
  });

  test("the character config decides, not the global one", async () => {
    const w = await world(SIX);
    expect(w.config.app.memory.compaction.write_memory).toBe(true);
    await disableWriteMemory(w);

    const got = (await compact(w.engine, w.ctx, { keep_turns: 1 })) as Record<string, unknown>;

    expect(got["status"]).toBe("rotated");
  });
});
