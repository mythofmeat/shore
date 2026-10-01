import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { query, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { extract } from "tar";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { exportCharacter, importCharacter, type ArchiveContext } from "../src/commands/archive.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { ingestImages } from "../src/handler/images.ts";
import { modelCopies } from "../src/llm/images.ts";
import { sessionKey } from "../src/llm/providers/agent_sessions.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { nativeHistoryStore } from "../src/llm/providers/claude_agent_history.ts";
import type { SidecarRequest, StreamEvent, WireMessage } from "../src/llm/types.ts";
import { createRuntime } from "../src/runtime.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { imageBlobDir, imageCacheFor, useImageCacheFor, withImageTokens } from "../src/storage/image_blobs.ts";
import { cachedImageBytes, DEFAULT_IMAGE_CACHE_BYTES, imageCacheDir, setImageCacheLimit } from "../src/storage/image_cache.ts";
import { moveImagesOutOfDatabase } from "../src/storage/image_db_migration.ts";
import { closeStorageConnections, databasePath, unpack, withStorage } from "../src/storage/store.ts";
import { CassettePlayer, snapshotOf } from "../src/testing/cassette.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import { required } from "../src/util/required.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

const HOUR = 3_600_000;
const INLINE_IMAGE = /(?<="|base64,)(?:iVBORw0KGg|\/9j\/|R0lGOD|UklGR)[A-Za-z0-9+/]{64,}={0,2}/;

const roots: string[] = [];
afterEach(() => {
  closeStorageConnections();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function dirs() {
  const root = await mkdtemp(testTmp("shore-image-blobs-"));
  roots.push(root);
  const data = join(root, "data");
  const cache = join(root, "cache");
  await mkdir(data, { recursive: true });
  await mkdir(cache, { recursive: true });
  initializeDatabase(data);
  return { root, data, cache };
}

let small: string | undefined;
async function png(): Promise<string> {
  small ??= (await sizedImage(400, 300)).toString("base64");
  return small;
}

async function noise(width = 300, height = 300): Promise<string> {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * height);
  bmp.write("BM");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  randomBytes(stride * height).copy(bmp, 54);
  return Buffer.from(await new Bun.Image(bmp).png().toBuffer()).toString("base64");
}

const imageBlock = (data: string): ContentBlock => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

function sha256Of(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

function tokenOf(base64: string): string {
  return `shore-image:sha256=${sha256Of(base64)};type=image/png;bytes=${String(Buffer.from(base64, "base64").byteLength)}`;
}

function notice(base64: string): ContentBlock {
  return { type: "text", text: `[image omitted: ${sha256Of(base64).slice(0, 12)}.png — no longer cached]` };
}

function transcriptText(data: string): string {
  return withStorage(data, (db) =>
    (db.query("SELECT content FROM state_lines WHERE path GLOB 'sdk_transcripts/*' ORDER BY path, seq").all() as { content: Uint8Array }[])
      .map((row) => unpack(row.content)).join("\n"));
}

function entryWith(content: ContentBlock[], uuid = "u1"): SessionStoreEntry {
  return {
    type: "user", uuid, parentUuid: null, sessionId: "s1", timestamp: "2026-10-01T09:00:00.000Z",
    message: { role: "user", content },
  };
}

function transcriptStore(data: string) {
  return nativeHistoryStore(join(data, "sessions.json"), sessionKey("ada", databasePath(data), "main"), true);
}

const SESSION = { projectKey: "", sessionId: "s1" };

describe("a Claude Agent SDK transcript", () => {
  test("keeps a reference where an image was, and gives the image back when it is loaded", async () => {
    const { data, cache } = await dirs();
    useImageCacheFor(data, cache);
    const image = await png();
    const cached: ContentBlock = Object.assign(imageBlock(image), { cache_control: { type: "ephemeral" } });
    const entry = entryWith([cached, { type: "tool_result", tool_use_id: "t1", content: [imageBlock(image)] }, { type: "text", text: "look" }]);
    await transcriptStore(data).append(SESSION, [entry]);

    const stored = transcriptText(data);
    expect(stored).not.toMatch(INLINE_IMAGE);
    expect(stored).toContain(`"source":{"type":"shore_image","sha256":"${sha256Of(image)}","media_type":"image/png","bytes":${String(Buffer.from(image, "base64").byteLength)}}`);
    expect(readdirSync(imageBlobDir(cache, "ada"))).toEqual([`${sha256Of(image)}.png`]);
    expect(await transcriptStore(data).load(SESSION)).toEqual([entry]);
  });

  test("counts as a use of its images each time it is loaded", async () => {
    const { data, cache } = await dirs();
    useImageCacheFor(data, cache);
    const image = await png();
    await transcriptStore(data).append(SESSION, [entryWith([imageBlock(image)])]);
    const blob = join(imageBlobDir(cache, "ada"), `${sha256Of(image)}.png`);
    const earlier = new Date(Date.now() - 3 * HOUR);
    utimesSync(blob, earlier, earlier);
    await transcriptStore(data).load(SESSION);
    expect(Date.now() - statSync(blob).mtimeMs).toBeLessThan(HOUR);
  });

  test("keeps an image inline when its base64 would not come back the same", async () => {
    const { data, cache } = await dirs();
    useImageCacheFor(data, cache);
    const image = await png();
    const entry = entryWith([imageBlock(`${image.slice(0, 100)}\n${image.slice(100)}`)]);
    await transcriptStore(data).append(SESSION, [entry]);
    expect(existsSync(imageBlobDir(cache, "ada"))).toBe(false);
    expect(await transcriptStore(data).load(SESSION)).toEqual([entry]);
  });

  test("keeps an image inline, with a warning, when the cache cannot hold it", async () => {
    const { data, cache } = await dirs();
    useImageCacheFor(data, cache);
    await mkdir(imageCacheDir(cache, "ada"), { recursive: true });
    await writeFile(imageBlobDir(cache, "ada"), "not a directory");
    const image = await png();
    const entry = entryWith([imageBlock(image)]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await transcriptStore(data).append(SESSION, [entry]);
      const warnings = warn.mock.calls.map((call) => String(call[0]));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not keep an image in the image cache");
    } finally {
      warn.mockRestore();
    }
    expect(transcriptText(data)).toContain(image);
    expect(await transcriptStore(data).load(SESSION)).toEqual([entry]);
  });

  test("puts its images in the image cache under the same limit as everything else", async () => {
    const { data, cache } = await dirs();
    useImageCacheFor(data, cache);
    const { images } = await ingestImages(cache, "ada", ["old.png"], [{ filename: "old.png", data: await png() }]);
    const old = required(images[0]).path;
    const earlier = new Date(Date.now() - 3 * HOUR);
    for (const path of [old, ...modelCopies(old)]) utimesSync(path, earlier, earlier);
    setImageCacheLimit(cachedImageBytes(cache));
    try {
      await transcriptStore(data).append(SESSION, [entryWith([imageBlock(await noise(40, 30))])]);
    } finally {
      setImageCacheLimit(DEFAULT_IMAGE_CACHE_BYTES);
    }
    expect(existsSync(old)).toBe(false);
  });

  test("whose image has left the cache sends a notice in its place", async () => {
    const { data, cache } = await dirs();
    useImageCacheFor(data, cache);
    const image = await png();
    await transcriptStore(data).append(SESSION, [entryWith([imageBlock(image), { type: "text", text: "look" }])]);
    rmSync(imageBlobDir(cache, "ada"), { recursive: true });
    expect(await transcriptStore(data).load(SESSION)).toEqual([entryWith([notice(image), { type: "text", text: "look" }])]);
  });

  test("of a data dir without an image cache keeps its images inline, as before", async () => {
    const { data } = await dirs();
    const image = await png();
    const entry = entryWith([imageBlock(image)]);
    await transcriptStore(data).append(SESSION, [entry]);
    expect(transcriptText(data)).toContain(image);
    expect(await transcriptStore(data).load(SESSION)).toEqual([entry]);
  });

  test("seeded or resumed by the real SDK still sends its images, and a notice once one has gone", async () => {
    const { root, data, cache } = await dirs();
    useImageCacheFor(data, cache);
    const mock = await startMockAnthropic({ fallback: { text: "seen" } });
    const provider = new ClaudeAgentProvider({
      bookPath: () => join(data, "sessions.json"),
      runQuery: (params) => query({ ...params, options: {
        ...params.options,
        env: { ...params.options.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude") },
      } }),
    });
    const image = await png();
    const user = (content: ContentBlock[]): WireMessage => ({ role: "user", content });
    const assistant = (text: string): WireMessage => ({ role: "assistant", content: [{ type: "text", text }] });
    const messages: WireMessage[] = [user([imageBlock(image), { type: "text", text: "what is this?" }]), assistant("a grey card"), user([{ type: "text", text: "and now?" }])];
    const carries = (blocks: ContentBlock[]) => blocks.some((block) => block.type === "image" && block.source.data === image);
    const turn = async () => {
      const request: SidecarRequest = {
        sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "test-key", base_url: mock.url,
        messages, max_tokens: 256, replay_prior_thinking: "all",
        context: { character: "ada", call_type: "message", thinking_enabled: false },
      };
      const events: StreamEvent[] = [];
      for await (const event of provider.stream(request, AbortSignal.timeout(25_000))) events.push(event);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      messages.push(assistant("seen"), user([{ type: "text", text: "again" }]));
      const sent = required(mock.requests.at(-1)).body.messages as WireMessage[];
      return sent.flatMap((message) => message.content);
    };
    try {
      expect(carries(await turn())).toBe(true);
      expect(transcriptText(data)).not.toMatch(INLINE_IMAGE);
      expect(carries(await turn())).toBe(true);
      rmSync(imageBlobDir(cache, "ada"), { recursive: true });
      const blocks = await turn();
      expect(carries(blocks)).toBe(false);
      expect(blocks).toContainEqual(notice(image));
    } finally {
      await mock.stop();
    }
  }, 90_000);
});

describe("a capture", () => {
  test("keeps a token where each image was, saying which image it was and how large", async () => {
    const image = await png();
    const store = CallStore.openInMemory();
    const body = JSON.stringify({ messages: [{ role: "user", content: [
      imageBlock(image),
      { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
      { type: "text", text: "what is this?" },
    ] }] });
    const id = store.recordCall({ call_id: "c1", ts: new Date("2026-10-01T09:00:00Z"), usage: ZERO_USAGE, request_body: body, response_body: body });
    const call = required(store.getCall(id));
    expect(call.request).toBe(body.replaceAll(image, tokenOf(image)));
    expect(call.response).toBe(call.request);
    store.recordHttpCall({
      call_id: "c1", seq: 0, ts: new Date("2026-10-01T09:00:00Z"), method: "POST", url: "https://api.anthropic.com/v1/messages",
      request_headers: [], request_body: Buffer.from(body), response_headers: [], response_body: null,
    });
    expect(store.httpCallsFor("c1")[0]?.request_body).toBe(call.request);
    store.close();
  });

  test("leaves base64 that is not an image as it was", () => {
    const wave = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), randomBytes(200)]).toString("base64");
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(200)]).toString("base64");
    const body = JSON.stringify({ audio: wave, document: pdf, short: "iVBORw0KGgo" });
    expect(withImageTokens(body)).toBe(body);
  });

  test("recorded with a token still matches the live request that carries the image", async () => {
    const image = await png();
    const live = JSON.stringify({ messages: [{ role: "user", content: [imageBlock(image)] }] });
    const player = new CassettePlayer({
      name: "image",
      exchanges: [{
        method: "POST", url: "https://api.anthropic.com/v1/messages", request_headers: [["content-type", "application/json"]],
        request_body: live.replaceAll(image, tokenOf(image)), status: 200, status_text: "OK", response_headers: [], response_body: '{"reply":"seen"}',
      }],
    });
    expect(player.match(snapshotOf("POST", "https://api.anthropic.com/v1/messages", [["content-type", "application/json"]], live)).response_body).toBe('{"reply":"seen"}');
  });
});

function toolTurn(image: string): Message[] {
  return [
    { msg_id: "a1", role: "assistant", content: "", images: [], timestamp: "2026-10-01T09:00:00.000Z",
      content_blocks: [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "card.png" } }],
      alt_index: 1, alt_count: 2,
      alternatives: [
        { content: "", images: [], timestamp: "2026-10-01T08:59:00.000Z", content_blocks: [{ type: "text", text: "an earlier try" }, imageBlock(image)] },
        { content: "", images: [], timestamp: "2026-10-01T09:00:00.000Z", content_blocks: [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "card.png" } }] },
      ] },
    { msg_id: "u1", role: "user", content: "", images: [], timestamp: "2026-10-01T09:00:01.000Z",
      content_blocks: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "card.png" }, imageBlock(image)] }] },
  ];
}

function historyText(data: string): string {
  return withStorage(data, (db) =>
    (db.query("SELECT compressed, data FROM history_blobs").all() as { compressed: number; data: Uint8Array }[])
      .map((row) => row.compressed === 1 ? zstdDecompressSync(row.data).toString() : Buffer.from(row.data).toString()).join("\n"));
}

const SEGMENT = { file: "history.db", message_count: 2, compacted_at: "2026-10-01T10:00:00Z" };

describe("archived history", () => {
  test("keeps a reference where a tool's image was, and shows the image when read", async () => {
    const { data, cache } = await dirs();
    useImageCacheFor(data, cache);
    const image = await png();
    const history = HistoryStore.open(databasePath(data));
    try {
      history.putSegment("ada", 0, SEGMENT, toolTurn(image));
      expect(historyText(data)).not.toMatch(INLINE_IMAGE);
      const blob = join(imageBlobDir(cache, "ada"), `${sha256Of(image)}.png`);
      const earlier = new Date(Date.now() - 3 * HOUR);
      utimesSync(blob, earlier, earlier);
      const read = history.readSegment("ada", 0);
      expect(read.map((message) => message.content_blocks)).toEqual(toolTurn(image).map((message) => message.content_blocks));
      expect(read[0]?.alternatives?.map((alternative) => alternative.content_blocks)).toEqual(toolTurn(image)[0]?.alternatives?.map((alternative) => alternative.content_blocks));
      expect(statSync(blob).mtimeMs).toBe(earlier.getTime());
    } finally {
      history.close();
    }
  });

  test("shows a notice once the image has left the cache", async () => {
    const { data, cache } = await dirs();
    useImageCacheFor(data, cache);
    const image = await png();
    const history = HistoryStore.open(databasePath(data));
    try {
      history.putSegment("ada", 0, SEGMENT, toolTurn(image));
      rmSync(imageBlobDir(cache, "ada"), { recursive: true });
      expect(history.readSegment("ada", 0)[1]?.content_blocks).toEqual([
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "card.png" }, notice(image)] },
      ]);
    } finally {
      history.close();
    }
  });
});

function legacyCapture(path: string, body: string): number {
  const db = new Database(path);
  try {
    const bytes = Buffer.from(body);
    const hash = createHash("sha256").update(bytes).digest();
    const chunk = hash.subarray(0, 16);
    db.query("INSERT OR IGNORE INTO capture_blobs (hash, size, compressed, data) VALUES (?1, ?2, 1, ?3)")
      .run(chunk.toString("hex"), bytes.byteLength, zstdCompressSync(bytes));
    db.query("INSERT INTO capture_payloads (sha256, size, stored, chunks, manifest) VALUES (?1, ?2, ?2, 1, ?3)")
      .run(hash.toString("hex"), bytes.byteLength, zstdCompressSync(chunk));
    const payload = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.query(`INSERT INTO capture_calls (call_id, ts, ts_unix, character, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, request_payload_id, response_payload_id)
      VALUES ('legacy', '2026-10-01T09:00:00+00:00', 1790845200, 'ada', 0, 0, 0, 0, ?1, ?1)`).run(payload);
    const call = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.query(`INSERT INTO capture_http_calls (call_id, seq, ts, ts_unix, character, method, url, request_payload_id, response_payload_id)
      VALUES ('legacy', 0, '2026-10-01T09:00:00+00:00', 1790845200, 'ada', 'POST', 'https://api.anthropic.com/v1/messages', ?1, ?1)`).run(payload);
    return call;
  } finally {
    db.close();
  }
}

function checkpointedSize(path: string): number {
  const db = new Database(path);
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
  return statSync(path).size;
}

describe("moving image data out of shore.db", () => {
  test("replaces the images in transcripts, captures and archived history once, and the file shrinks by about their size", async () => {
    const { data, cache } = await dirs();
    const path = databasePath(data);
    const images = await Promise.all(Array.from({ length: 4 }, () => noise()));
    const entries = images.flatMap((image, index) => Array.from({ length: 5 }, (_, copy) => entryWith([imageBlock(image), { type: "text", text: `copy ${String(copy)}` }], `u${String(index)}-${String(copy)}`)));
    await transcriptStore(data).append(SESSION, entries);
    const body = JSON.stringify({ messages: images.map((image) => ({ role: "user", content: [imageBlock(image)] })) });
    const call = legacyCapture(path, body);
    const history = HistoryStore.open(path);
    try {
      history.putSegment("ada", 0, SEGMENT, toolTurn(required(images[0])));
    } finally {
      history.close();
    }
    expect(transcriptText(data)).toMatch(INLINE_IMAGE);
    expect(historyText(data)).toMatch(INLINE_IMAGE);
    const before = checkpointedSize(path);
    const raw = images.reduce((total, image) => total + Buffer.from(image, "base64").byteLength, 0);

    useImageCacheFor(data, cache);
    expect(moveImagesOutOfDatabase(data, cache)).toEqual({ transcripts: 20, captures: 1, history: 2 });
    expect(statSync(`${path}-wal`).size).toBe(0);
    expect(transcriptText(data)).not.toMatch(INLINE_IMAGE);
    expect(historyText(data)).not.toMatch(INLINE_IMAGE);
    expect(await transcriptStore(data).load(SESSION)).toEqual(entries);
    const calls = CallStore.open(path);
    try {
      const tokened = images.reduce((text, image) => text.replaceAll(image, tokenOf(image)), body);
      expect(calls.getCall(call)).toMatchObject({ request: tokened, response: tokened });
      expect(calls.httpCallsFor("legacy")).toMatchObject([{ request_body: tokened, response_body: tokened }]);
    } finally {
      calls.close();
    }
    const reread = HistoryStore.open(path);
    try {
      const turn = toolTurn(required(images[0]));
      const read = reread.readSegment("ada", 0);
      expect(read[1]?.content_blocks).toEqual(turn[1]?.content_blocks);
      expect(read[0]?.alternatives?.[0]?.content_blocks).toEqual(turn[0]?.alternatives?.[0]?.content_blocks);
    } finally {
      reread.close();
    }
    const after = checkpointedSize(path);
    expect(before - after).toBeGreaterThan(raw * 5);
    expect(moveImagesOutOfDatabase(data, cache)).toBeUndefined();
  });

  test("gives the space back even when no capture carried an image", async () => {
    const { data, cache } = await dirs();
    const path = databasePath(data);
    const images = await Promise.all(Array.from({ length: 3 }, () => noise()));
    await transcriptStore(data).append(SESSION, images.map((image, index) => entryWith([imageBlock(image)], `u${String(index)}`)));
    const before = checkpointedSize(path);
    useImageCacheFor(data, cache);
    expect(moveImagesOutOfDatabase(data, cache)).toEqual({ transcripts: 3, captures: 0, history: 0 });
    const raw = images.reduce((total, image) => total + Buffer.from(image, "base64").byteLength, 0);
    expect(before - checkpointedSize(path)).toBeGreaterThan(raw * 0.9);
  });

  test("waits for a later start when the image cache cannot be written", async () => {
    const { root, data } = await dirs();
    const image = await png();
    await transcriptStore(data).append(SESSION, [entryWith([imageBlock(image)])]);
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(moveImagesOutOfDatabase(data, blocked)).toBeUndefined();
      const warnings = warn.mock.calls.map((call) => String(call[0]));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith(`shore: the image cache at ${blocked} cannot be written`);
    } finally {
      warn.mockRestore();
    }
    expect(transcriptText(data)).toContain(image);
    const cache = join(root, "cache");
    useImageCacheFor(data, cache);
    expect(moveImagesOutOfDatabase(data, cache)).toEqual({ transcripts: 1, captures: 0, history: 0 });
  });

  test.skipIf(process.getuid?.() === 0)("waits for a later start when the image cache directory is read-only", async () => {
    const { root, data } = await dirs();
    await transcriptStore(data).append(SESSION, [entryWith([imageBlock(await png())])]);
    const readOnly = join(root, "read-only");
    await mkdir(readOnly);
    chmodSync(readOnly, 0o500);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(moveImagesOutOfDatabase(data, readOnly)).toBeUndefined();
      expect(warn.mock.calls.map((call) => String(call[0]).startsWith(`shore: the image cache at ${readOnly} cannot be written`))).toEqual([true]);
    } finally {
      warn.mockRestore();
      chmodSync(readOnly, 0o700);
    }
  });

  test("reports a failure part-way, keeps what it moved, and finishes on a later start", async () => {
    const { data, cache } = await dirs();
    const image = await png();
    await transcriptStore(data).append(SESSION, [entryWith([imageBlock(image)])]);
    const history = HistoryStore.open(databasePath(data));
    try {
      history.putSegment("ada", 0, SEGMENT, toolTurn(image));
    } finally {
      history.close();
    }
    withStorage(data, (db) => db.run(`CREATE TRIGGER refuse_history BEFORE UPDATE ON history_messages
      BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`));
    useImageCacheFor(data, cache);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(moveImagesOutOfDatabase(data, cache)).toBeUndefined();
      const warnings = warn.mock.calls.map((call) => String(call[0]));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not finish moving image data out of");
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
    expect(transcriptText(data)).not.toMatch(INLINE_IMAGE);
    expect(historyText(data)).toMatch(INLINE_IMAGE);
    withStorage(data, (db) => db.run("DROP TRIGGER refuse_history"));
    expect(moveImagesOutOfDatabase(data, cache)).toEqual({ transcripts: 0, captures: 0, history: 2 });
    expect(historyText(data)).not.toMatch(INLINE_IMAGE);
  });

  test("leaves a row it cannot read as it was", async () => {
    const { data, cache } = await dirs();
    withStorage(data, (db) => {
      db.query("INSERT INTO history_blobs (hash, size, compressed, data) VALUES ('broken', 4096, 1, ?1)").run(randomBytes(64));
      db.query("INSERT INTO capture_payloads (sha256, size, stored, chunks, manifest) VALUES ('broken', 4096, 4096, 1, ?1)").run(randomBytes(64));
    });
    useImageCacheFor(data, cache);
    expect(moveImagesOutOfDatabase(data, cache)).toEqual({ transcripts: 0, captures: 0, history: 0 });
    expect(withStorage(data, (db) => db.query("SELECT size FROM history_blobs WHERE hash = 'broken'").get())).toEqual({ size: 4096 });
  });

  test("happens when the daemon starts, which also gives the data dir its image cache", async () => {
    const { root, data, cache } = await dirs();
    const image = await png();
    await transcriptStore(data).append(SESSION, [entryWith([imageBlock(image)])]);
    const app = defaultAppConfig();
    const config: LoadedConfig = {
      app, models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: join(root, "config"), data, cache, runtime: join(root, "run") },
    };
    const runtime = await createRuntime({ config, providers: {}, connectMcp: () => Promise.reject(new Error("no MCP server")) });
    try {
      expect(imageCacheFor(data)).toBe(cache);
      expect(transcriptText(data)).not.toMatch(INLINE_IMAGE);
      expect(existsSync(join(imageBlobDir(cache, "ada"), `${sha256Of(image)}.png`))).toBe(true);
    } finally {
      await runtime.autonomy.shutdown();
      await runtime.shutdown();
    }
  });
});

describe("a character archive", () => {
  test("carries the images its database refers to, and an import puts them in its own cache", async () => {
    const source = await dirs();
    useImageCacheFor(source.data, source.cache);
    const config = join(source.root, "config");
    await mkdir(join(config, "characters", "ada", "workspace"), { recursive: true });
    await writeFile(join(config, "characters", "ada", "workspace", "SOUL.md"), "ada");
    const image = await png();
    const history = HistoryStore.open(databasePath(source.data));
    try {
      history.putSegment("ada", 0, SEGMENT, toolTurn(image));
    } finally {
      history.close();
    }
    const context = (root: string, data: string, cache: string, present: boolean): ArchiveContext => ({
      dirs: { config: join(root, "config"), data, cache, runtime: join(root, "run") },
      hasCharacter: () => present, withSnapshot: async (run) => await run(),
      refreshDiscovery: async () => {}, releaseCharacter: async () => {},
    });
    const output = join(source.root, "ada.shore.tar.gz");
    await exportCharacter(context(source.root, source.data, source.cache, true), { character: "ada", output });
    const unpacked = join(source.root, "unpacked");
    await mkdir(unpacked);
    await extract({ file: output, cwd: unpacked });
    expect(readdirSync(join(unpacked, "media", "blobs"))).toEqual([`${sha256Of(image)}.png`]);

    const target = await dirs();
    useImageCacheFor(target.data, target.cache);
    await importCharacter(context(target.root, target.data, target.cache, false), { archive: output });
    expect(existsSync(join(target.data, "media", "ada", "blobs"))).toBe(false);
    const imported = HistoryStore.open(databasePath(target.data));
    try {
      expect(imported.readSegment("ada", 0)[1]?.content_blocks).toEqual(toolTurn(image)[1]?.content_blocks);
    } finally {
      imported.close();
    }
  });
});
