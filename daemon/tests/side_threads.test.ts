import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { elsewhereNote } from "../src/autonomy/heartbeat_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { CharacterRegistry } from "../src/characters.ts";
import { archiveKey, characterDataDir, threadDataDir } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { HISTORY_DB_FILE } from "../src/engine/history_store.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { assemblePrompt } from "../src/engine/prompt.ts";
import { createThread, readThreadsIndex } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { buildGenerationRequest } from "../src/handler/setup.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { applyDeferredEdits } from "../src/memory/deferred_edits.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
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
    engine: { thread, messages: () => messages, messagesThroughLastUserTurn: () => messages, segmentCount: () => 0 },
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
    expect(listed).toContain('Your home thread is "main", where heartbeats happen. You\'re in "lighthouse".');
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

describe("a thread whose messages were archived", () => {
  test("still knows when the user last wrote there, for list_threads and the heartbeat's note about side threads", async () => {
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
    expect(await elsewhereNote(data, "frank", "main", "sam", nowMs)).toBeUndefined();

    await archive(data, "lighthouse", [message("u4", "one more page", at(2, "05:00")), message("a4", "just one", at(2, "05:01"))]);
    expect(await elsewhereNote(data, "frank", "main", "sam", nowMs)).toBe(
      '[sam last wrote to you 2 hours ago, in the side thread "lighthouse" (The lighthouse). ' +
        "That conversation isn't shown here, so a quiet home thread doesn't mean sam has been away.]",
    );
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
});
