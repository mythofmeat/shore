import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import { characterDataDir, threadDataDir } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { HISTORY_DB_FILE } from "../src/engine/history_store.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { assemblePrompt } from "../src/engine/prompt.ts";
import { createThread } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { buildGenerationRequest } from "../src/handler/setup.ts";
import { applyDeferredEdits } from "../src/memory/deferred_edits.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import { handleReadChatLogs, handleSearchChatLogs } from "../src/tools/history.ts";
import { outcomeOf } from "./support/outcome.ts";
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

describe("coming back to a side thread", () => {
  test("the time marker says when the user was last in the home thread, from what the message recorded", () => {
    const messages = [
      message("u1", "one more chapter", "2026-10-11T09:00:00Z"),
      message("a1", "done", "2026-10-11T09:01:00Z"),
      message("u2", "back", "2026-11-01T09:00:00Z", { last_in_home: { thread: "main", at: "2026-11-01T07:00:00Z" } }),
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
