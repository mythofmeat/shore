import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./autonomy_captures/deep_archive.json" with { type: "json" };
import { MessageStore } from "../src/engine/message_store.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { conversationManager } from "../src/memory/compaction/archive.ts";
import { tryBeginCompaction } from "../src/memory/compaction/manager.ts";
import {
  deepArchiveNotification,
  deepArchivePlan,
  runDeepIdleArchive,
  type DeepArchiveDeps,
} from "../src/autonomy/deep_archive.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { testTmp } from "./support/tmp.ts";

interface Shape {
  role: string;
  msg_id: string;
  content: string;
  autonomous: boolean;
  tool_result_only: boolean;
}

function fromShape(s: Shape): Message {
  const base: Message = {
    msg_id: s.msg_id,
    role: s.role as Message["role"],
    content: s.content,
    images: [],
    content_blocks: s.tool_result_only
      ? [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }]
      : [{ type: "text", text: s.content }],
    alternatives: [],
    timestamp: "2026-01-01T10:00:00-05:00",
  };
  return s.autonomous ? { ...base, origin: "autonomous" } : base;
}

async function world(
  content: Message[] | string,
  priorSegment = false,
  opts: { backgroundModel?: boolean } = {},
): Promise<{ config: LoadedConfig; dataDir: string; characterDir: string }> {
  const root = await mkdtemp(testTmp("shore-deeparch-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const characterDir = join(dirs.data, "ada");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  await writeFile(
    join(characterDir, "threads", "main", "active.jsonl"),
    typeof content === "string"
      ? content
      : content.map((m) => JSON.stringify(m)).join("\n") + (content.length === 0 ? "" : "\n"),
  );

  if (priorSegment) {
    await mkdir(join(characterDir, "threads", "main", "segments"), { recursive: true });
    await writeFile(join(characterDir, "threads", "main", "segments", "0001.jsonl"), "{}\n");
    await writeFile(
      join(characterDir, "threads", "main", "compaction.json"),
      JSON.stringify(
        {
          segments: [
            { file: "0001.jsonl", message_count: 4, compacted_at: "2025-12-01T09:00:00-05:00" },
          ],
          total_compacted_messages: 4,
        },
        null,
        2,
      ),
    );
  }

  const app = defaultAppConfig();
  const models = emptyCatalog();
  if (opts.backgroundModel === true) {
    app.defaults.model = "fixture";
    models.chat.set("chat.fixture", FIXTURE_MODEL);
  }

  return {
    dataDir: dirs.data,
    characterDir,
    config: { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

const FIXTURE_MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_FIXTURE_API_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  maxToolIterations: 4,
} as never;

async function loadThroughStore(shapes: Shape[]): Promise<Message[]> {
  const { characterDir } = await world(shapes.map(fromShape));
  const store = await MessageStore.load(join(characterDir, "threads", "main", "active.jsonl"));
  return [...store.messages()];
}

async function segmentsAfter(characterDir: string): Promise<Record<string, string>> {
  let names: string[];
  try {
    names = (await readdir(join(characterDir, "threads", "main", "segments"))).sort();
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = await readFile(join(characterDir, "threads", "main", "segments", name), "utf8");
  }
  return out;
}

async function manifestAfter(characterDir: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(characterDir, "threads", "main", "compaction.json"), "utf8");
  } catch {
    return null;
  }
  const v = JSON.parse(raw) as { segments?: { compacted_at?: string }[] };
  for (const seg of v.segments ?? []) seg.compacted_at = "<stamp>";
  return v;
}

describe("deepArchivePlan", () => {
  for (const [i, kase] of fixture.plan.entries()) {
    test(`case ${i}: ${kase.note}`, async () => {
      const messages = await loadThroughStore(kase.input);
      expect(deepArchivePlan(messages, kase.covered_turn_count)).toEqual(kase.plan as never);
    });
  }

  test("the covered comparison is equality, not a floor", () => {
    const above = fixture.plan.find((c) => c.note.startsWith("covered count above"));
    expect(above?.plan.arm).toBe("compaction");
  });
});

describe("the pure archive", () => {
  for (const [i, kase] of fixture.pure_archive.entries()) {
    test(`case ${i}: ${kase.note}`, async () => {
      const { characterDir } = await world(kase.active_before, kase.prior_segment);
      const { store, raw } = await MessageStore.loadWithRaw(join(characterDir, "threads", "main", "active.jsonl"));

      const plan = deepArchivePlan(store.messages(), kase.covered_turn_count);
      expect(plan).toEqual(kase.plan as never);
      if (plan.arm !== "pure") throw new Error("the fixture case must take the pure arm");

      const newId = await conversationManager(
        join(characterDir, "threads", "main"),
        () => "2026-01-01T10:00:00-05:00",
        () => "conv-fixture",
      ).archiveAndRetain("deep-idle", { keepLastN: plan.tail, activeContent: raw });

      expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(kase.active_after);
      expect(await segmentsAfter(characterDir)).toEqual(kase.segments_after as never);
      expect(await manifestAfter(characterDir)).toEqual(kase.manifest_after as never);
      expect(newId.length > 0).toBe(kase.new_conversation_id_is_fresh);
      expect(deepArchiveNotification("ada", plan.archivable)).toEqual(
        kase.notification as never,
      );
    });
  }
});

describe("deepArchiveNotification", () => {
  for (const kase of fixture.notification) {
    test(`${kase.archivable} archivable`, () => {
      expect(deepArchiveNotification("ada", kase.archivable)).toEqual(kase.notification as never);
    });
  }
});

function deps(config: LoadedConfig, over: Partial<DeepArchiveDeps> = {}): DeepArchiveDeps {
  return {
    config,
    cache: new LastRequestCache(),
    now: () => "2026-01-01T10:00:00-05:00",
    newId: () => "conv-fixture",
    ...over,
  };
}

describe("runDeepIdleArchive", () => {
  test("archive-only mode sweeps uncovered turns without compaction dependencies", async () => {
    const uncovered = required(fixture.plan.find((kase) => kase.plan.arm === "compaction"));
    const messages = uncovered.input.map((shape) => fromShape(shape));
    const { config, dataDir, characterDir } = await world(messages);
    config.app.memory.compaction.write_memory = false;
    config.app.memory.retain.enabled = true;

    const result = await runDeepIdleArchive("ada", deps(config), uncovered.covered_turn_count);

    expect(result).toEqual({ turnCount: 0, events: [], deepArchiveDone: true });
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe("");
    const history = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
    expect(history.nextMemoryRetainJob("ada")).toMatchObject({
      segment: 0,
      action: "retain",
    });
    history.close();
  });

  test("nothing to archive quiesces, and says the idle period is finished", async () => {
    const { config, characterDir } = await world([
      fromShape(required(fixture.plan[1]).input[0] as Shape),
    ]);
    const before = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");

    const notes: [string, string][] = [];
    const result = await runDeepIdleArchive(
      "ada",
      deps(config, { notify: (t, b) => notes.push([t, b]) }),
      0,
    );

    expect(result).toEqual({ events: [], deepArchiveDone: true });
    expect(result.turnCount).toBeUndefined();
    expect(notes).toEqual([]);
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(before);
  });

  for (const [i, kase] of fixture.pure_archive.entries()) {
   test(`the pure arm archives case ${i}, reports zero turns, finishes the period`, async () => {
    const { config, characterDir } = await world(kase.active_before, kase.prior_segment);

    const notes: [string, string][] = [];
    const reloaded: string[] = [];
    const result = await runDeepIdleArchive(
      "ada",
      deps(config, {
        notify: (title, body) => notes.push([title, body]),
        engine: {
          reload: async (c) => {
            reloaded.push(c);
          },
        },
      }),
      kase.covered_turn_count,
    );

    expect(result).toEqual({ turnCount: 0, events: [], deepArchiveDone: true });
    expect(notes).toEqual([[kase.notification.title, kase.notification.body]]);
    expect(reloaded).toEqual(["ada"]);
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(kase.active_after);
    const segments = await segmentsAfter(characterDir);
    if (kase.prior_segment) expect(segments).toEqual({ "0001.jsonl": "{}\n" });
    else expect(segments).toEqual({});
   });
  }

  test("the pure arm invalidates the cached body and re-points the keepalive", async () => {
    const kase = required(fixture.pure_archive[0]);
    const { config } = await world(kase.active_before);

    const disarmed: string[] = [];
    const armed: string[] = [];
    const cache = new LastRequestCache({
      arm: (p: { context?: { character: string } }) => armed.push(p.context?.character ?? "?"),
      disarm: (c: string) => disarmed.push(c),
      forgetMisses: () => {},
    } as never);
    cache.set("ada", { model: "stale" } as never, undefined);

    await runDeepIdleArchive("ada", deps(config, { cache }), kase.covered_turn_count);

    expect(cache.get("ada")).toBeUndefined();
    expect(disarmed).toEqual(["ada"]);
    expect(armed).toEqual(["ada"]);
  });

  test("an engine reload that throws is a warning, not a failed archive", async () => {
    const kase = required(fixture.pure_archive[0]);
    const { config, characterDir } = await world(kase.active_before);

    const result = await runDeepIdleArchive(
      "ada",
      deps(config, {
        engine: {
          reload: () => Promise.reject(new Error("registry is gone")),
        },
      }),
      kase.covered_turn_count,
    );

    expect(result.failed).toBeUndefined();
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(kase.active_after);
  });

  test("a failed archive reports failure and does not finish the idle period", async () => {
    const kase = required(fixture.pure_archive[0]);
    const { config, characterDir } = await world(kase.active_before);
    await mkdir(join(config.dirs.data, "history.db"));

    const result = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);

    expect(typeof result.failed).toBe("string");
    expect(result.deepArchiveDone).toBe(false);
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(
      kase.active_before,
    );
  });

  test("a conversation that will not load is a failure, not nothing to do", async () => {
    const kase = required(fixture.pure_archive[0]);
    const { config, characterDir } = await world(kase.active_before);
    await rm(join(characterDir, "threads", "main", "active.jsonl"));
    await mkdir(join(characterDir, "threads", "main", "active.jsonl"));

    const result = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);

    expect(typeof result.failed).toBe("string");
    expect(result.deepArchiveDone).toBe(false);
  });

  test("the LLM arm archives a keep-0 pass that wrote nothing, and does not finish the idle period", async () => {
    const kase = required(fixture.plan.find((c) => c.plan.arm === "compaction"));
    const { config, characterDir } = await world((kase.input as Shape[]).map(fromShape), false, {
      backgroundModel: true,
    });
    process.env["SHORE_FIXTURE_API_KEY"] = "sk-fixture";

    const seen: { keepTurns: unknown }[] = [];
    const result = await runDeepIdleArchive(
      "ada",
      deps(config, {
        run: {
          generate: async () => {
            seen.push({ keepTurns: 0 });
            return {
              content: "nothing worth writing down",
              content_blocks: [{ type: "text", text: "nothing worth writing down" }],
              finish_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
              timing: {},
              model: "claude-fixture",
            } as never;
          },
        },
      }),
      kase.covered_turn_count,
    );

    delete process.env["SHORE_FIXTURE_API_KEY"];
    expect(seen.length).toBeGreaterThan(0);
    expect(result.turnCount).toBe(0);
    expect(result.failed).toBeUndefined();
    expect(result.deepArchiveDone).toBe(false);
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe("");
  });

  test("the keep-0 pass retains the unanswered autonomous run", async () => {
    const kase = required(fixture.plan.find(
      (c) => c.plan.arm === "compaction" && c.note.startsWith("uncovered"),
    ));
    const messages = (kase.input as Shape[]).map(fromShape);
    messages.push({
      msg_id: "m_9",
      role: "assistant",
      content: "thinking of you",
      images: [],
      content_blocks: [{ type: "text", text: "thinking of you" }],
      alternatives: [],
      timestamp: "2026-01-01T10:00:00-05:00",
      origin: "autonomous",
    });
    const { config, characterDir } = await world(messages, false, { backgroundModel: true });
    await mkdir(join(config.dirs.config, "characters", "ada", "workspace", "memory"), {
      recursive: true,
    });
    process.env["SHORE_FIXTURE_API_KEY"] = "sk-fixture";

    let round = 0;
    const result = await runDeepIdleArchive(
      "ada",
      deps(config, {
        run: {
          generate: async () => {
            round += 1;
            const blocks =
              round === 1
                ? [
                    {
                      type: "tool_use",
                      id: "toolu_1",
                      name: "edit",
                      input: { path: "memory/boats.md", content: "- a thing that floats\n" },
                    },
                  ]
                : [{ type: "text", text: "done" }];
            return {
              content: round === 1 ? "" : "done",
              content_blocks: blocks,
              finish_reason: round === 1 ? "tool_use" : "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
              timing: {},
              model: "claude-fixture",
            } as never;
          },
        },
      }),
      kase.covered_turn_count,
    );
    delete process.env["SHORE_FIXTURE_API_KEY"];

    expect(result.failed).toBeUndefined();
    expect(result.deepArchiveDone).toBe(false);
    const after = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");
    const ids = after
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (JSON.parse(l) as { msg_id: string }).msg_id);
    expect(ids).toEqual(["m_9"]);
  });

  test("a keep-0 pass that cannot run reports failure and finishes nothing", async () => {
    const kase = required(fixture.plan.find((c) => c.plan.arm === "compaction"));
    const { config } = await world((kase.input as Shape[]).map(fromShape));

    const result = await runDeepIdleArchive(
      "ada",
      deps(config, {
        run: {
          generate: (() => {
            throw new Error("unused");
          }),
        },
      }),
      kase.covered_turn_count,
    );

    expect(result.deepArchiveDone).toBe(false);
    expect(result.failed).toBeDefined();
  });

  test("no compaction dependencies is a failure, not a silent archive", async () => {
    const kase = required(fixture.plan.find((c) => c.plan.arm === "compaction"));
    const { config, characterDir } = await world((kase.input as Shape[]).map(fromShape));
    const before = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");

    const result = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);

    expect(result.deepArchiveDone).toBe(false);
    expect(result.failed).toBeDefined();
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(before);
  });

  test("a compaction already in flight refuses rather than archiving underneath it", async () => {
    const kase = required(fixture.pure_archive[0]);
    const { config, dataDir, characterDir } = await world(kase.active_before);
    const before = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");

    const held = required(tryBeginCompaction(dataDir, "ada"));
    const refused = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);

    expect(refused.failed).toBeDefined();
    expect(refused.deepArchiveDone).toBe(false);
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(before);

    held.release();
    const second = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);
    expect(second.failed).toBeUndefined();
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(kase.active_after);

    const third = tryBeginCompaction(dataDir, "ada");
    expect(third).toBeDefined();
    third?.release();
  });

  test("a broken legacy segments path cannot block a database archive", async () => {
    const kase = required(fixture.pure_archive[0]);
    const { config, characterDir } = await world(kase.active_before);
    await writeFile(join(characterDir, "threads", "main", "segments"), "not a directory");

    const result = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);

    expect(result.failed).toBeUndefined();
    expect(result.deepArchiveDone).toBe(true);
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(kase.active_after);
  });

  test("a conversation with one unreadable line still opens, minus that line", async () => {
    const { config, characterDir } = await world([]);
    await writeFile(join(characterDir, "threads", "main", "active.jsonl"), "{not json\n");

    const result = await runDeepIdleArchive("ada", deps(config), 0);
    expect(result.failed).toBeUndefined();
  });
});
