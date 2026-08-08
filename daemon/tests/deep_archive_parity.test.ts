/**
 * Replay of the deep-idle archive against the frozen Rust fixture.
 *
 * `tests/autonomy_fixtures/deep_archive_parity.json` was generated in a worktree
 * at `9023b46d` by driving the real `deep_archive_plan`,
 * `RealConversationManager::archive_and_retain` and the notification the pure
 * arm sends. Nothing regenerates it; a diff here is a defect in
 * `src/autonomy/deep_archive.ts`, not a fixture to refresh.
 *
 * What the three sections are actually protecting:
 *
 * - **`plan`** is the choice between spending nothing and spending a model call
 *   over a whole conversation. The comparison is strict equality against the
 *   covered count, and one recorded case has the covered count *above* the
 *   on-disk one — an `>=` would take the cheap arm on a conversation whose
 *   coverage is unknown, which loses uncovered turns permanently.
 * - **`pure_archive`** is the split. `tail` becomes `keepLastN`, so an
 *   off-by-one either archives an unanswered heartbeat message the user has not
 *   read, or leaves an already-covered exchange sitting in `active.jsonl`
 *   forever.
 * - **`notification`** is how a user tells the two arms apart from outside.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import fixture from "./autonomy_fixtures/deep_archive_parity.json" with { type: "json" };
import { MessageStore } from "../src/engine/message_store.ts";
import type { Message } from "../src/engine/types.ts";
import { conversationManager } from "../src/memory/compaction/archive.ts";
import { tryBeginCompaction } from "../src/memory/compaction/manager.ts";
import {
  deepArchiveNotification,
  deepArchivePlan,
  runDeepIdleArchive,
  type DeepArchiveDeps,
} from "../src/autonomy/deep_archive.ts";
import { LastRequestCache } from "../src/autonomy/last_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";

// ── harness ─────────────────────────────────────────────────────────────

interface Shape {
  role: string;
  msg_id: string;
  content: string;
  autonomous: boolean;
  tool_result_only: boolean;
}

/** A message as the generator's `shape` recorded it, rebuilt into a real one. */
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

/**
 * A character directory with a conversation on disk.
 *
 * `content` is either the fixture's recorded bytes or messages this side
 * serialized. The archive sections must use the recorded bytes: the split is by
 * *line* over them, and `serde` omits an empty `alternatives` where
 * `JSON.stringify` writes it — so a replay that re-encoded the messages would be
 * comparing its own encoder against the Rust's rather than the archive against
 * the archive.
 */
async function world(
  content: Message[] | string,
  priorSegment = false,
  opts: { backgroundModel?: boolean } = {},
): Promise<{ config: LoadedConfig; dataDir: string; characterDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "shore-deeparch-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const characterDir = join(dirs.data, "ada");
  await mkdir(characterDir, { recursive: true });
  await writeFile(
    join(characterDir, "active.jsonl"),
    typeof content === "string"
      ? content
      : content.map((m) => JSON.stringify(m)).join("\n") + (content.length === 0 ? "" : "\n"),
  );

  if (priorSegment) {
    await mkdir(join(characterDir, "segments"), { recursive: true });
    await writeFile(join(characterDir, "segments", "0001.jsonl"), "{}\n");
    await writeFile(
      join(characterDir, "compaction.json"),
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
    // `resolveBackgroundModel` falls back to the chat model when no
    // `[defaults.background]` is set, so one entry gives the LLM arm a model.
    app.defaults.model = "fixture";
    models.chat.set("chat.fixture", FIXTURE_MODEL);
  }

  return {
    dataDir: dirs.data,
    characterDir,
    config: { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

/** The generator's model, as the TypeScript catalog spells it. */
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

/** The messages as the store hands them back, which is what the plan reads. */
async function loadThroughStore(shapes: Shape[]): Promise<Message[]> {
  const { characterDir } = await world(shapes.map(fromShape));
  const store = await MessageStore.load(join(characterDir, "active.jsonl"));
  return [...store.messages()];
}

/** The segment files, by name, as the generator recorded them. */
async function segmentsAfter(characterDir: string): Promise<Record<string, string>> {
  let names: string[];
  try {
    names = (await readdir(join(characterDir, "segments"))).sort();
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = await readFile(join(characterDir, "segments", name), "utf8");
  }
  return out;
}

/** The manifest with its generated stamps replaced, as the generator did. */
async function manifestAfter(characterDir: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(characterDir, "compaction.json"), "utf8");
  } catch {
    return null;
  }
  const v = JSON.parse(raw) as { segments?: { compacted_at?: string }[] };
  for (const seg of v.segments ?? []) seg.compacted_at = "<stamp>";
  return v;
}

// ── 1. which arm ────────────────────────────────────────────────────────

describe("deepArchivePlan", () => {
  for (const [i, kase] of fixture.plan.entries()) {
    test(`case ${i}: ${kase.note}`, async () => {
      const messages = await loadThroughStore(kase.input as Shape[]);
      expect(deepArchivePlan(messages, kase.covered_turn_count)).toEqual(kase.plan as never);
    });
  }

  test("the covered comparison is equality, not a floor", () => {
    // The fixture's "covered count above the on-disk count" case is what pins
    // this, and it is worth stating separately: a `>=` reads an *over*-count as
    // full coverage and archives uncovered turns without ever showing them to
    // the model.
    const above = fixture.plan.find((c) => c.note.startsWith("covered count above"));
    expect(above?.plan.arm).toBe("compaction");
  });
});

// ── 2. what the pure arm leaves on disk ─────────────────────────────────

describe("the pure archive", () => {
  for (const [i, kase] of fixture.pure_archive.entries()) {
    test(`case ${i}: ${kase.note}`, async () => {
      const { characterDir } = await world(kase.active_before, kase.prior_segment);
      const { store, raw } = await MessageStore.loadWithRaw(join(characterDir, "active.jsonl"));

      const plan = deepArchivePlan(store.messages(), kase.covered_turn_count);
      expect(plan).toEqual(kase.plan as never);
      if (plan.arm !== "pure") throw new Error("the fixture case must take the pure arm");

      const newId = await conversationManager(
        characterDir,
        () => "2026-01-01T10:00:00-05:00",
        () => "conv-fixture",
      ).archiveAndRetain("deep-idle", { keepLastN: plan.tail, activeContent: raw });

      expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(kase.active_after);
      expect(await segmentsAfter(characterDir)).toEqual(kase.segments_after as never);
      expect(await manifestAfter(characterDir)).toEqual(kase.manifest_after as never);
      expect(newId.length > 0).toBe(kase.new_conversation_id_is_fresh);
      expect(deepArchiveNotification("ada", plan.archivable)).toEqual(
        kase.notification as never,
      );
    });
  }
});

// ── 3. the notification ─────────────────────────────────────────────────

describe("deepArchiveNotification", () => {
  for (const kase of fixture.notification) {
    test(`${kase.archivable} archivable`, () => {
      expect(deepArchiveNotification("ada", kase.archivable)).toEqual(kase.notification as never);
    });
  }
});

// ── 4. the action end to end ────────────────────────────────────────────

/**
 * The action's own reporting, which the fixture cannot hold.
 *
 * The Rust set state directly under a mutex; here it comes back as an
 * {@link AutonomyActionResult} for the runner to fold in, so what each arm
 * *reports* is behaviour this side invented and has to pin for itself. The
 * mapping to the Rust is one-to-one and is written out in the assertions.
 */
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
  test("nothing to archive quiesces, and says the idle period is finished", async () => {
    const { config, characterDir } = await world([
      fromShape(fixture.plan[1]!.input[0] as Shape),
    ]);
    const before = await readFile(join(characterDir, "active.jsonl"), "utf8");

    const notes: [string, string][] = [];
    const result = await runDeepIdleArchive(
      "ada",
      deps(config, { notify: (t, b) => notes.push([t, b]) }),
      0,
    );

    expect(result).toEqual({ events: [], deepArchiveDone: true });
    // Not routed through the archive: no turn count, no notification, and the
    // conversation byte-identical. An archive whose `keepLastN` happens to
    // retain everything looks the same on disk and different in all three.
    expect(result.turnCount).toBeUndefined();
    expect(notes).toEqual([]);
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(before);
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
    // The same bytes the fixture recorded, reached through the action rather
    // than through `archiveAndRetain` directly.
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(kase.active_after);
    expect(await segmentsAfter(characterDir)).toEqual(kase.segments_after as never);
   });
  }

  test("the pure arm invalidates the cached body and re-points the keepalive", async () => {
    const kase = fixture.pure_archive[0]!;
    const { config } = await world(kase.active_before);

    const disarmed: string[] = [];
    const armed: string[] = [];
    const cache = new LastRequestCache({
      arm: (p: { context?: { character: string } }) => armed.push(p.context?.character ?? "?"),
      disarm: (c: string) => disarmed.push(c),
    } as never);
    cache.set("ada", { model: "stale" } as never, undefined);

    await runDeepIdleArchive("ada", deps(config, { cache }), kase.covered_turn_count);

    // The rebuild finds no chat model, so the decision is `disarm` — which is
    // the point: the pre-archive body must not stay armed against a
    // conversation that no longer exists.
    expect(cache.get("ada")).toBeUndefined();
    expect(disarmed).toEqual(["ada"]);
    // Armed once, by the `set` that seeded the stale body — and not again.
    expect(armed).toEqual(["ada"]);
  });

  test("an engine reload that throws is a warning, not a failed archive", async () => {
    const kase = fixture.pure_archive[0]!;
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
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(kase.active_after);
  });

  test("the LLM arm runs a keep-0 pass and does not finish the idle period", async () => {
    // The case the Rust's comment is about, and the reason `deepArchiveDone`
    // had to become a field: a pass that wrote no memory returns the same zero
    // a successful one does, so declaring the period finished here would stop
    // the next window retrying a conversation that is still fully intact.
    const kase = fixture.plan.find((c) => c.plan.arm === "compaction")!;
    const { config, characterDir } = await world((kase.input as Shape[]).map(fromShape), false, {
      backgroundModel: true,
    });
    const before = await readFile(join(characterDir, "active.jsonl"), "utf8");
    process.env["SHORE_FIXTURE_API_KEY"] = "sk-fixture";

    const seen: { keepTurns: unknown }[] = [];
    const result = await runDeepIdleArchive(
      "ada",
      deps(config, {
        run: {
          // A model that says nothing calls no memory tool, which is the
          // `no_memory_writes` outcome: zero retained, conversation untouched.
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
    // Untouched, which is what makes the retry worth allowing.
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(before);
  });

  test("the keep-0 pass retains the unanswered autonomous run", async () => {
    // `retainTrailingAutonomous` is what stops the LLM arm archiving a
    // heartbeat message the user has not read — the same loss the pure arm's
    // `tail` prevents, on the other side of the coverage split. Reaching it
    // needs a pass that actually writes memory, so the model here calls `edit`.
    const kase = fixture.plan.find(
      (c) => c.plan.arm === "compaction" && c.note.startsWith("uncovered"),
    )!;
    const messages = (kase.input as Shape[]).map(fromShape);
    // An unanswered heartbeat run on the end, which the pass must leave alone.
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
    // Keep-0 empties the conversation *except* the trailing autonomous run.
    const after = await readFile(join(characterDir, "active.jsonl"), "utf8");
    const ids = after
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (JSON.parse(l) as { msg_id: string }).msg_id);
    expect(ids).toEqual(["m_9"]);
  });

  test("a keep-0 pass that cannot run reports failure and finishes nothing", async () => {
    const kase = fixture.plan.find((c) => c.plan.arm === "compaction")!;
    const { config } = await world((kase.input as Shape[]).map(fromShape));

    const result = await runDeepIdleArchive(
      "ada",
      deps(config, {
        run: {
          generate: (() => {
            throw new Error("unused");
          }) as never,
        },
      }),
      kase.covered_turn_count,
    );

    // No model resolves in this world, so the pass throws before it reaches one.
    expect(result.deepArchiveDone).toBe(false);
    expect(result.failed).toBeDefined();
  });

  test("no compaction dependencies is a failure, not a silent archive", async () => {
    const kase = fixture.plan.find((c) => c.plan.arm === "compaction")!;
    const { config, characterDir } = await world((kase.input as Shape[]).map(fromShape));
    const before = await readFile(join(characterDir, "active.jsonl"), "utf8");

    const result = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);

    expect(result.deepArchiveDone).toBe(false);
    expect(result.failed).toBeDefined();
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(before);
  });

  test("a compaction already in flight refuses rather than archiving underneath it", async () => {
    const kase = fixture.pure_archive[0]!;
    const { config, dataDir, characterDir } = await world(kase.active_before);
    const before = await readFile(join(characterDir, "active.jsonl"), "utf8");

    // The same single-flight slot every other compaction entry point takes.
    const held = tryBeginCompaction(dataDir, "ada")!;
    const refused = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);

    expect(refused.failed).toBeDefined();
    expect(refused.deepArchiveDone).toBe(false);
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(before);

    // Released, so the next window actually gets its turn — a guard that is
    // taken and never given back wedges every later pass for the process's life.
    held.release();
    const second = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);
    expect(second.failed).toBeUndefined();
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(kase.active_after);

    // And this one released its own: a third attempt is refused only by having
    // nothing left to archive, not by a slot nobody handed back.
    const third = tryBeginCompaction(dataDir, "ada");
    expect(third).toBeDefined();
    third?.release();
  });

  test("an archive that cannot write fails and leaves the period open", async () => {
    const kase = fixture.pure_archive[0]!;
    const { config, characterDir } = await world(kase.active_before);
    // `segments` as a *file*: the segment write cannot create its directory, so
    // `archiveAndRetain` throws after the guard is taken.
    await writeFile(join(characterDir, "segments"), "not a directory");

    const result = await runDeepIdleArchive("ada", deps(config), kase.covered_turn_count);

    expect(result.failed).toBeDefined();
    expect(result.deepArchiveDone).toBe(false);
    expect(await readFile(join(characterDir, "active.jsonl"), "utf8")).toBe(kase.active_before);
  });

  test("a conversation that will not load fails rather than archiving nothing", async () => {
    const { config, characterDir } = await world([]);
    await writeFile(join(characterDir, "active.jsonl"), "{not json\n");

    const result = await runDeepIdleArchive("ada", deps(config), 0);
    expect(result.deepArchiveDone).toBe(false);
    expect(result.failed).toBeDefined();
  });
});
