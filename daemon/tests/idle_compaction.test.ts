import { readFile } from "./support/stored_files.ts";
import { toolGeneration } from "./support/tool_generation.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Message } from "../src/engine/types.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { runIdleCompaction, type IdleCompactionDeps } from "../src/autonomy/idle_compaction.ts";
import { tryBeginCompaction } from "../src/memory/compaction/manager.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { testTmp } from "./support/tmp.ts";

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

function message(role: "user" | "assistant", id: string, text: string, autonomous = false): Message {
  const base: Message = {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp: "2026-01-01T10:00:00-05:00",
  };
  return autonomous ? { ...base, origin: "autonomous" } : base;
}

function conversation(): Message[] {
  return [
    message("user", "m_1", "morning"),
    message("assistant", "m_2", "morning to you"),
    message("user", "m_3", "did you sleep"),
    message("assistant", "m_4", "in a manner of speaking"),
    message("user", "m_5", "tell me about boats"),
    message("assistant", "m_6", "they float"),
  ];
}

async function world(
  messages: Message[] = conversation(),
): Promise<{ config: LoadedConfig; dataDir: string; characterDir: string }> {
  const root = await mkdtemp(testTmp("shore-idlecompact-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  await mkdir(join(dirs.config, "characters", "ada", "workspace", "memory"), { recursive: true });

  const characterDir = join(dirs.data, "ada");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  await writeFile(
    join(characterDir, "threads", "main", "active.jsonl"),
    messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length === 0 ? "" : "\n"),
  );

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", FIXTURE_MODEL);

  return {
    dataDir: dirs.data,
    characterDir,
    config: { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

function writingModel(seen: { messages: unknown[] }[] = []) {
  let round = 0;
  return async (req: { messages?: unknown[] }) => {
    round += 1;
    seen.push({ messages: req.messages ?? [] });
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
  };
}

function deps(config: LoadedConfig, over: Partial<IdleCompactionDeps> = {}): IdleCompactionDeps {
  const raw = over.run?.generate ?? writingModel();
  return {
    config,
    cache: new LastRequestCache(),
    ...over,
    ...("run" in over && over.run === undefined ? {} : {
      run: {
        ...over.run,
        generate: (request, model, character, sink, tools, options) =>
          tools === undefined
            ? raw(request, model, character, sink)
            : toolGeneration(async (call) => raw(call, model, character, sink))(request, tools, undefined, options),
      },
    }),
  };
}

async function activeIds(characterDir: string): Promise<string[]> {
  const raw = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (JSON.parse(l) as Message).msg_id);
}

async function segmentNames(characterDir: string): Promise<string[]> {
  try {
    return (await readdir(join(characterDir, "threads", "main", "segments"))).sort();
  } catch {
    return [];
  }
}

function historySegmentCount(dataDir: string): number {
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    return store.segmentCount("ada");
  } finally {
    store.close();
  }
}

const stale = () =>
  ({ model: "claude-fixture", messages: [{ role: "user", content: "before" }] }) as never;

function spyingCache(): { cache: LastRequestCache; armed: string[]; disarmed: string[] } {
  const armed: string[] = [];
  const disarmed: string[] = [];
  const cache = new LastRequestCache({
    arm: (p: { context?: { character: string } }) => armed.push(p.context?.character ?? "?"),
    disarm: (c: string) => disarmed.push(c),
    forgetMisses: () => {},
  } as never);
  return { cache, armed, disarmed };
}

function withKey<T>(fn: () => Promise<T>): Promise<T> {
  process.env["SHORE_FIXTURE_API_KEY"] = "sk-fixture";
  return fn().finally(() => {
    delete process.env["SHORE_FIXTURE_API_KEY"];
  });
}

describe("runIdleCompaction: the pass", () => {
  test("archive-only mode rotates history without calling the memory model", async () => {
    const { config, dataDir, characterDir } = await world();
    config.app.memory.compaction.write_memory = false;
    config.app.memory.retain.enabled = true;
    let generated = false;

    const result = await runIdleCompaction("ada", deps(config, {
      run: {
        generate: async () => {
          generated = true;
          throw new Error("archive-only mode must not call this");
        },
      },
    }));

    expect(generated).toBe(false);
    expect(result).toEqual({ turnCount: 2, events: [] });
    expect(await activeIds(characterDir)).toEqual(["m_3", "m_4", "m_5", "m_6"]);
    expect(historySegmentCount(dataDir)).toBe(1);
    const history = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
    expect(history.nextCharacterMemoryRetainJob("ada")).toMatchObject({
      segment: 0,
      action: "retain",
    });
    history.close();
    expect(existsSync(join(config.dirs.config, "characters", "ada", "workspace", "memory", "boats.md"))).toBe(false);
  });

  test("archive-only mode gives the compaction slot back", async () => {
    const { config, dataDir } = await world();
    config.app.memory.compaction.write_memory = false;

    await runIdleCompaction("ada", deps(config));

    const guard = tryBeginCompaction(dataDir, "ada");
    expect(guard).toBeDefined();
    guard?.release();
  });

  test("keeps the configured retention, because it passes no keep-turns override", async () => {
    const { config, dataDir, characterDir } = await world();
    expect(config.app.memory.compaction.keep_recent_turns).toBe(2);

    const result = await withKey(() => runIdleCompaction("ada", deps(config)));

    expect(await activeIds(characterDir)).toEqual(["m_3", "m_4", "m_5", "m_6"]);
    expect(result.turnCount).toBe(2);
    expect(await segmentNames(characterDir)).toEqual([]);
    expect(historySegmentCount(dataDir)).toBe(1);
  });

  test("archives a trailing autonomous message rather than retaining it", async () => {
    const { config, characterDir } = await world([
      ...conversation(),
      message("assistant", "m_7", "thinking of you", true),
    ]);
    config.app.memory.compaction.keep_recent_turns = 0;

    await withKey(() => runIdleCompaction("ada", deps(config)));

    expect(await activeIds(characterDir)).toEqual([]);
  });

  test("rebuilds the pass from disk instead of compacting a stale cached body", async () => {
    const { config } = await world();
    const cache = new LastRequestCache();
    cache.set("ada", {
      model: "claude-fixture",
      messages: [{ role: "user", content: "a body only the cache has" }],
    } as never, undefined);

    const seen: { messages: unknown[] }[] = [];
    await withKey(() =>
      runIdleCompaction("ada", deps(config, { cache, run: { generate: writingModel(seen) } })),
    );

    const sent = JSON.stringify(seen[0]?.messages);
    expect(sent).not.toContain("a body only the cache has");
    expect(sent).toContain("morning");
  });
});

describe("runIdleCompaction: reporting", () => {
  test("a pass that worked reports the retained count and nothing else", async () => {
    const { config } = await world();

    const result = await withKey(() => runIdleCompaction("ada", deps(config)));

    expect(result).toEqual({ turnCount: 2, events: [] });
    expect(result.deepArchiveDone).toBeUndefined();
    expect(result.failed).toBeUndefined();
  });

  test("a pass that threw reports failed and does not throw", async () => {
    const { config, characterDir } = await world();
    config.models.chat.delete("chat.fixture");
    const before = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");

    const result = await runIdleCompaction("ada", deps(config));

    expect(result.failed).toBeDefined();
    expect(result.turnCount).toBeUndefined();
    expect(result.events).toEqual([]);
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe(before);
    expect(await segmentNames(characterDir)).toEqual([]);
  });

  test("no compaction dependencies is a failure, not a silent skip", async () => {
    const { config, characterDir } = await world();

    const result = await runIdleCompaction("ada", { config, cache: new LastRequestCache() });

    expect(result).toEqual({
      events: [],
      failed: "idle compaction has no compaction dependencies",
    });
    expect(await segmentNames(characterDir)).toEqual([]);
  });
});

describe("runIdleCompaction: putting the world back in step", () => {
  test("runs the pass, then reloads the engine, then drains the deferred edits", async () => {
    const { config, characterDir } = await world();
    const order: string[] = [];
    await writeFile(
      join(characterDir, "deferred_edits.jsonl"),
      JSON.stringify({ path: "prompt.md", operation: "append", content: "a line\n" }) + "\n",
    );

    const seen: { messages: unknown[] }[] = [];
    const model = writingModel(seen);
    await withKey(() =>
      runIdleCompaction(
        "ada",
        deps(config, {
          run: {
            generate: (async (req: never) => {
              order.push("pass");
              return await model(req);
            }) as never,
          },
          engine: {
            reload: async (c) => {
              order.push(`reload:${c}`);
            },
          },
        }),
      ),
    );

    expect(order).toEqual(["pass", "pass", "reload:ada"]);
    expect(existsSync(join(characterDir, "deferred_edits.jsonl"))).toBe(false);
  });

  test("an engine reload that throws is a warning, not a failed compaction", async () => {
    const { config, dataDir, characterDir } = await world();

    const result = await withKey(() =>
      runIdleCompaction(
        "ada",
        deps(config, { engine: { reload: () => Promise.reject(new Error("registry is gone")) } }),
      ),
    );

    expect(result.failed).toBeUndefined();
    expect(result.turnCount).toBe(2);
    expect(await segmentNames(characterDir)).toEqual([]);
    expect(historySegmentCount(dataDir)).toBe(1);
  });

  test("re-points the keepalive at the rebuilt prefix, not the pre-pass one", async () => {
    const { config } = await world();
    const { cache, armed, disarmed } = spyingCache();
    cache.set("ada", stale(), undefined);

    await withKey(() => runIdleCompaction("ada", deps(config, { cache })));

    expect(cache.get("ada")).toBeDefined();
    expect(cache.get("ada")).not.toEqual(stale());
    expect(armed).toEqual(["ada", "ada"]);
    expect(disarmed).toEqual([]);
  });

  test("a failed pass leaves the cached body alone", async () => {
    const { config } = await world();
    config.models.chat.delete("chat.fixture");
    const cache = new LastRequestCache();
    cache.set("ada", stale(), undefined);

    await runIdleCompaction("ada", deps(config, { cache }));

    expect(cache.get("ada")).toEqual(stale());
  });
});
