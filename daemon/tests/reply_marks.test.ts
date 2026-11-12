import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listMarks, mark, unmark, type MarkContext } from "../src/commands/marks.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { deleteCharacter, exportCharacter, importCharacter, type ArchiveContext } from "../src/commands/archive.ts";
import { characterActiveJsonl, MAIN_THREAD, threadDataDir } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { forkThread, recoverForks } from "../src/engine/fork.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { ensureThreads } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { generationEngine, runGeneration, type GenerationDeps } from "../src/handler/generation.ts";
import type { WireRequest } from "../src/handler/persistence.ts";
import { loadConfig } from "../src/config/loader.ts";
import { configSchema } from "../src/config/schema.ts";
import type { RegenChoice } from "../src/handler/router.ts";
import { Ledger } from "../src/ledger/store.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import type { OperationInput } from "../src/operations/types.ts";
import { readDurable, threadFile, writeDurable } from "../src/storage/files.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { outcomeOf, rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(() => {
  closeLedgers();
  restoreTestEnv();
});

const KEY_ENV = "SHORE_MARKS_FIXTURE_KEY";
const NOW = "2026-11-12T10:00:00.000Z";
const usage = { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 };
const timing = { total_ms: 10, time_to_first_token_ms: 2 };

type Round = string | { tool: string };

interface World {
  data: string;
  engine: ConversationEngine;
  sent: SidecarRequest[];
  say(text: string): Promise<void>;
  regen(choice?: RegenChoice): Promise<void>;
  marks: MarkContext;
  lastRequest(): WireRequest | undefined;
}

function reply(text: string): StreamEvent[] {
  return [
    { type: "start", model: "claude-fixture" },
    { type: "text", text },
    { type: "done", content: text, finish_reason: "end_turn", content_blocks: [{ type: "text", text }], usage, timing },
  ];
}

function toolCall(name: string): StreamEvent[] {
  return [
    { type: "start", model: "claude-fixture" },
    { type: "tool_use", id: `tool_${crypto.randomUUID()}`, name, input: {} },
    { type: "done", content: "", finish_reason: "tool_use", usage, timing },
  ];
}

async function world(rounds: Round[], options: { tools?: string[]; history?: Message[]; tags?: string[] } = {}): Promise<World> {
  const root = await mkdtemp(testTmp("shore-marks-"));
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const app = defaultAppConfig();
  app.tools.enabled_tools = options.tools ?? [];
  app.advanced.max_retries = 0;
  app.defaults.model = "fixture";
  app.defaults.display_name = "Sam";
  if (options.tags !== undefined) app.behavior.marks.tags = options.tags;
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic", sdk: "anthropic",
    modelId: "claude-fixture", apiKeyEnv: KEY_ENV, maxContextTokens: 200_000, maxOutputTokens: 4096, maxToolIterations: 4, reasoningEffort: "high",
  });
  const config: LoadedConfig = { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
  setTestEnv(KEY_ENV, "fixture-key");
  const workspace = join(dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "ada system prompt");
  await mkdir(join(dirs.data, "ada", "threads", "main"), { recursive: true });
  if (options.history !== undefined) {
    writeDurable(characterActiveJsonl(dirs.data, "ada", MAIN_THREAD), options.history.map((message) => `${JSON.stringify(message)}\n`).join(""));
  }
  const ledgerPath = join(dirs.data, "shore.db");
  Ledger.create(ledgerPath).close();
  const db = new Database(ledgerPath);
  db.query("INSERT INTO pricing_catalog_checks (url, fetched_at) VALUES ('https://openrouter.ai/api/v1/models', ?1)").run(Date.now());
  db.close();

  const sent: SidecarRequest[] = [];
  let kept: WireRequest | undefined;
  const queue = [...rounds];
  const provider: SidecarProvider = {
    async *stream(req) {
      sent.push(structuredClone(req));
      const next = queue.shift() ?? "Out of script.";
      yield* typeof next === "string" ? reply(next) : toolCall(next.tool);
    },
    generate: () => {
      throw new Error("no turn here generates");
    },
  };
  const engine = await ConversationEngine.load("ada", dirs.data, undefined);
  const generation = generationEngine(engine);
  const deps: GenerationDeps = {
    registry: {
      getOrCreate: async () => generation,
      effectiveConfig: () => config,
      listThreads: () => [{ id: "main", created_at: "2026-09-03T00:00:00.000Z", compaction: true }],
    },
    dataDir: dirs.data,
    ledgerPath,
    providers: { anthropic: provider },
    autonomy: {
      ensureState: () => false, needsActivityBackfill: () => false, backfillActivity: () => {}, onUserMessage: () => {},
      shouldCompactNow: () => false, onCompactionComplete: () => {}, onCompactionFailed: () => {},
      notifyLastRequest: (_character, request) => { kept = structuredClone(request); }, notifyAssistantMessage: () => {},
    },
    notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
    diagnostics: { key_fallbacks: { push: () => {} } },
    emitEvent: () => {},
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => ({ kind: "completed", retained: 0 }), applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
    newlyCrossedPlanLimitWarnings: async () => [],
    now: () => NOW,
    newMessageId: () => `m_${crypto.randomUUID()}`,
    monotonicMs: () => 0,
    sleep: async () => {},
  };
  const turn = async (text: string, regen: RegenChoice | undefined): Promise<void> => {
    await runGeneration(deps, {
      meta: { session: { clientId: 1, sessionId: 1, clientType: "test", clientName: "test", capabilities: ["streaming"], selectedCharacter: "ada" }, rid: null, kind: "message" } as never,
      body: { rid: null, text, stream: true, images: [], image_data: [], ...(regen === undefined ? {} : { regen }) },
      regen: regen !== undefined,
      charName: "ada",
      rid: null,
      send: async () => {},
      signal: new AbortController().signal,
    });
  };
  return {
    data: dirs.data,
    engine,
    sent,
    say: async (text) => await turn(text, undefined),
    regen: async (choice) => await turn("", choice ?? { kind: "reroll" }),
    marks: { engine, data: dirs.data, tags: app.behavior.marks.tags, now: () => NOW },
    lastRequest: () => kept,
  };
}

function wire(request: SidecarRequest | undefined): string {
  return JSON.stringify(request?.messages ?? []);
}

function notes(request: SidecarRequest | undefined): string[] {
  return (request?.messages ?? []).filter((message) => message.role === "system")
    .map((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""));
}

async function marked(at: World, args: Omit<OperationInput<"mark">, "kind"> & Partial<Pick<OperationInput<"mark">, "kind">>) {
  return await mark(at.marks, { kind: "like", ...args });
}

function attemptsOf(at: World, ref?: string) {
  return listMarks(at.marks, ref === undefined ? {} : { refs: ref }).replies[0]?.attempts ?? [];
}

function query<T>(at: World, sql: string, ...values: string[]): T[] {
  const db = new Database(join(at.data, "shore.db"), { readonly: true });
  try {
    return db.query(sql).all(...values) as T[];
  } finally {
    db.close();
  }
}

describe("regenerating", () => {
  test("a plain reroll sends exactly what the attempt it replaces was sent", async () => {
    const at = await world(["First try.", "Second try."]);
    await at.say("Tell me about the sea.");
    await at.regen();
    expect(at.sent).toHaveLength(2);
    expect(at.sent[1]?.messages).toEqual(at.sent[0]?.messages);
    expect(notes(at.sent[1])).toEqual([]);
  });

  test("a regenerate with a reason shows the earlier attempt and the reason, dislikes it with that reason, and the next message sees neither", async () => {
    const at = await world(["First try about tides.", "Second try about waves.", "You're welcome."]);
    await at.say("Tell me about the sea.");
    await at.regen({ kind: "with_reason", reason: "too formal", tags: ["too long"] });
    const [note, ...others] = notes(at.sent[1]);
    expect(others).toEqual([]);
    expect(note).toContain("> First try about tides.");
    expect(note).toContain("They didn't want the attempt they were looking at, and said why: too long; too formal");
    expect(note).toContain("Attempt 1, the one Sam was looking at:");
    expect(note).toContain("Sam disliked this attempt, because: too long; too formal");
    expect(note).not.toContain("another take");
    expect(at.sent[1]?.messages.at(-1)?.role).toBe("system");

    expect(attemptsOf(at).map((attempt) => [attempt.position, attempt.shown, attempt.asked, attempt.marks.map((m) => [m.kind, m.phrase, m.reason, m.tags])])).toEqual([
      [1, false, "first", [["dislike", null, "too formal", ["too long"]]]],
      [2, true, "with_reason", []],
    ]);

    await at.say("Thanks.");
    const next = wire(at.sent[2]);
    expect(next).toContain("Second try about waves.");
    expect(next).not.toContain("First try about tides.");
    expect(next).not.toContain("too formal");
    expect(notes(at.sent[2])).toEqual([]);
  });

  test("another take shows every earlier attempt with its marks and asks for something different, without disliking anything", async () => {
    const at = await world(["Tides rise.", "Waves crash.", "Foam drifts."]);
    await at.say("Tell me about the sea.");
    await at.regen();
    await marked(at, { position: 1, phrase: "Tides", reason: "a lovely start" });
    await at.regen({ kind: "another_take" });
    const [note] = notes(at.sent[2]);
    expect(note).toContain("They'd like another take: something different from what you wrote before");
    expect(note).toContain("Attempt 1:\n> Tides rise.\nSam liked the words \"Tides\", because: a lovely start");
    expect(note).toContain("Attempt 2, the one Sam was looking at:\n> Waves crash.");
    expect(note).not.toContain("said why");
    expect(note).toContain("Write your reply as if it were the first");
    expect(attemptsOf(at).map((attempt) => [attempt.asked, attempt.marks.map((m) => m.kind)])).toEqual([
      ["first", ["like"]], ["reroll", []], ["another_take", []],
    ]);
  });

  test("the note stays in view through the new attempt's tool calls and no further", async () => {
    const at = await world(["Plain answer.", { tool: "guide" }, "Answer after looking.", "Bye."], { tools: ["guide"] });
    await at.say("What have I been up to?");
    await at.regen({ kind: "another_take" });
    expect(at.sent).toHaveLength(3);
    for (const round of at.sent.slice(1)) expect(notes(round).join("")).toContain("> Plain answer.");
    expect(at.sent[2]?.messages.some((message) => message.content.some((block) => block.type === "tool_result"))).toBe(true);
    await at.say("Bye.");
    expect(notes(at.sent[3])).toEqual([]);
    expect(wire(at.sent[3])).not.toContain("Plain answer.");
  });

  test("a reason with a tag that isn't configured is refused before anything happens", async () => {
    const at = await world(["First try."]);
    await at.say("Hi.");
    expect(await outcomeOf(at.regen({ kind: "with_reason", tags: ["rude"] }))).toThrow("\"rude\" isn't one of your tags");
    expect(at.sent).toHaveLength(1);
    expect(attemptsOf(at)[0]?.marks).toEqual([]);
  });

  test("a reason needs a reply to be about, while another take with none is just a first attempt", async () => {
    const at = await world(["Hello there."], { history: [{ msg_id: "m_ask", role: "user", content: "Hi.", images: [], content_blocks: [{ type: "text", text: "Hi." }], timestamp: NOW }] });
    expect(await outcomeOf(at.regen({ kind: "with_reason", reason: "rude", tags: [] }))).toThrow("There's no reply here to give a reason about");
    await at.regen({ kind: "another_take" });
    expect(notes(at.sent[0])).toEqual([]);
    expect(attemptsOf(at).map((attempt) => attempt.asked)).toEqual(["first"]);
  });

  test("each attempt records how it was asked for and what it replaced, and one query joins its marks with its model, effort and login", async () => {
    const at = await world(["One.", "Two.", "Three.", "Four."]);
    await at.say("Count with me.");
    await at.regen();
    await at.regen({ kind: "another_take" });
    await at.regen({ kind: "with_reason", reason: "off by one", tags: [] });
    const attempts = attemptsOf(at);
    expect(attempts.map((attempt) => attempt.asked)).toEqual(["first", "reroll", "another_take", "with_reason"]);
    const ids = attempts.map((attempt) => String(attempt.attempt));
    const replaced = query<{ attempt: string; replaces: string | null }>(at, "SELECT attempt, replaces FROM reply_attempts ORDER BY created_at, rowid");
    expect(replaced).toEqual(ids.map((id, index) => ({ attempt: id, replaces: index === 0 ? null : ids[index - 1] ?? "missing" })));

    const rows = query<{ asked: string; kind: string | null; reason: string | null; model: string; reasoning_effort: string | null; api_key_name: string | null }>(at, `
      SELECT a.asked, m.kind, m.reason, c.model, c.reasoning_effort, c.api_key_name
        FROM reply_attempts a
        LEFT JOIN reply_marks m ON m.character = a.character AND m.thread = a.thread AND m.attempt = a.attempt
        JOIN calls c ON c.attempt = a.attempt
       WHERE a.attempt = ?1`, String(ids[2]));
    expect(rows).toEqual([{ asked: "another_take", kind: "dislike", reason: "off by one", model: "claude-fixture", reasoning_effort: "high", api_key_name: "default" }]);
    expect(query(at, "SELECT attempt FROM calls WHERE attempt IS NULL")).toEqual([]);
  });
});

describe("marking replies", () => {
  test("a mark is a like or dislike with an optional reason and tags, and can be changed and removed", async () => {
    const at = await world(["The sea is wide."]);
    await at.say("Tell me about the sea.");
    const liked = await marked(at, {});
    expect(liked).toMatchObject({ position: 1, changed: true, marks: [{ kind: "like", phrase: null, reason: null, tags: [], at: NOW }] });
    expect(await marked(at, {}), "the same mark again changes nothing").toMatchObject({ changed: false });
    const changed = await marked(at, { kind: "dislike", reason: "  too short  ", tags: ["too long", "repetitive", "too long"] });
    expect(changed.marks).toEqual([{ kind: "dislike", phrase: null, reason: "too short", tags: ["too long", "repetitive"], at: NOW }]);
    expect(await marked(at, { kind: "dislike", reason: "too short", tags: ["too long", "repetitive"] })).toMatchObject({ changed: false });
    expect((await marked(at, { kind: "dislike", reason: "", tags: ["too long", "repetitive"] })).marks[0]?.reason, "a blank reason is no reason").toBeNull();
    expect((await marked(at, { kind: "dislike", tags: ["too long"] })).marks[0]?.tags).toEqual(["too long"]);
    const removed = await unmark(at.marks, {});
    expect(removed).toMatchObject({ changed: true, marks: [] });
    expect(await outcomeOf(unmark(at.marks, {}))).toThrow("Attempt 1 has no mark on the whole reply");
  });

  test("a phrase is found in the attempt's text however it was formatted, and its mark leaves the whole reply unmarked", async () => {
    const at = await world(["The sea is **very** wide,\nand [deep](https://example.com/deep) too."]);
    await at.say("Tell me about the sea.");
    const phrase = await marked(at, { kind: "dislike", phrase: "  IS VERY   WIDE, and deep  ", reason: "purple" });
    expect(phrase.marks).toEqual([{ kind: "dislike", phrase: "is **very** wide,\nand [deep", reason: "purple", tags: [], at: NOW }]);
    expect(phrase.phrase, "the change names the words as the reply has them").toBe("is **very** wide,\nand [deep");
    expect((await marked(at, {})).phrase).toBeNull();
    await unmark(at.marks, {});
    await marked(at, { phrase: "too" });
    expect(attemptsOf(at)[0]?.marks.map((m) => [m.kind, m.phrase])).toEqual([["dislike", "is **very** wide,\nand [deep"], ["like", "too"]]);
    expect(await outcomeOf(marked(at, { phrase: "the ocean" }))).toThrow("\"the ocean\" isn't in the text of attempt 1");
    expect(await outcomeOf(marked(at, { phrase: "  " }))).toThrow("isn't in the text of attempt 1");
    expect(await outcomeOf(unmark(at.marks, { phrase: "the ocean" }))).toThrow("isn't in the text of attempt 1");
    expect(await outcomeOf(unmark(at.marks, { phrase: "wide" }))).toThrow("Attempt 1 has no mark on \"wide\"");
    const unmarked = await unmark(at.marks, { phrase: "Too" });
    expect(unmarked.phrase).toBe("too");
    expect(unmarked.marks.map((m) => m.phrase)).toEqual(["is **very** wide,\nand [deep"]);
  });

  test("words picked out of formatted text take the formatting that wraps them", async () => {
    const at = await world(["Tell me about the **wide** sea, the _cold_ one, and `ropes`."]);
    await at.say("Go on.");
    expect((await marked(at, { phrase: "wide sea" })).phrase).toBe("**wide** sea");
    expect((await marked(at, { phrase: "cold" })).phrase).toBe("_cold_");
    expect((await marked(at, { phrase: "ropes." })).phrase).toBe("`ropes`.");
    expect((await marked(at, { phrase: "tell" })).phrase).toBe("Tell");
  });

  test("phrases match through headings, quotes and list markers, but the words between still have to be spaced as written", async () => {
    const at = await world(["# Tides\n> The moon pulls.\n- high water\n1. low water"]);
    await at.say("Tides?");
    expect((await marked(at, { phrase: "tides the moon pulls. high water low" })).marks[0]?.phrase).toBe("Tides\n> The moon pulls.\n- high water\n1. low");
    expect(await outcomeOf(marked(at, { phrase: "ides the moon pulls.high" }))).toThrow("isn't in the text");
  });

  test("a mark can go on any attempt of any reply, by position, and is listed with the reply's attempts", async () => {
    const at = await world(["Old reply.", "Newer reply.", "Newest attempt."]);
    await at.say("First question.");
    await at.say("Second question.");
    await at.regen();
    const first = at.engine.messages().find((message) => message.role === "assistant")?.msg_id ?? "";
    expect((await marked(at, { ref: first })).ref).toBe(first);
    expect((await marked(at, { ref: "-1", position: 1, kind: "dislike" })).position).toBe(1);
    expect(await outcomeOf(marked(at, { position: 3 }))).toThrow("Attempt 3 is out of range; this reply has 2 attempts");
    expect(await outcomeOf(marked(at, { ref: first, position: 0 }))).toThrow("Attempt 0 is out of range; this reply has 1 attempt");
    expect(await outcomeOf(marked(at, { ref: "1" }))).toThrow("No reply 1 here; only the character's replies can be marked");
    expect(await outcomeOf(marked(at, { reason: "x".repeat(4001) }))).toThrow("A reason is at most 4000 characters");
    expect(await outcomeOf(marked(at, { tags: ["rude"] }))).toThrow("\"rude\" isn't one of your tags");
    const listing = listMarks(at.marks, { refs: [first, "last", "m_nowhere"] });
    expect(listing.tags).toEqual(["didn't look hard enough", "out of character", "too long", "repetitive"]);
    expect(listing.replies.map((entry) => entry.attempts.map((attempt) => [attempt.position, attempt.shown, attempt.marks.map((m) => m.kind)]))).toEqual([
      [[1, true, ["like"]]],
      [[1, false, ["dislike"]], [2, true, []]],
    ]);
    expect(() => listMarks(at.marks, { refs: "m_nowhere" })).toThrow("No reply m_nowhere here");
  });

  test("with no reply yet there is nothing to mark or list", async () => {
    const at = await world([]);
    expect(await outcomeOf(marked(at, {}))).toThrow("No reply here yet to mark");
    expect(() => listMarks(at.marks, {})).toThrow("No reply here yet to mark");
  });

  test("a reply from before marks existed gets its attempt the first time it is marked, once", async () => {
    const legacy: Message[] = [
      { msg_id: "m_ask", role: "user", content: "Hi.", images: [], content_blocks: [{ type: "text", text: "Hi." }], timestamp: NOW },
      {
        msg_id: "m_old", role: "assistant", content: "Hello.", images: [], content_blocks: [{ type: "text", text: "Hello." }], timestamp: NOW,
        alt_index: 1, alt_count: 2, alternatives: [
          { content: "Hey.", images: [], content_blocks: [{ type: "text", text: "Hey." }], timestamp: NOW },
          { content: "Hello.", images: [], content_blocks: [{ type: "text", text: "Hello." }], timestamp: NOW },
        ],
      },
    ];
    const at = await world([], { history: legacy });
    expect(attemptsOf(at).map((attempt) => attempt.attempt)).toEqual([null, null]);
    const shown = await marked(at, {});
    const other = await marked(at, { position: 1, kind: "dislike" });
    expect(await marked(at, { reason: "warm" })).toMatchObject({ attempt: shown.attempt });
    expect(shown.attempt).toMatch(/^at_/);
    expect(other.attempt).not.toBe(shown.attempt);
    const stored = readDurable(characterActiveJsonl(at.data, "ada", MAIN_THREAD)).trim().split("\n").map((line) => JSON.parse(line) as Message);
    expect(stored[1]?.attempt).toBe(shown.attempt);
    expect(stored[1]?.alternatives?.map((alternative) => alternative.attempt)).toEqual([other.attempt, shown.attempt]);
    expect(attemptsOf(at).map((attempt) => [attempt.attempt, attempt.asked])).toEqual([[other.attempt, null], [shown.attempt, null]]);
  });

  test("deleting a reply deletes its marks and its attempts' records, and leaves other replies' alone", async () => {
    const at = await world(["Keep me.", "Delete me.", "Delete me too."]);
    await at.say("One.");
    await at.say("Two.");
    await at.regen();
    const keep = await marked(at, { ref: "2" });
    await marked(at, { position: 1, kind: "dislike" });
    const doomed = at.engine.messages().filter((message) => message.role === "assistant").at(-1)?.msg_id ?? "";
    await at.engine.deleteMessages([doomed]);
    expect(query<{ attempt: string }>(at, "SELECT attempt FROM reply_marks")).toEqual([{ attempt: keep.attempt }]);
    expect(query<{ attempt: string }>(at, "SELECT attempt FROM reply_attempts")).toEqual([{ attempt: keep.attempt }]);
  });
});

describe("marks over a conversation's life", () => {
  test("a mark on an archived reply is still there after compaction, a fork, and an export and import", async () => {
    const at = await world(["Archived reply.", "Second attempt.", "Live reply."]);
    await ensureThreads(at.data, "ada", NOW);
    await at.say("Old question.");
    await at.regen({ kind: "with_reason", reason: "flat", tags: [] });
    const archived = at.engine.messages().findLast((message) => message.role === "assistant")?.msg_id ?? "";
    await marked(at, { phrase: "Second", reason: "good word" });
    await at.say("New question.");
    const live = await marked(at, { kind: "dislike" });

    const raw = readDurable(threadFile(at.data, "ada", MAIN_THREAD, "active.jsonl"));
    await archiveAndRetain(threadDataDir(at.data, "ada", MAIN_THREAD), { dbPath: join(at.data, "shore.db"), archiveKey: "ada" }, 2, raw, () => NOW, () => crypto.randomUUID(), "marks-compaction");
    await at.engine.reload();
    expect(at.engine.messages().map((message) => message.msg_id)).not.toContain(archived);
    const before = attemptsOf(at, archived).map((attempt) => [attempt.position, attempt.asked, attempt.marks.map((m) => [m.kind, m.phrase, m.reason])]);
    expect(before).toEqual([
      [1, "first", [["dislike", null, "flat"]]],
      [2, "with_reason", [["like", "Second", "good word"]]],
    ]);
    await marked(at, { ref: archived, position: 1, phrase: "Archived" });
    const kept = attemptsOf(at, archived);

    await forkThread(at.data, "ada", MAIN_THREAD, "side", { now: () => NOW });
    expect(attemptsOf(at, archived)).toEqual(kept);
    const side = await ConversationEngine.load("ada", at.data, undefined, "side");
    const sideMarks = { ...at.marks, engine: side };
    expect(listMarks(sideMarks, {}).replies[0]?.attempts[0]?.marks.map((m) => m.kind), "the live reply's mark went with it").toEqual(["dislike"]);
    await unmark(sideMarks, {});
    expect(attemptsOf(at)[0]?.marks.map((m) => m.kind), "the fork's marks are its own").toEqual(["dislike"]);
    expect(live.attempt).toBe(String(attemptsOf(at)[0]?.attempt));

    const target = await mkdtemp(testTmp("shore-marks-import-"));
    const dirs = { config: join(target, "config"), data: join(target, "data"), cache: join(target, "cache"), runtime: join(target, "run") };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    const sourceDirs = { config: join(at.data, "..", "config"), data: at.data, cache: join(at.data, "..", "cache"), runtime: join(at.data, "..", "run") };
    const output = join(sourceDirs.runtime, "ada.tar");
    const archives = (shore: typeof dirs, names: Set<string>): ArchiveContext => ({
      dirs: shore, characters: () => [...names], hasCharacter: (name) => names.has(name),
      withSnapshot: async (run) => await run(), refreshDiscovery: async () => {}, releaseCharacter: async () => undefined,
    });
    await exportCharacter(archives(sourceDirs, new Set(["ada"])), { character: "ada", output });
    await importCharacter(archives(dirs, new Set()), { archive: output });
    const imported = await ConversationEngine.load("ada", dirs.data, undefined);
    expect(listMarks({ ...at.marks, engine: imported, data: dirs.data }, { refs: archived }).replies[0]?.attempts).toEqual(kept);
    const importedSide = await ConversationEngine.load("ada", dirs.data, undefined, "side");
    expect(listMarks({ ...at.marks, engine: importedSide, data: dirs.data }, {}).replies[0]?.attempts[0]?.marks).toEqual([]);

    await deleteCharacter(archives(dirs, new Set(["ada"])), { character: "ada", confirm: "ada" });
    const db = new Database(join(dirs.data, "shore.db"), { readonly: true });
    try {
      expect(db.query("SELECT count(*) AS n FROM reply_marks").get()).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM reply_attempts").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("an archived reply from before marks existed gets its attempt when first marked", async () => {
    const at = await world([], { history: [
      { msg_id: "m_ask", role: "user", content: "Hi.", images: [], content_blocks: [{ type: "text", text: "Hi." }], timestamp: NOW },
      { msg_id: "m_tool", role: "assistant", content: "", images: [], content_blocks: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "guide", input: {} }], timestamp: NOW },
      { msg_id: "m_result", role: "user", content: "", images: [], content_blocks: [{ type: "tool_result", tool_use_id: "t1", content: "a guide" }], timestamp: NOW },
      {
        msg_id: "m_old", role: "assistant", content: "Hello.", images: [], content_blocks: [{ type: "text", text: "Hello." }], timestamp: NOW,
        alt_index: 0, alt_count: 2, alternatives: [
          { content: "Let me look.\nHello.", images: [], content_blocks: [{ type: "text", text: "Let me look." }, { type: "text", text: "Hello." }], timestamp: NOW },
          { content: "Hey.", images: [], content_blocks: [{ type: "text", text: "Hey." }], timestamp: NOW },
        ],
      },
      { msg_id: "m_next", role: "user", content: "Bye.", images: [], content_blocks: [{ type: "text", text: "Bye." }], timestamp: NOW },
      { msg_id: "m_plain", role: "assistant", content: "See you.", images: [], content_blocks: [{ type: "text", text: "See you." }], timestamp: NOW },
    ] });
    const raw = readDurable(threadFile(at.data, "ada", MAIN_THREAD, "active.jsonl"));
    await archiveAndRetain(threadDataDir(at.data, "ada", MAIN_THREAD), { dbPath: join(at.data, "shore.db"), archiveKey: "ada" }, 0, raw, () => NOW, () => crypto.randomUUID(), "legacy-compaction");
    await at.engine.reload();
    expect(at.engine.messages()).toEqual([]);

    expect((await marked(at, { ref: "m_tool", phrase: "look. hello" })).ref, "any message of a reply finds the reply").toBe("m_old");
    const other = await marked(at, { ref: "m_old", position: 2, kind: "dislike" });
    const shown = await marked(at, { ref: "m_old", reason: "kind" });
    expect(new Set([shown.attempt, other.attempt]).size).toBe(2);
    const plain = await marked(at, { ref: "m_plain" });
    expect(await marked(at, { ref: "m_plain", kind: "dislike" })).toMatchObject({ attempt: plain.attempt });
    const store = HistoryStore.open(join(at.data, "shore.db"));
    try {
      const [, , , old, , last] = store.readSegment("ada", 0);
      expect(old?.attempt).toBe(shown.attempt);
      expect(old?.alternatives?.map((alternative) => alternative.attempt)).toEqual([shown.attempt, other.attempt]);
      expect(last?.attempt).toBe(plain.attempt);
    } finally {
      store.close();
    }
    expect(attemptsOf(at, "m_old").map((attempt) => [attempt.shown, attempt.marks.map((m) => [m.kind, m.phrase])])).toEqual([
      [true, [["like", null], ["like", "look.\nHello"]]],
      [false, [["dislike", null]]],
    ]);
  });

  test("a fork that never finished takes the marks it copied with it", async () => {
    const at = await world(["Reply."]);
    await ensureThreads(at.data, "ada", NOW);
    await at.say("Hi.");
    await marked(at, {});
    expect(await outcomeOf(forkThread(at.data, "ada", MAIN_THREAD, "cut", { now: () => NOW, failAfter: "provenance" }))).toThrow(/injected/);
    expect(query<{ thread: string }>(at, "SELECT DISTINCT thread FROM reply_marks ORDER BY thread")).toEqual([{ thread: "cut" }, { thread: "main" }]);
    await recoverForks(at.data, "ada");
    expect(query<{ thread: string }>(at, "SELECT DISTINCT thread FROM reply_marks")).toEqual([{ thread: "main" }]);
    expect(query<{ thread: string }>(at, "SELECT DISTINCT thread FROM reply_attempts")).toEqual([{ thread: "main" }]);
  });
});

describe("the tags a reason can carry", () => {
  test("are a list in the config, each 1 to 80 characters, with no repeats", async () => {
    const root = await mkdtemp(testTmp("shore-marks-config-"));
    const read = async (toml: string): Promise<string[]> => {
      await Bun.write(join(root, "config.toml"), toml);
      return loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} }).app.behavior.marks.tags;
    };
    expect(await read('[chat]\ndisplay_name = "eve"\n')).toEqual(["didn't look hard enough", "out of character", "too long", "repetitive"]);
    expect(await read(`[marks]\ntags = ["cold", "${"🕯".repeat(80)}"]\n`)).toEqual(["cold", "🕯".repeat(80)]);
    expect(await read("[marks]\ntags = []\n")).toEqual([]);
    const refused = async (toml: string): Promise<string> => String(await rejectionOf(read(toml)));
    const shape = "a tag is 1 to 80 characters with no space at either end";
    expect(await refused('[marks]\ntags = ["cold", ""]\n')).toContain(`marks.tags has ""; ${shape}`);
    expect(await refused('[marks]\ntags = ["cold "]\n')).toContain(`marks.tags has "cold "; ${shape}`);
    expect(await refused(`[marks]\ntags = ["${"z".repeat(81)}"]\n`)).toContain(`marks.tags has "${"z".repeat(81)}"; ${shape}`);
    expect(await refused('[marks]\ntags = ["cold", "dull", "cold"]\n')).toContain('marks.tags lists "cold" twice');
    expect(configSchema({ instancesAt: () => [] }).find((entry) => entry.key === "marks.tags")?.description ?? "").toStartWith("Reasons you can give in one click");
  });

  test("an empty list leaves only written reasons", async () => {
    const at = await world(["Reply."], { tags: [] });
    await at.say("Hi.");
    expect(await outcomeOf(marked(at, { tags: ["too long"] }))).toThrow("\"too long\" isn't one of your tags: marks.tags in your config is empty. Add it to marks.tags to use it.");
    expect(listMarks(at.marks, {}).tags).toEqual([]);
  });
});

describe("what a keepalive keeps warm", () => {
  test("is the conversation the next message will send, without the note a regenerate was shown", async () => {
    const at = await world(["First.", "Second."]);
    await at.say("Hi.");
    expect(at.lastRequest()?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    await at.regen({ kind: "another_take" });
    expect(notes(at.sent[1])).toHaveLength(1);
    expect(at.lastRequest()?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(at.lastRequest()?.messages)).toContain("Second.");
  });
});
