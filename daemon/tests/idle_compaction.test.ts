/**
 * The idle-triggered compaction a tick runs, end to end against real files.
 *
 * There is no parity fixture here and that is deliberate — see the header of
 * `src/autonomy/idle_compaction.ts`. Everything the action delegates to is
 * pinned elsewhere (the pass by the compaction fixtures, the trigger by
 * `tick_parity.json`, the state writes by `autonomy_runner.test.ts`), so what is
 * left to protect is which pieces it calls, with what, and in what order. A
 * generated fixture would have recorded nothing these doubles do not.
 *
 * The two assertions worth naming, because both failure modes look like working
 * code:
 *
 * - **No `keepTurnsOverride`.** The deep archive's LLM arm passes zero, which
 *   empties the conversation. Passing zero here would archive a conversation the
 *   user is still in the middle of, every idle window.
 * - **No `retainTrailingAutonomous`.** That flag belongs to the archive, which
 *   is emptying the file and has to leave an unread heartbeat message standing.
 *   An ordinary idle pass is not emptying anything, and the keep window already
 *   decides what stays.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Message } from "../src/engine/types.ts";
import { LastRequestCache } from "../src/autonomy/last_request.ts";
import { runIdleCompaction, type IdleCompactionDeps } from "../src/autonomy/idle_compaction.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { testTmp } from "./support/tmp.ts";

// ── harness ─────────────────────────────────────────────────────────────

/** The background model the pass resolves to. */
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

/** Three exchanges: enough that a keep window leaves something behind. */
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

/** A character directory with a conversation, a memory dir and a model. */
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
  await mkdir(characterDir, { recursive: true });
  await writeFile(
    join(characterDir, "active.jsonl"),
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

/**
 * A model that writes one memory file and then stops.
 *
 * A pass whose model writes nothing takes the `no_memory_writes` branch and
 * archives nothing, so reaching the retention split at all needs a real write.
 * The generic tool loop only dispatches on `tool_use`, which is why the finish
 * reason changes on the second round.
 */
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
  return {
    config,
    cache: new LastRequestCache(),
    run: { generate: writingModel() as never },
    ...over,
  };
}

/** The message ids left in the active conversation, in order. */
async function activeIds(characterDir: string): Promise<string[]> {
  const raw = await readFile(join(characterDir, "active.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (JSON.parse(l) as Message).msg_id);
}

async function segmentNames(characterDir: string): Promise<string[]> {
  try {
    return (await readdir(join(characterDir, "segments"))).sort();
  } catch {
    return [];
  }
}

/** A cached body good enough to be used as the pass's prefix. */
const stale = () =>
  ({ model: "claude-fixture", messages: [{ role: "user", content: "before" }] }) as never;

/** A cache whose keepalive records what it was told, rather than doing it. */
function spyingCache(): { cache: LastRequestCache; armed: string[]; disarmed: string[] } {
  const armed: string[] = [];
  const disarmed: string[] = [];
  const cache = new LastRequestCache({
    arm: (p: { context?: { character: string } }) => armed.push(p.context?.character ?? "?"),
    disarm: (c: string) => disarmed.push(c),
  } as never);
  return { cache, armed, disarmed };
}

function withKey<T>(fn: () => Promise<T>): Promise<T> {
  process.env["SHORE_FIXTURE_API_KEY"] = "sk-fixture";
  return fn().finally(() => {
    delete process.env["SHORE_FIXTURE_API_KEY"];
  });
}

// ── 1. the pass it runs ─────────────────────────────────────────────────

describe("runIdleCompaction: the pass", () => {
  test("keeps the configured retention, because it passes no keep-turns override", async () => {
    const { config, characterDir } = await world();
    expect(config.app.memory.compaction.keep_recent_turns).toBe(2);

    const result = await withKey(() => runIdleCompaction("ada", deps(config)));

    // Two turns retained out of three. A `keepTurnsOverride: 0` — what the deep
    // archive's LLM arm passes — would leave this empty and archive an exchange
    // the user is still in.
    expect(await activeIds(characterDir)).toEqual(["m_3", "m_4", "m_5", "m_6"]);
    expect(result.turnCount).toBe(2);
    expect(await segmentNames(characterDir)).toEqual(["0001.jsonl"]);
  });

  test("archives a trailing autonomous message rather than retaining it", async () => {
    // `retainTrailingAutonomous` is the archive's flag: it is emptying the file
    // and must leave an unread heartbeat message standing. Here the keep window
    // already decides, so setting it would retain a message the split had
    // placed on the archive side. Reaching that difference needs the keep window
    // out of the way, which is what the zero is for.
    const { config, characterDir } = await world([
      ...conversation(),
      message("assistant", "m_7", "thinking of you", true),
    ]);
    config.app.memory.compaction.keep_recent_turns = 0;

    await withKey(() => runIdleCompaction("ada", deps(config)));

    expect(await activeIds(characterDir)).toEqual([]);
  });

  test("hands the pass the cached body, so the prefix is the warm one", async () => {
    const { config } = await world();
    const cache = new LastRequestCache();
    cache.set("ada", {
      model: "claude-fixture",
      messages: [{ role: "user", content: "a body only the cache has" }],
    } as never, undefined);

    const seen: { messages: unknown[] }[] = [];
    await withKey(() =>
      runIdleCompaction("ada", deps(config, { cache, run: { generate: writingModel(seen) as never } })),
    );

    // The pass prepends the chat request's messages, so the cached body's
    // marker is visible in what the model was asked. Without it the pass
    // rebuilds a colder prefix from disk and this message never appears.
    expect(JSON.stringify(seen[0]?.messages)).toContain("a body only the cache has");
  });
});

// ── 2. what it reports ──────────────────────────────────────────────────

describe("runIdleCompaction: reporting", () => {
  test("a pass that worked reports the retained count and nothing else", async () => {
    const { config } = await world();

    const result = await withKey(() => runIdleCompaction("ada", deps(config)));

    expect(result).toEqual({ turnCount: 2, events: [] });
    // Never the archive's field: an idle compaction is not the end of an idle
    // period, and claiming it would stop the deep archive ever running.
    expect(result.deepArchiveDone).toBeUndefined();
    expect(result.failed).toBeUndefined();
  });

  test("a pass that threw reports failed and does not throw", async () => {
    // No model configured for background work, which is what the assembly
    // refuses on. The Rust's failure arm cleared the latch and stamped the
    // activity clock without touching the turn counts; `failed` with no
    // `turnCount` is what lands the runner on exactly that.
    const { config, characterDir } = await world();
    config.models.chat.delete("chat.fixture");
    const before = await readFile(join(characterDir, "active.jsonl"), "utf8");

    const result = await runIdleCompaction("ada", deps(config));

    expect(result.failed).toBeDefined();
    expect(result.turnCount).toBeUndefined();
    expect(result.events).toEqual([]);
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(before);
    expect(await segmentNames(characterDir)).toEqual([]);
  });

  test("no compaction dependencies is a failure, not a silent skip", async () => {
    // The Rust returned here without touching state, which left the latch set
    // and stopped that character compacting until a user message cleared it.
    // Recorded in the module header as a deliberate difference.
    const { config, characterDir } = await world();

    const result = await runIdleCompaction("ada", { config, cache: new LastRequestCache() });

    expect(result).toEqual({
      events: [],
      failed: "idle compaction has no compaction dependencies",
    });
    expect(await segmentNames(characterDir)).toEqual([]);
  });
});

// ── 3. the bookkeeping afterwards ───────────────────────────────────────

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

    // The reload comes after the pass, not before: reloading first would put
    // the engine back in step with the conversation the pass is about to
    // rewrite.
    expect(order).toEqual(["pass", "pass", "reload:ada"]);
    // Drained — the queue file is removed once it has been applied. The reload
    // comes first because it is what busts the cached prompt these edits would
    // otherwise be written behind.
    expect(existsSync(join(characterDir, "deferred_edits.jsonl"))).toBe(false);
  });

  test("an engine reload that throws is a warning, not a failed compaction", async () => {
    const { config, characterDir } = await world();

    const result = await withKey(() =>
      runIdleCompaction(
        "ada",
        deps(config, { engine: { reload: () => Promise.reject(new Error("registry is gone")) } }),
      ),
    );

    // The pass already happened; there is nobody to report a reload failure to.
    expect(result.failed).toBeUndefined();
    expect(result.turnCount).toBe(2);
    expect(await segmentNames(characterDir)).toEqual(["0001.jsonl"]);
  });

  test("re-points the keepalive at the rebuilt prefix, not the pre-pass one", async () => {
    const { config } = await world();
    const { cache, armed, disarmed } = spyingCache();
    cache.set("ada", stale(), undefined);

    await withKey(() => runIdleCompaction("ada", deps(config, { cache })));

    // The pre-compaction body must not stay armed against a conversation that
    // has just been rewritten — pinging a prefix the next turn will not reuse
    // spends money warming the wrong thing. There is still a prefix worth
    // protecting, so the answer is the rebuilt one rather than standing down.
    // The disarming direction — a rebuild that produces nothing — is the same
    // `repoint`, and `deep_archive_parity.test.ts` is where it is pinned.
    expect(cache.get("ada")).toBeDefined();
    expect(cache.get("ada")).not.toEqual(stale());
    expect(armed).toEqual(["ada", "ada"]);
    expect(disarmed).toEqual([]);
  });


  test("a failed pass leaves the cached body alone", async () => {
    // Nothing was rewritten, so the armed prefix is still the right one.
    const { config } = await world();
    config.models.chat.delete("chat.fixture");
    const cache = new LastRequestCache();
    cache.set("ada", stale(), undefined);

    await runIdleCompaction("ada", deps(config, { cache }));

    expect(cache.get("ada")).toEqual(stale());
  });
});
