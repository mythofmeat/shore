import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { lastWroteNote } from "../src/autonomy/wake.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { chatLogMessageId } from "../src/browser/chat/transcript.ts";
import { CharacterRegistry } from "../src/characters.ts";
import { segments } from "../src/commands/segments.ts";
import { archiveKey, characterDataDir, threadDataDir } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HISTORY_DB_FILE } from "../src/engine/history_store.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { assemblePrompt } from "../src/engine/prompt.ts";
import { NO_PRIOR_CONTEXT } from "../src/engine/segments.ts";
import { createThread, readThreadsIndex, writeThreadsIndex, type ThreadsIndex } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { generationEngine } from "../src/handler/generation.ts";
import { buildGenerationRequest } from "../src/handler/setup.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { applyDeferredEdits } from "../src/memory/deferred_edits.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { readDurable, threadFile, writeDurable } from "../src/storage/files.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import { handleReadChatLogs, handleSearchChatLogs } from "../src/tools/history.ts";
import { handleListThreads } from "../src/tools/list_threads.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { outcomeOf } from "./support/outcome.ts";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-11-01T10:00:00Z";

function message(id: string, text: string, timestamp: string, extra: Partial<Message> = {}): Message {
  return {
    msg_id: id,
    role: id.startsWith("u") ? "user" : "assistant",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp,
    ...extra,
  };
}

async function archive(data: string, thread: string, messages: Message[], keep = 0): Promise<void> {
  const history = { dbPath: join(data, HISTORY_DB_FILE), archiveKey: archiveKey("frank", thread) };
  await archiveAndRetain(threadDataDir(data, "frank", thread), history, keep, serializeMessages(messages));
}

async function setup(): Promise<LoadedConfig> {
  const root = testTmp(`side-threads-${crypto.randomUUID()}`);
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await mkdir(join(dirs.data, "frank"), { recursive: true });
  initializeDatabase(dirs.data);
  return { app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
}

const resolved = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_SIDE_THREAD_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
} as unknown as ResolvedModel;

async function registryWith(config: LoadedConfig, files: Record<string, string>): Promise<CharacterRegistry> {
  const workspace = characterWorkspace(config, "frank").dir;
  for (const [path, content] of Object.entries({ "SOUL.md": "Frank", ...files })) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  return await CharacterRegistry.create(config.dirs.config, config.dirs.data, config);
}

async function systemText(config: LoadedConfig, thread: string, messages: Message[]): Promise<string> {
  const built = await buildGenerationRequest({
    engine: { thread, messages: () => messages, messagesThroughLastUserTurn: () => messages, priorContext: () => NO_PRIOR_CONTEXT },
    dataDir: config.dirs.data,
    charName: "frank",
    config,
    resolved,
    regen: false,
    mcpRegistry: { toolDefsFiltered: () => [] },
  });
  return JSON.stringify(built.request.system);
}

describe("a thread's files", () => {
  test("a path that leaves the workspace is refused before the thread exists", async () => {
    const config = await setup();
    for (const files of [["../secrets.md"], ["notes/../../secrets.md"]]) {
      expect(await outcomeOf(createThread(config.dirs.data, "frank", "story", NOW, { files }))).toThrow("leaves the workspace");
    }
    expect(await outcomeOf(createThread(config.dirs.data, "frank", "story", NOW, { files: ["SOUL.md"] }))).toThrow("already in every thread's prompt");
  });

  test("stay as they were when the thread started until a refresh, so the cached prompt doesn't change mid-conversation", async () => {
    const config = await setup();
    const workspace = characterWorkspace(config, "frank").dir;
    await mkdir(join(workspace, "stories"), { recursive: true });
    await writeFile(join(workspace, "stories", "lighthouse.md"), "Mara keeps the light.");
    await createThread(config.dirs.data, "frank", "story", NOW, {
      label: "The lighthouse",
      purpose: "A story we write a chapter at a time.",
      files: ["stories/lighthouse.md"],
    });
    const messages = [message("u1", "chapter two?", NOW)];

    const first = await systemText(config, "story", messages);
    expect(first).toContain("A story we write a chapter at a time.");
    expect(first).toContain("Mara keeps the light.");
    expect(await systemText(config, "main", messages)).not.toContain("side thread");

    await writeFile(join(workspace, "stories", "lighthouse.md"), "Mara left the light.");
    expect(await systemText(config, "story", messages)).toBe(first);

    writeDurable(threadFile(config.dirs.data, "frank", "story", "active.jsonl"), serializeMessages(messages));
    await applyDeferredEdits(characterDataDir(config.dirs.data, "frank"), characterWorkspace(config, "frank"), "story");
    expect(await systemText(config, "story", messages)).toContain("Mara left the light.");
  });
});

describe("setting a thread's files", () => {
  test("a file that can't be found refuses the whole change and names each one, with the names read would suggest", async () => {
    const config = await setup();
    const registry = await registryWith(config, { "stories/lighthouse.md": "Mara keeps the light.", "city/market.md": "Stalls." });
    const refused = await outcomeOf(registry.createThread("frank", "story", { files: ["stories/lighthose.md", "[[city/]]", "stories/lighthouse.md"] }));
    expect(refused).toThrow("stories/lighthose.md does not exist; tried as [[stories/lighthose.md]]: no file matches; did you mean [[lighthouse]]?");
    expect(refused).toThrow("[[city/]]: city/ has no INDEX.md");
    expect(registry.listThreads("frank").map((thread) => thread.id)).toEqual(["main"]);

    await registry.createThread("frank", "story", { files: ["stories/lighthouse.md"] });
    expect(await outcomeOf(registry.setThreadFiles("frank", "story", ["city"]))).toThrow("city is a folder");
    expect((await readThreadsIndex(config.dirs.data, "frank"))?.threads.find((thread) => thread.id === "story")?.files).toEqual(["stories/lighthouse.md"]);
  });

  test("links resolve the way read resolves them and are stored as plain paths", async () => {
    const config = await setup();
    const registry = await registryWith(config, {
      "stories/lighthouse.md": "Mara keeps the light.",
      "world/INDEX.md": "The coast.",
      "city/market.md": "Stalls.",
      "harbor/market.md": "Fish.",
    });
    expect(await outcomeOf(registry.createThread("frank", "story", { files: ["[[market]]"] }))).toThrow("[[market]]: 2 files match: [[city/market]], [[harbor/market]]");
    await registry.createThread("frank", "story", { files: ["[[lighthouse]]", "[[world/]]", "[[city/market]]"] });
    expect(registry.listThreads("frank").find((thread) => thread.id === "story")?.files).toEqual(["stories/lighthouse.md", "world/INDEX.md", "city/market.md"]);
  });
});

describe("what a thread file can be", () => {
  test("a picture, a file that isn't UTF-8 text, or one too big is refused, and the error says why", async () => {
    const config = await setup();
    const registry = await registryWith(config, { "stories/lighthouse.md": "Mara keeps the light." });
    const workspace = characterWorkspace(config, "frank").dir;
    await mkdir(join(workspace, "art"), { recursive: true });
    await writeFile(join(workspace, "art", "map.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]));
    await writeFile(join(workspace, "save.dat"), Buffer.from([0xc3, 0x28, 0xff, 0xfe]));
    await writeFile(join(workspace, "run.log"), "x".repeat(40 * 1024));
    for (const name of ["a", "b", "c", "d", "e"]) await writeFile(join(workspace, `${name}.md`), "y".repeat(30 * 1024));

    const refused = await outcomeOf(registry.createThread("frank", "story", { files: ["[[map]]", "save.dat", "run.log", "stories/lighthouse.md"] }));
    expect(refused).toThrow("[[map]] (art/map.png) is a picture; a thread file must be text");
    expect(refused).toThrow("save.dat isn't UTF-8 text; a thread file must be text");
    expect(refused).toThrow("run.log is 40 KB; a thread file can be at most 32 KB");
    expect(await outcomeOf(registry.createThread("frank", "story", { files: ["a.md", "b.md", "c.md", "d.md", "e.md"] })))
      .toThrow("together these files are 150 KB; a thread's files can be at most 128 KB together");
    expect(registry.listThreads("frank").map((thread) => thread.id)).toEqual(["main"]);

    await registry.createThread("frank", "story", { files: ["stories/lighthouse.md"] });
    expect(await outcomeOf(registry.setThreadFiles("frank", "story", ["art/map.png"]))).toThrow("art/map.png is a picture");
    expect(registry.listThreads("frank").find((thread) => thread.id === "story")?.files).toEqual(["stories/lighthouse.md"]);
  });

  test("a file that grows too big or stops being text after it's set is cut or left out of the prompt, not sent whole", async () => {
    const config = await setup();
    const workspace = characterWorkspace(config, "frank").dir;
    await mkdir(join(workspace, "notes"), { recursive: true });
    await writeFile(join(workspace, "notes", "log.md"), "short");
    await writeFile(join(workspace, "notes", "map.md"), "a map");
    await createThread(config.dirs.data, "frank", "story", NOW, { files: ["notes/log.md", "notes/map.md"] });
    const messages = [message("u1", "go on", NOW)];
    writeDurable(threadFile(config.dirs.data, "frank", "story", "active.jsonl"), serializeMessages(messages));

    await writeFile(join(workspace, "notes", "log.md"), "line of the log\n".repeat(64 * 1024));
    await writeFile(join(workspace, "notes", "map.md"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]));
    await applyDeferredEdits(characterDataDir(config.dirs.data, "frank"), characterWorkspace(config, "frank"), "story");
    const system = await systemText(config, "story", messages);
    expect(system).toContain("[Cut at 32 KB of 1.0 MB; `read` notes/log.md for the rest.]");
    expect(system).toContain("(notes/map.md is a picture, so it isn't shown. A thread file must be text.)");
    expect(system.length).toBeLessThan(40 * 1024);
  });
});

describe("who started a thread", () => {
  test("a thread the character started tells her she started it", async () => {
    const config = await setup();
    await createThread(config.dirs.data, "frank", "lighthouse", NOW, { created_by: "character" });
    await createThread(config.dirs.data, "frank", "harbor", NOW);
    const messages = [message("u1", "hi", NOW)];
    expect(await systemText(config, "lighthouse", messages)).toContain("which you started on Sunday 2026-11-01");
    expect(await systemText(config, "harbor", messages)).not.toContain("which you started");
  });
});

describe("listing threads", () => {
  test("shows every thread, which is home and which one she's calling from, without touching the prompt", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "lighthouse", NOW, {
      label: "The lighthouse",
      purpose: "A story we write a chapter at a time.",
      files: ["stories/lighthouse.md"],
      compaction: true,
      created_by: "character",
    });
    writeDurable(threadFile(data, "frank", "lighthouse", "active.jsonl"), serializeMessages([message("u1", "chapter two?", "2026-11-01T09:57:00Z")]));
    const listed = await handleListThreads({
      dataDir: data,
      character: "frank",
      thread: "lighthouse",
      userName: "sam",
      timeZone: "UTC",
      now: () => Date.parse(NOW),
    });
    expect(listed).toStartWith('Your home thread is "main". You\'re in "lighthouse".\n\n');
    expect(listed).toContain("main (home) · compaction on");
    expect(listed).toContain([
      'lighthouse "The lighthouse" (you\'re here) · compaction on',
      "  purpose: A story we write a chapter at a time.",
      "  files: stories/lighthouse.md",
      "  started by you on Sunday 2026-11-01 · 10:00 AM",
      "  sam last wrote here Sunday 2026-11-01 · 9:57 AM, 3 minutes ago",
    ].join("\n"));
  });
});

describe("an own-time thread kept from an older Shore, in the character's list of threads", () => {
  test("is listed as a thread like any other", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await writeThreadsIndex(data, "frank", {
      version: 1 as const, home: "main", heartbeat: "own-time",
      threads: [{ id: "main", created_at: NOW, compaction: true }, { id: "own-time", label: "Own time", created_at: NOW, compaction: false }],
    } as ThreadsIndex);
    const listed = (await handleListThreads({ dataDir: data, character: "frank", userName: "sam", timeZone: "UTC", now: () => Date.parse(NOW) })).split("\n\n");
    expect(listed[0]).toBe('Your home thread is "main". You\'re in it.');
    expect(listed[1]).toStartWith("main (home, you're here) · compaction on\n  started by sam on ");
    expect(listed[2]).toBe([
      'own-time "Own time" · compaction off',
      "  started by sam on Sunday 2026-11-01 · 10:00 AM",
      "  sam hasn't written here yet",
    ].join("\n"));
    expect(listed).toHaveLength(3);
  });

  test("says how long ago the user last wrote in each thread, counted to the second and never as less than a minute", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "harbor", NOW);
    await createThread(data, "frank", "pier", NOW);
    const nowMs = Date.parse("2026-11-02T06:50:00Z");
    writeDurable(threadFile(data, "frank", "harbor", "active.jsonl"), serializeMessages([message("u1", "fish market tomorrow", "2026-11-02T05:20:00Z")]));
    writeDurable(threadFile(data, "frank", "pier", "active.jsonl"), serializeMessages([message("u2", "see you there", "2026-11-02T06:50:30Z")]));
    const listed = await handleListThreads({ dataDir: data, character: "frank", userName: "sam", timeZone: "UTC", now: () => nowMs });
    expect(listed).toContain("  sam last wrote here Monday 2026-11-02 · 5:20 AM, 2 hours ago");
    expect(listed).toContain("  sam last wrote here Monday 2026-11-02 · 6:50 AM, a minute ago");
  });
});

describe("a thread whose messages were archived", () => {
  test("still knows when the user last wrote there, for list_threads and a wake's note on where the user last wrote", async () => {
    const config = await setup();
    const data = config.dirs.data;
    const at = (day: number, time: string) => `2026-11-0${String(day)}T${time}:00Z`;
    await createThread(data, "frank", "lighthouse", NOW, { label: "The lighthouse" });
    await createThread(data, "frank", "harbor", NOW);
    await archive(data, "lighthouse", [message("u1", "the keeper sleeps", at(1, "17:58")), message("a1", "so does the light", at(1, "17:59"))]);
    writeDurable(threadFile(data, "frank", "harbor", "active.jsonl"), serializeMessages([message("u2", "fish market tomorrow", at(1, "18:04"))]));
    await archive(data, "main", [
      message("u3", "goodnight", at(2, "02:16")),
      message("a3", "sleep well", at(2, "02:17")),
      message("h1", "the house is quiet", at(2, "03:30"), { origin: "autonomous" }),
    ], 1);
    const nowMs = Date.parse(at(2, "06:50"));

    const listed = await handleListThreads({ dataDir: data, character: "frank", userName: "sam", timeZone: "UTC", now: () => nowMs });
    expect(listed).toContain([
      "main (home, you're here) · compaction on",
      "  started by sam on Sunday 2026-11-01 · 10:00 AM",
      "  sam last wrote here Monday 2026-11-02 · 2:16 AM, 5 hours ago",
    ].join("\n"));
    expect(listed).toContain([
      'lighthouse "The lighthouse" · compaction off',
      "  started by sam on Sunday 2026-11-01 · 10:00 AM",
      "  sam last wrote here Sunday 2026-11-01 · 5:58 PM, 13 hours ago",
    ].join("\n"));
    const index = await readThreadsIndex(data, "frank");
    expect(await lastWroteNote(data, "frank", index, "harbor", "sam", nowMs)).toBe('[sam last wrote to you 5 hours ago, in your home thread "main".]');
    expect(await lastWroteNote(data, "frank", index, "main", "sam", nowMs)).toBe("[sam last wrote to you 5 hours ago, in this thread.]");
    expect(await lastWroteNote(data, "frank", undefined, "main", "sam", nowMs)).toBeUndefined();

    await archive(data, "lighthouse", [message("u4", "one more page", at(2, "05:00")), message("a4", "just one", at(2, "05:01"))]);
    expect(await lastWroteNote(data, "frank", index, "main", "sam", nowMs)).toBe(
      '[sam last wrote to you 2 hours ago, in the side thread "lighthouse" (The lighthouse), which isn\'t shown here.]',
    );
    expect(await lastWroteNote(data, "frank", index, "harbor", "sam", nowMs)).toBe(
      '[sam last wrote to you 2 hours ago, in the side thread "lighthouse" (The lighthouse), which isn\'t shown here.]',
    );
    expect(await lastWroteNote(data, "frank", index, "lighthouse", "sam", nowMs)).toBe("[sam last wrote to you 2 hours ago, in this thread.]");
  });

  test("a wake's note on where the user last wrote is left out until they have written, counts the time to the second, and names the thread made first when two were written in at once", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "harbor", NOW);
    const index = await readThreadsIndex(data, "frank");
    const nowMs = Date.parse("2026-11-02T06:50:00Z");
    expect(await lastWroteNote(data, "frank", index, "main", "sam", nowMs)).toBeUndefined();

    writeDurable(threadFile(data, "frank", "harbor", "active.jsonl"), serializeMessages([message("u1", "fish market tomorrow", "2026-11-02T05:20:00Z")]));
    expect(await lastWroteNote(data, "frank", index, "main", "sam", nowMs)).toBe('[sam last wrote to you 2 hours ago, in the side thread "harbor", which isn\'t shown here.]');
    expect(await lastWroteNote(data, "frank", index, "main", "sam", nowMs - 1000)).toBe('[sam last wrote to you about an hour ago, in the side thread "harbor", which isn\'t shown here.]');

    writeDurable(threadFile(data, "frank", "main", "active.jsonl"), serializeMessages([message("u2", "goodnight", "2026-11-02T05:20:00Z")]));
    expect(await lastWroteNote(data, "frank", index, "harbor", "sam", nowMs)).toBe('[sam last wrote to you 2 hours ago, in your home thread "main".]');
  });
});

describe("coming back to the home thread", () => {
  test("after a long side-thread session, the gap marker says where the user was, from what the message recorded", async () => {
    let sent: SidecarRequest | undefined;
    const h = await reliabilityGeneration({
      generate: async () => { throw new Error("stream only"); },
      async *stream(request) {
        sent = request;
        yield {
          type: "done", content: "welcome back", finish_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          timing: { total_ms: 1, time_to_first_token_ms: 1 },
        };
      },
    });
    const at = (time: string) => `2026-11-02T${time}:00Z`;
    await h.engine.appendMessage(message("u1", "off to the lighthouse", at("18:40")));
    await h.engine.appendMessage(message("a1", "have fun", at("18:41")));
    writeDurable(threadFile(h.config.dirs.data, "ada", "harbor", "active.jsonl"), serializeMessages([message("u2", "earlier", at("12:00"))]));
    writeDurable(threadFile(h.config.dirs.data, "ada", "lighthouse", "active.jsonl"), serializeMessages([
      message("u3", "last chapter tonight", at("23:37")),
      message("a3", "the light goes out", at("23:38")),
    ]));
    h.deps.registry.listThreads = () => ["main", "harbor", "lighthouse"].map((id) => ({ id, created_at: NOW, compaction: true }));
    h.deps.now = () => at("23:40");

    await h.run(undefined, "back");

    expect(h.engine.messages().find((m) => m.content === "back")?.last_elsewhere).toEqual({ thread: "lighthouse", at: "2026-11-02T23:37:00.000Z" });
    expect(JSON.stringify(sent?.messages.at(-1))).toMatch(/5 hours later · [^\]]* · last in lighthouse 3 minutes ago\]/);
  });
});

describe("coming back to a side thread", () => {
  test("the time marker says when the user was last in the home thread, from what the message recorded", () => {
    const messages = [
      message("u1", "one more chapter", "2026-10-11T09:00:00Z"),
      message("a1", "done", "2026-10-11T09:01:00Z"),
      message("u2", "back", "2026-11-01T09:00:00Z", { last_elsewhere: { thread: "main", at: "2026-11-01T07:00:00Z" } }),
    ];
    const prompt = assemblePrompt({
      character_name: "frank",
      display_name: "sam",
      has_prior_context: false,
      messages,
      user_timestamp_mode: "auto",
    }, "UTC");
    expect(prompt.messages.at(-1)?.content).toBe("[21 days later · Sunday 2026-11-01 · 9:00 AM · last in main 2 hours ago]\n\nback");
  });
});

function replying(): { provider: Parameters<typeof reliabilityGeneration>[0]; sent: SidecarRequest[] } {
  const sent: SidecarRequest[] = [];
  return {
    sent,
    provider: {
      generate: async () => { throw new Error("stream only"); },
      async *stream(request) {
        sent.push(structuredClone(request));
        yield {
          type: "done", content: "welcome back", finish_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          timing: { total_ms: 1, time_to_first_token_ms: 1 },
        };
      },
    },
  };
}

async function compactEverything(h: Awaited<ReturnType<typeof reliabilityGeneration>>): Promise<void> {
  const data = h.config.dirs.data;
  const history = { dbPath: join(data, HISTORY_DB_FILE), archiveKey: archiveKey("ada", h.engine.thread) };
  await archiveAndRetain(threadDataDir(data, "ada", h.engine.thread), history, 0, readDurable(threadFile(data, "ada", h.engine.thread, "active.jsonl")));
  await h.engine.reload();
}

const textOf = (request: SidecarRequest | undefined, index: number): string =>
  (request?.messages[index]?.content ?? []).flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");

describe("coming back after a compaction that kept nothing", () => {
  const at = (time: string) => `2026-11-02T${time}:00Z`;

  test("the first message says how long it has been since the archived conversation, and where the user wrote in between", async () => {
    const { provider, sent } = replying();
    const h = await reliabilityGeneration(provider);
    await h.engine.appendMessage(message("u1", "off to the lighthouse", at("18:40")));
    await h.engine.appendMessage(message("a1", "have fun", at("18:41")));
    await compactEverything(h);
    writeDurable(threadFile(h.config.dirs.data, "ada", "lighthouse", "active.jsonl"), serializeMessages([
      message("u3", "last chapter tonight", at("23:37")),
      message("a3", "the light goes out", at("23:38")),
    ]));
    h.deps.registry.listThreads = () => ["main", "lighthouse"].map((id) => ({ id, created_at: NOW, compaction: true }));
    h.deps.now = () => at("23:40");

    await h.run(undefined, "back");

    expect(h.engine.messages()[0]?.last_elsewhere).toEqual({ thread: "lighthouse", at: "2026-11-02T23:37:00.000Z" });
    expect(textOf(sent[0], 0)).toMatch(/^\[5 hours later · [^\]]* · last in lighthouse 3 minutes ago\]\n\nback$/);
  });

  test("a message a few minutes after the archived conversation still says the time, since the earlier conversation isn't shown", async () => {
    const { provider, sent } = replying();
    const h = await reliabilityGeneration(provider);
    await h.engine.appendMessage(message("u1", "one more thing", at("18:40")));
    await h.engine.appendMessage(message("a1", "go on", at("18:41")));
    await compactEverything(h);
    h.deps.now = () => at("18:50");

    await h.run(undefined, "never mind");

    expect(textOf(sent[0], 0)).toMatch(/^\[[A-Z][a-z]+day 2026-11-02 · \d+:50 [AP]M\]\n\nnever mind$/);
  });

  test("in a side thread, a pause longer than the cache lasts refreshes the thread's files and says when the user was last home", async () => {
    const { provider, sent } = replying();
    const h = await reliabilityGeneration(provider, "story");
    const home = await ConversationEngine.load("ada", h.config.dirs.data);
    await home.appendMessage(message("u0", "going to write", at("09:30")));
    h.deps.registry.getOrCreate = async (_name, thread) => generationEngine(thread === "main" ? home : h.engine);
    h.deps.registry.listThreads = () => ["main", "story"].map((id) => ({ id, created_at: NOW, compaction: true }));
    const refreshed: (string | undefined)[] = [];
    h.deps.compaction.applyDeferredEdits = async (_dir, _workspace, thread) => { refreshed.push(thread); };
    await h.engine.appendMessage(message("u1", "chapter one", at("08:00")));
    await h.engine.appendMessage(message("a1", "the keeper wakes", at("08:01")));
    await compactEverything(h);
    h.deps.now = () => at("10:00");

    await h.run(undefined, "chapter two");

    expect(refreshed).toEqual(["story"]);
    expect(textOf(sent[0], 0)).toMatch(/^\[2 hours later · [^\]]* · last in main 30 minutes ago\]\n\nchapter two$/);
  });

  test("a message within half an hour of the last reply notes nowhere else the user wrote, however long ago their own last message was", async () => {
    const { provider } = replying();
    const h = await reliabilityGeneration(provider);
    await h.engine.appendMessage(message("u1", "tell me everything", at("18:00")));
    await h.engine.appendMessage(message("a1", "a long answer", at("18:50")));
    writeDurable(threadFile(h.config.dirs.data, "ada", "lighthouse", "active.jsonl"), serializeMessages([message("u3", "quick note", at("19:00"))]));
    h.deps.registry.listThreads = () => ["main", "lighthouse"].map((id) => ({ id, created_at: NOW, compaction: true }));
    h.deps.now = () => at("19:10");

    await h.run(undefined, "thanks");

    expect(h.engine.messages().find((m) => m.content === "thanks")?.last_elsewhere).toBeUndefined();
  });
});

describe("a history trimmed to fit", () => {
  test("measures the first message kept from the one dropped just before it, and says the time even when that was minutes earlier", () => {
    const keptAfter = (dropped: Message) => assemblePrompt({
      character_name: "frank",
      display_name: "sam",
      has_prior_context: false,
      messages: [dropped, message("u2", "back", "2026-11-01T12:00:00Z"), message("a2", "hello again", "2026-11-01T12:01:00Z")],
      max_context_tokens: 40_000,
      max_output_tokens: 1_000,
      user_timestamp_mode: "auto",
    }, "UTC").messages.map((m) => m.content);
    const long = "word ".repeat(40_000);

    expect(keptAfter(message("a1", long, "2026-11-01T09:01:00Z"))).toEqual(["[3 hours later · Sunday 2026-11-01 · 12:00 PM]\n\nback", "hello again"]);
    expect(keptAfter(message("u1", long, "2026-11-01T11:50:00Z"))).toEqual(["[Sunday 2026-11-01 · 12:00 PM]\n\nback", "hello again"]);
  });

  test("with nothing dropped, measures the first message from the newest archived one", () => {
    const prompt = assemblePrompt({
      character_name: "frank",
      display_name: "sam",
      has_prior_context: true,
      archived_last_at: "2026-11-01T06:00:00Z",
      messages: [message("u1", "back", "2026-11-01T09:00:00Z"), message("a1", "hello again", "2026-11-01T09:01:00Z")],
      user_timestamp_mode: "auto",
    }, "UTC");
    expect(prompt.messages.map((m) => m.content)).toEqual(["[3 hours later · Sunday 2026-11-01 · 9:00 AM]\n\nback", "hello again"]);
  });
});

describe("chat logs across threads", () => {
  test("the home thread finds a side thread's messages before they're archived, and no thread searches its own context", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "story", NOW, { label: "The lighthouse" });
    writeDurable(threadFile(data, "frank", "story", "active.jsonl"), serializeMessages([
      message("u1", "the keeper's name is Mara", NOW),
      message("a1", "Mara it is", NOW),
    ]));
    writeDurable(threadFile(data, "frank", "main", "active.jsonl"), serializeMessages([
      message("u2", "Mara should visit the harbor", NOW),
    ]));
    const options = (thread: string) => ({
      character: "frank",
      dbPath: join(data, HISTORY_DB_FILE),
      dataDir: data,
      thread,
      indexPath: join(config.dirs.cache, "chat_logs.db"),
      timeZone: "UTC",
    });

    const fromMain = await handleSearchChatLogs({ query: "Mara", all_time: true }, threadDataDir(data, "frank", "main"), options("main"));
    expect(fromMain).toContain("[story]");
    expect(fromMain).toContain("u1");
    expect(fromMain).not.toContain("u2");
    expect(await handleReadChatLogs({ around: "u1" }, threadDataDir(data, "frank", "main"), options("main"))).toContain("Mara it is");

    const fromStory = await handleSearchChatLogs({ query: "Mara", all_time: true }, threadDataDir(data, "frank", "story"), options("story"));
    expect(fromStory).toContain("u2");
    expect(fromStory).not.toContain("u1");
  });

  test("finding a message lists every thread and segment holding a copy, and a copy not archived yet, so the right segment can be excluded", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "story", NOW);
    await archive(data, "main", [message("u1", "the keeper's name is Mara", NOW), message("a1", "Mara it is", NOW)]);
    const forked = [message("u3", "Mara rows out at dawn", NOW), message("a3", "the boat leaks", NOW)];
    await archive(data, "main", forked);
    await archive(data, "story", forked);
    writeDurable(threadFile(data, "frank", "main", "active.jsonl"), serializeMessages([message("u4", "and then?", NOW)]));
    await segments(data, "frank", "main", { action: "exclude", index: 1 });

    expect(await segments(data, "frank", "story", { action: "find", msg_ids: ["u3", "u1", "u4", "u1", "gone"] })).toEqual({
      character: "frank",
      found: [
        { msg_id: "u3", copies: [{ thread: "main", segment: 1, excluded: true }, { thread: "story", segment: 0, excluded: false }] },
        { msg_id: "u1", copies: [{ thread: "main", segment: 0, excluded: false }] },
        { msg_id: "u4", copies: [{ thread: "main", segment: null, excluded: false }] },
        { msg_id: "gone", copies: [] },
      ],
    });

    expect(await segments(data, "frank", "main", { action: "exclude", index: 0, thread: "story" })).toMatchObject({ thread: "story", segment: { index: 0, excluded: true } });
    expect(await segments(data, "frank", "main", { action: "find", msg_ids: ["u3"] })).toMatchObject({
      found: [{ msg_id: "u3", copies: [{ thread: "main", segment: 1, excluded: true }, { thread: "story", segment: 0, excluded: true }] }],
    });
    expect(await outcomeOf(segments(data, "frank", "main", { action: "exclude", index: 0, thread: "../story" }))).toThrow("invalid thread");
  });

  test("the web UI picks out the id of every message a chat log result lists, to look up their segments", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "story", NOW);
    const at = (time: string) => `2026-11-01T${time}:00Z`;
    await archive(data, "main", [
      message("u1", "the keeper's name is Mara", at("09:00")),
      message("a1", "Mara it is", at("09:01")),
      message("h1", "Mara keeps the light", at("12:00"), { origin: "autonomous" }),
    ]);
    const forked = [message("u3", "Mara rows out at dawn", at("13:00"))];
    await archive(data, "main", forked);
    await archive(data, "story", forked);
    writeDurable(threadFile(data, "frank", "main", "active.jsonl"), serializeMessages([message("u4", "and Mara?", at("14:00"))]));
    const options = { character: "frank", dbPath: join(data, HISTORY_DB_FILE), dataDir: data, thread: "story", indexPath: join(config.dirs.cache, "chat_logs.db"), timeZone: "UTC", userName: "sam" };
    const listed = (result: string) => result.split("\n").flatMap((line) => chatLogMessageId(line) ?? []);

    const search = await handleSearchChatLogs({ query: "Mara", all_time: true, sort: "oldest" }, threadDataDir(data, "frank", "story"), options);
    expect(search).toContain("(wake)");
    expect(search).toContain("also in story");
    expect(listed(search)).toEqual(["u1", "a1", "h1", "u3", "u4"]);
    const read = await handleReadChatLogs({ around: "h1", before: 5, after: 5 }, threadDataDir(data, "frank", "story"), options);
    expect(read).toContain("▶ ");
    expect(listed(read)).toEqual(["u1", "a1", "h1", "u3", "u4"]);
  });

  test("a message still in another thread's conversation is marked as from the character's own time only when it was", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "story", NOW);
    const at = (time: string) => `2026-11-01T${time}:00Z`;
    writeDurable(threadFile(data, "frank", "main", "active.jsonl"), serializeMessages([
      message("u1", "where is Mara?", at("09:00")),
      message("a1", "Mara is out", at("09:01")),
      message("h1", "Mara came back", at("12:00"), { origin: "autonomous" }),
    ]));
    const options = { character: "frank", dbPath: join(data, HISTORY_DB_FILE), dataDir: data, thread: "story", indexPath: join(config.dirs.cache, "chat_logs.db"), timeZone: "UTC", userName: "sam" };

    const search = await handleSearchChatLogs({ query: "Mara", all_time: true, sort: "oldest" }, threadDataDir(data, "frank", "story"), options);

    expect(search.split("\n").slice(2)).toEqual([
      "2026-11-01 Sun 09:00  sam    where is [Mara]?  u1",
      "2026-11-01 Sun 09:01  frank  [Mara] is out  a1",
      "2026-11-01 Sun 12:00  frank  (wake) [Mara] came back  h1",
    ]);
  });

  test("read back, a message the character sent from a wake is marked as one, and a day's overview says when a stretch held nothing else", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "story", NOW);
    const at = (time: string) => `2026-11-01T${time}:00Z`;
    writeDurable(threadFile(data, "frank", "main", "active.jsonl"), serializeMessages([
      message("u1", "where is Mara?", at("01:00")),
      message("a1", "Mara is out", at("01:01")),
      message("h1", "Mara came back", at("06:00"), { origin: "autonomous" }),
      message("h2", "The lamp is lit", at("12:00"), { origin: "autonomous" }),
      message("h3", "Still lit", at("12:30"), { origin: "autonomous" }),
      message("a2", "As I was saying", at("18:00")),
      message("h4", "Goodnight", at("18:10"), { origin: "autonomous" }),
    ]));
    const options = { character: "frank", dbPath: join(data, HISTORY_DB_FILE), dataDir: data, thread: "story", indexPath: join(config.dirs.cache, "chat_logs.db"), timeZone: "UTC", userName: "sam" };

    const read = await handleReadChatLogs({ around: "h1", before: 1, after: 0 }, threadDataDir(data, "frank", "story"), options);
    expect(read.split("\n").filter((line) => line.endsWith("  a1") || line.endsWith("  h1"))).toEqual([
      "2026-11-01 Sun 01:01  frank  a1",
      "▶ 2026-11-01 Sun 06:00  frank  (wake)  h1",
    ]);
    const overview = await handleReadChatLogs({ overview: "2026-11-01" }, threadDataDir(data, "frank", "story"), options);
    expect(overview.split("\n")).toEqual([
      "2026-11-01 Sun: 4 conversations, 7 messages that day (split at gaps of 90+ min, UTC)",
      "",
      "01:00 → 01:01  2 msgs  first: where is Mara?",
      "06:00 → 06:00  1 msg   1 message frank sent from a wake, no reply from sam",
      "12:00 → 12:30  2 msgs  2 messages frank sent from wakes, no reply from sam",
      "18:00 → 18:10  2 msgs  2 from frank, none from sam",
    ]);
  });

  test("a turn that starts fresh, as a wake does, finds what is still in its own thread's conversation, since none of it is in its context", async () => {
    const config = await setup();
    const data = config.dirs.data;
    await createThread(data, "frank", "story", NOW);
    writeDurable(threadFile(data, "frank", "main", "active.jsonl"), serializeMessages([
      message("a1", "I repainted the lighthouse door", NOW),
    ]));
    const search = async (fresh: boolean | undefined): Promise<string> => await handleSearchChatLogs({ query: "lighthouse door", all_time: true }, threadDataDir(data, "frank", "main"), {
      character: "frank",
      dbPath: join(data, HISTORY_DB_FILE),
      dataDir: data,
      thread: "main",
      ...(fresh === undefined ? {} : { fresh }),
      indexPath: join(config.dirs.cache, "chat_logs.db"),
      timeZone: "UTC",
    });
    expect(await search(undefined)).not.toContain("a1");
    expect(await search(false)).not.toContain("a1");
    const found = await search(true);
    expect(found).toContain("I repainted the [lighthouse] [door]  a1");
    expect(await search(undefined)).not.toContain("a1");
  });
});
