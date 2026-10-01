import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extract } from "tar";

import { exportCharacter, importCharacter, type ArchiveContext } from "../src/commands/archive.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { characterCacheDir, resolveShoreDirs } from "../src/config/dirs.ts";
import { parseConfigTable, type LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { imageDataForPath } from "../src/engine/wire_images.ts";
import { generationEngine, runGeneration, type GenerationDeps } from "../src/handler/generation.ts";
import { ingestImages, type ImageUpload } from "../src/handler/images.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import type { TurnAutonomy } from "../src/handler/turn.ts";
import { buildLlmMessages } from "../src/handler/wire_messages.ts";
import { findModelCopy, modelCopies } from "../src/llm/images.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { createRuntime } from "../src/runtime.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { appendDurableLine, readDurable, writeDurable } from "../src/storage/files.ts";
import {
  attachmentCacheDir,
  DEFAULT_IMAGE_CACHE_BYTES,
  evictCachedImages,
  imageCacheLimit,
  setImageCacheLimit,
  toolImageCacheDir,
} from "../src/storage/image_cache.ts";
import { moveImagesToCache } from "../src/storage/image_migration.ts";
import { closeStorageConnections, databasePath, readState } from "../src/storage/store.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { carryToolMedia } from "../src/tools/media.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../src/tools/workspace.ts";
import { required } from "../src/util/required.ts";
import { setTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
import { sizedImage } from "./support/sized_image.ts";
import { eventsForResponse } from "./support/stream.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_IMAGE_CACHE_FIXTURE_KEY";
const HOUR = 3_600_000;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const roots: string[] = [];
afterEach(() => {
  setImageCacheLimit(DEFAULT_IMAGE_CACHE_BYTES);
  closeStorageConnections();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(testTmp("shore-image-cache-"));
  roots.push(root);
  return root;
}

let photoBytes: Buffer | undefined;
async function photo(filename: string): Promise<ImageUpload> {
  photoBytes ??= await sizedImage(400, 300);
  return { filename, mime_type: "image/png", data: photoBytes.toString("base64") };
}

async function upload(cache: string, filename: string, character = "ada"): Promise<string> {
  const { images } = await ingestImages(cache, character, [filename], [await photo(filename)], new Date("2026-10-01T09:00:00Z"));
  return required(images[0]).path;
}

function filesOf(original: string): string[] {
  return [original, ...modelCopies(original)];
}

function lastUsed(original: string, msAgo: number): void {
  const at = new Date(Date.now() - msAgo);
  for (const path of filesOf(original)) utimesSync(path, at, at);
}

function bytesOf(original: string): number {
  return filesOf(original).reduce((total, path) => total + statSync(path).size, 0);
}

function userMessage(text: string, images: string[], msgId = "u1"): Message {
  return {
    msg_id: msgId,
    role: "user",
    content: text,
    images: images.map((path) => ({ path })),
    content_blocks: [{ type: "text", text }],
    timestamp: "2026-10-01T09:00:00.000Z",
  };
}

async function world() {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await tempRoot();
  const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.behavior.user_message_timestamps = "never";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture",
    qualifiedName: "chat.fixture",
    category: "chat",
    providerKey: "anthropic",
    sdk: "anthropic",
    modelId: "claude-fixture",
    apiKeyEnv: KEY_ENV,
    maxContextTokens: 200_000,
    maxOutputTokens: 1_000,
  });
  const config: LoadedConfig = { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
  await mkdir(join(dirs.config, "characters", "ada", "workspace"), { recursive: true });
  await writeFile(join(dirs.config, "characters", "ada", "workspace", "SOUL.md"), "ada");
  initializeDatabase(dirs.data);

  const requests: SidecarRequest[] = [];
  const provider: SidecarProvider = {
    stream: (request) => {
      requests.push(structuredClone(request));
      return eventsForResponse({
        content: "ok",
        content_blocks: [{ type: "text", text: "ok" }],
        model: "claude-fixture",
        finish_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      });
    },
    generate: () => { throw new Error("no case generates"); },
  };
  const autonomy: TurnAutonomy & GenerationDeps["autonomy"] = {
    ensureState: () => false,
    needsActivityBackfill: () => false,
    backfillActivity: () => {},
    onUserMessage: () => {},
    shouldCompactNow: () => false,
    onCompactionComplete: () => {},
    onCompactionFailed: () => {},
    notifyLastRequest: () => {},
    notifyAssistantMessage: () => {},
  };
  const engine = generationEngine(await ConversationEngine.load("ada", dirs.data, undefined, "main"));
  const deps: GenerationDeps = {
    registry: {
      getOrCreate: async () => engine,
      effectiveConfig: () => config,
      listThreads: () => [{ id: "main", created_at: "2026-10-01T00:00:00.000Z", compaction: true }],
    },
    dataDir: dirs.data,
    providers: { anthropic: provider },
    autonomy,
    notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
    diagnostics: { key_fallbacks: { push: () => {} } },
    emitEvent: () => {},
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => ({ kind: "completed", retained: 0 }), applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
    newlyCrossedPlanLimitWarnings: async () => [],
    now: () => "2026-10-01T09:00:00+00:00",
    newMessageId: () => `m_${crypto.randomUUID()}`,
    monotonicMs: () => 0,
    sleep: async () => {},
  };
  const send = async (text: string, uploads: ImageUpload[] = []) => {
    await runGeneration(deps, {
      meta: {
        session: {
          clientId: 1, sessionId: 1, clientType: "test-client", clientName: "test-1",
          capabilities: ["streaming"], selectedCharacter: "ada",
        },
        rid: null,
        kind: "message",
      } as never,
      body: { rid: null, text, stream: true, images: uploads.map((image) => image.filename), image_data: uploads },
      regen: false,
      charName: "ada",
      rid: null,
      send: async () => {},
      signal: new AbortController().signal,
    });
  };
  const stored = async () => (await ConversationEngine.load("ada", dirs.data, undefined, "main")).messages();
  return { dirs, requests, send, stored };
}

function firstUserContent(request: SidecarRequest | undefined): ContentBlock[] {
  return required(required(request).messages.find((message) => message.role === "user")).content;
}

describe("an image a user sends", () => {
  test("is kept in the cache dir beside its reduced copy, and nothing is written to the data dir", async () => {
    const { dirs, requests, send, stored } = await world();
    await send("look", [await photo("photo.png")]);
    const path = required((await stored())[0]?.images[0]).path;
    expect(dirname(path)).toBe(attachmentCacheDir(dirs.cache, "ada"));
    expect(basename(path)).toEndWith("_photo.png");
    const copy = required(findModelCopy(path));
    expect(dirname(copy.path)).toBe(join(attachmentCacheDir(dirs.cache, "ada"), "model"));
    expect(existsSync(join(dirs.data, "media"))).toBe(false);
    expect(firstUserContent(requests[0])[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: copy.mediaType, data: (await readFile(copy.path)).toString("base64") },
    });
  });

  test("that has left the cache reaches the model as a notice in its place", async () => {
    const { dirs, requests, send, stored } = await world();
    await send("look", [await photo("photo.png")]);
    const path = required((await stored())[0]?.images[0]).path;
    lastUsed(path, 2 * HOUR);
    expect(evictCachedImages(dirs.cache, 0).removed).toBe(1);
    expect(existsSync(path)).toBe(false);

    await send("and now?");
    expect(firstUserContent(requests[1])).toEqual([
      { type: "text", text: `[image omitted: ${basename(path)} — no longer cached]` },
      { type: "text", text: "look" },
    ]);
  });
});

describe("the image cache", () => {
  test("past its limit, deletes the least recently used images first and keeps the one the latest request read", async () => {
    const cache = await tempRoot();
    const shown = await upload(cache, "shown.png");
    const older = await upload(cache, "older.png");
    const old = await upload(cache, "old.png");
    lastUsed(shown, 6 * HOUR);
    lastUsed(older, 5 * HOUR);
    lastUsed(old, 4 * HOUR);
    const { messages } = await buildLlmMessages({ system: [], messages: [userMessage("again", [shown])] }, "text_standin");
    expect(required(messages[0]).content[0]?.type).toBe("image");

    setImageCacheLimit(Math.floor(bytesOf(shown) * 2.5));
    const fresh = await upload(cache, "fresh.png");

    for (const gone of [older, old]) {
      expect(existsSync(gone)).toBe(false);
      expect(modelCopies(gone)).toEqual([]);
    }
    for (const kept of [shown, fresh]) {
      expect(existsSync(kept)).toBe(true);
      expect(modelCopies(kept)).toHaveLength(1);
    }
  });

  test("keeps every image used in the last hour, even over its limit", async () => {
    const cache = await tempRoot();
    const recent = await upload(cache, "recent.png");
    lastUsed(recent, HOUR - 60_000);
    expect(evictCachedImages(cache, 0)).toEqual({ removed: 0, freed: 0, remaining: bytesOf(recent) });
    expect(existsSync(recent)).toBe(true);

    lastUsed(recent, HOUR + 60_000);
    const bytes = bytesOf(recent);
    expect(evictCachedImages(cache, 0)).toEqual({ removed: 1, freed: bytes, remaining: 0 });
    expect(existsSync(recent)).toBe(false);
  });

  test("deletes an attachment and its reduced copy together", async () => {
    const cache = await tempRoot();
    const first = await upload(cache, "first.png");
    const second = await upload(cache, "second.png");
    lastUsed(first, 3 * HOUR);
    lastUsed(second, 2 * HOUR);
    const eviction = evictCachedImages(cache, bytesOf(first) + bytesOf(second) - statSync(first).size);
    expect(eviction).toEqual({ removed: 1, freed: eviction.freed, remaining: bytesOf(second) });
    expect(existsSync(first)).toBe(false);
    expect(modelCopies(first)).toEqual([]);
    expect(modelCopies(second)).toHaveLength(1);
  });

  test("counts an upload and its reduced copy, and evicts only once past the limit", async () => {
    for (const [slack, kept] of [[0, true], [-1, false]] as const) {
      const cache = await tempRoot();
      const aged = await upload(cache, "aged.png");
      lastUsed(aged, 3 * HOUR);
      setImageCacheLimit(2 * bytesOf(aged) + slack);
      await upload(cache, "next.png");
      expect(existsSync(aged)).toBe(kept);
    }
  });

  test("an image that has gone is no reason to warn when a history page embeds it", async () => {
    const cache = await tempRoot();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(imageDataForPath(join(cache, "gone.png"))).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(imageDataForPath(cache)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("has one limit for every character together", async () => {
    const cache = await tempRoot();
    const ada = await upload(cache, "ada.png", "ada");
    const bea = await upload(cache, "bea.png", "bea");
    lastUsed(ada, 3 * HOUR);
    lastUsed(bea, 2 * HOUR);
    const eviction = evictCachedImages(cache, bytesOf(bea));
    expect(eviction.removed).toBe(1);
    expect(existsSync(ada)).toBe(false);
    expect(existsSync(bea)).toBe(true);
  });

  test("holds the images tools return, which count against the same limit", async () => {
    const cache = await tempRoot();
    const aged = await upload(cache, "aged.png");
    lastUsed(aged, 3 * HOUR);
    setImageCacheLimit(bytesOf(aged));
    const exec: ToolExecution = {
      ctx: {
        workspaceDir: cache, characterName: "ada", characterDataDir: cache, imageDir: "", cacheDir: cache,
        conversationDir: cache, historyDbPath: join(cache, "history.db"), configDir: cache,
        retrievalConfig: DEFAULT_RETRIEVAL_CONFIG, retrievalMode: "auto",
        mcpCall: () => Promise.resolve(carryToolMedia({ value: "a screenshot", media: [{ mime_type: "image/png", data: PNG, label: "screenshot" }], extra: [] })),
      },
      sendDirect: () => {},
      limits: { max_result_chars: 50_000, timeout_ms: 5000 },
      now: () => "2026-10-01T09:00:00+00:00",
      newMessageId: () => "m_tool",
    };
    const run = await runToolUse({ id: "toolu_1", name: "mcp__browser__screenshot", input: {} }, exec, []);
    const saved = join(toolImageCacheDir(cache, "ada"), "2026_10_01T09_00_00_00_00_toolu_1_0.png");
    expect(run.output).toContain(`[screenshot attached, saved to ${saved}]`);
    expect((await readFile(saved)).toString("base64")).toBe(PNG);
    expect(existsSync(aged)).toBe(false);
  });

  test("is where every tool run a character makes saves the images tools return", async () => {
    const { dirs } = await world();
    const app = defaultAppConfig();
    const config: LoadedConfig = { app, models: emptyCatalog(), providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await buildToolContext(config, dirs.data, "ada")).cacheDir).toBe(dirs.cache);
    } finally {
      warn.mockRestore();
    }
  });

  test("starts from the setting, which is read from [daemon] and is 512 MiB by default", () => {
    const read = (text: string) => parseConfigTable(Bun.TOML.parse(text) as Record<string, unknown>, resolveShoreDirs({ SHORE_CONFIG_DIR: "/tmp/shore-image-cache-config" }), () => {});
    expect(read("").app.daemon.image_cache_bytes).toBe(512 * 1024 * 1024);
    expect(read("[daemon]\nimage_cache_bytes = 1048576\n").app.daemon.image_cache_bytes).toBe(1_048_576);
  });
});

describe("moving images out of the data dir", () => {
  async function legacyDataDir() {
    const root = await tempRoot();
    const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    initializeDatabase(dirs.data);
    const media = join(dirs.data, "media", "ada");
    const attachments = join(media, "attachments");
    await mkdir(join(attachments, "model"), { recursive: true });
    await mkdir(join(media, "tools"), { recursive: true });
    await mkdir(join(media, "generated"), { recursive: true });
    const bytes = await sizedImage(400, 300);
    const reduced = await sizedImage(200, 150, (image) => image.webp());
    const shown = join(attachments, "20260301_120000_shown.png");
    const side = join(attachments, "20260302_120000_side.png");
    const archived = join(attachments, "20260101_120000_archived.png");
    for (const path of [shown, side, archived]) await writeFile(path, bytes);
    await writeFile(join(attachments, "model", "20260301_120000_shown.png.webp"), reduced);
    await writeFile(join(attachments, "model", "20260101_120000_archived.png.webp"), reduced);
    await writeFile(join(media, "tools", "20260301_toolu_0.png"), bytes);
    await writeFile(join(media, "generated", "20260301_drawn.png"), bytes);
    const main = [userMessage("look at this", [shown], "u1")];
    writeDurable(join(dirs.data, "ada", "threads", "main", "active.jsonl"), `${main.map((message) => JSON.stringify(message)).join("\n")}\n`);
    appendDurableLine(join(dirs.data, "ada", "threads", "side", "active.jsonl"), `${JSON.stringify(userMessage("and this", [side], "u2"))}\n`);
    const history = HistoryStore.open(databasePath(dirs.data));
    try {
      history.putSegment("ada", 0, { file: "history.db", message_count: 1, compacted_at: "2026-01-02T00:00:00Z" }, [userMessage("long ago", [archived], "u0")]);
    } finally {
      history.close();
    }
    return { dirs, media, shown, side, archived, reduced };
  }

  test("keeps the attachments active conversations show, still sent to the model, and deletes the rest", async () => {
    const { dirs, media, shown, side, archived, reduced } = await legacyDataDir();
    expect(moveImagesToCache(dirs.data, dirs.cache)).toEqual({ moved: 2, removed: 3 });

    expect(existsSync(join(media, "tools"))).toBe(false);
    expect(existsSync(join(media, "attachments"))).toBe(false);
    expect(existsSync(join(media, "generated", "20260301_drawn.png"))).toBe(true);
    const cached = attachmentCacheDir(dirs.cache, "ada");
    const main = (await ConversationEngine.load("ada", dirs.data, undefined, "main")).messages();
    const sideThread = (await ConversationEngine.load("ada", dirs.data, undefined, "side")).messages();
    expect(main[0]?.images).toEqual([{ path: join(cached, basename(shown)) }]);
    expect(sideThread[0]?.images).toEqual([{ path: join(cached, basename(side)) }]);
    expect(existsSync(join(cached, basename(archived)))).toBe(false);

    const { messages } = await buildLlmMessages({ system: [], messages: [...main] }, "text_standin");
    expect(required(messages[0]).content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/webp", data: reduced.toString("base64") },
    });

    const history = HistoryStore.open(databasePath(dirs.data));
    try {
      expect(history.readSegment("ada", 0)[0]?.images).toEqual([{ path: archived }]);
    } finally {
      history.close();
    }
    expect(moveImagesToCache(dirs.data, dirs.cache)).toEqual({ moved: 0, removed: 0 });
  });

  test("marks the images it keeps as just used, so the first eviction after the move spares them", async () => {
    const { dirs, shown } = await legacyDataDir();
    moveImagesToCache(dirs.data, dirs.cache);
    const kept = join(attachmentCacheDir(dirs.cache, "ada"), basename(shown));
    expect(evictCachedImages(dirs.cache, 0).removed).toBe(0);
    expect(Date.now() - statSync(kept).mtimeMs).toBeLessThan(HOUR);
  });

  test("leaves a line it cannot parse as it was", async () => {
    const { dirs, shown } = await legacyDataDir();
    const path = join(dirs.data, "ada", "threads", "main", "active.jsonl");
    writeDurable(path, `{not json ${JSON.stringify(shown)}\n${JSON.stringify(userMessage("look", [shown]))}\n`);
    moveImagesToCache(dirs.data, dirs.cache);
    const [broken, parsed] = readDurable(path).split("\n");
    expect(broken).toBe(`{not json ${JSON.stringify(shown)}`);
    expect((JSON.parse(required(parsed)) as Message).images).toEqual([{ path: join(attachmentCacheDir(dirs.cache, "ada"), basename(shown)) }]);
  });

  test("happens when the daemon starts, which also applies the configured limit", async () => {
    const { dirs, media, shown } = await legacyDataDir();
    const stale = await upload(dirs.cache, "stale.png", "bea");
    lastUsed(stale, 3 * HOUR);
    const app = defaultAppConfig();
    app.daemon.image_cache_bytes = 1;
    const config: LoadedConfig = { app, models: emptyCatalog(), providers: ProviderRegistry.empty(), dirs, rawTable: undefined };
    const runtime = await createRuntime({ config, providers: {}, connectMcp: () => Promise.reject(new Error("no MCP server")) });
    try {
      expect(imageCacheLimit()).toBe(1);
      expect(existsSync(join(media, "tools"))).toBe(false);
      expect(existsSync(join(attachmentCacheDir(dirs.cache, "ada"), basename(shown)))).toBe(true);
      expect(existsSync(stale)).toBe(false);
    } finally {
      await runtime.autonomy.shutdown();
      await runtime.shutdown();
    }
  });
});

describe("a character archive", () => {
  test("whose import fails takes the images it put in the cache with it", async () => {
    const root = await tempRoot();
    const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run"), workspace: join(root, "workspace") };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    const context: ArchiveContext = {
      dirs, hasCharacter: () => false, withSnapshot: async (run) => await run(),
      refreshDiscovery: () => Promise.reject(new Error("discovery failed")), releaseCharacter: async () => {},
    };
    const archive = join(import.meta.dir, "fixtures/supported-baseline/ada.shore.tar.gz");
    expect(await outcomeOf(importCharacter(context, { archive }))).toThrow("discovery failed");
    expect(existsSync(characterCacheDir(dirs.cache, "ada"))).toBe(false);
    expect(existsSync(join(dirs.data, "media", "ada"))).toBe(false);
  });

  test("carries the cached images active conversations show, and no others", async () => {
    const root = await tempRoot();
    const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "run") };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    await mkdir(join(dirs.config, "characters", "ada", "workspace"), { recursive: true });
    await writeFile(join(dirs.config, "characters", "ada", "workspace", "SOUL.md"), "ada");
    initializeDatabase(dirs.data);
    const shown = await upload(dirs.cache, "shown.png");
    const archived = await upload(dirs.cache, "archived.png");
    writeDurable(join(dirs.data, "ada", "threads", "main", "active.jsonl"), `${JSON.stringify(userMessage("look", [shown]))}\n`);
    const history = HistoryStore.open(databasePath(dirs.data));
    try {
      history.putSegment("ada", 0, { file: "history.db", message_count: 1, compacted_at: "2026-01-02T00:00:00Z" }, [userMessage("long ago", [archived], "u0")]);
    } finally {
      history.close();
    }
    const context: ArchiveContext = {
      dirs, hasCharacter: () => true, withSnapshot: async (run) => await run(),
      refreshDiscovery: async () => {}, releaseCharacter: async () => {},
    };
    const output = join(root, "ada.shore.tar.gz");
    await exportCharacter(context, { character: "ada", output });
    const unpacked = join(root, "unpacked");
    await mkdir(unpacked);
    await extract({ file: output, cwd: unpacked });

    const legacy = join(dirs.data, "media", "ada", "attachments");
    expect((await readFile(join(unpacked, "media", "attachments", basename(shown)))).equals(await readFile(shown))).toBe(true);
    expect(existsSync(join(unpacked, "media", "attachments", "model", basename(required(findModelCopy(shown)).path)))).toBe(true);
    expect(existsSync(join(unpacked, "media", "attachments", basename(archived)))).toBe(false);
    const window = required(readState(unpacked, "ada/threads/main/active.jsonl"));
    expect(window.trim().split("\n").map((line) => (JSON.parse(line) as Message).images)).toEqual([[{ path: join(legacy, basename(shown)) }]]);
  });
});
