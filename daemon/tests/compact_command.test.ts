import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./commands_fixtures/compact_command.json" with { type: "json" };
import { ConversationEngine } from "../src/engine/conversation.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { queueDeferredEdit } from "../src/memory/deferred_edits.ts";
import { tryBeginCompaction } from "../src/memory/compaction/manager.ts";
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
  await mkdir(charDataDir, { recursive: true });
  const workspace = join(dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "# ada");
  await writeFile(
    join(charDataDir, "active.jsonl"),
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
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .filter((name) => name !== "autonomy_state.json")
    .sort();
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
      const got = parseCompactArgs(c.args as Record<string, unknown>);
      expect(got.dryRun).toBe(c.dry_run);
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
  if (data["status"] === "no_memory_writes") {
    return {
      kind: "no_memory_writes",
      conversationId: "ada",
      messageCount: n("message_count"),
      compactedTurns: n("compacted_turns"),
      toolRounds: n("tool_rounds"),
      toolsCalled: s("tools_called"),
      rejectedPaths: s("rejected_paths"),
      maxRoundsHit: data["max_rounds_hit"] as boolean,
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
  const chars = [...preview];
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
    w.ctx.config.dirs.config = join(w.charDataDir, "active.jsonl");

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
