import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { characterDataDir } from "../src/config/dirs.ts";
import { findEffectiveModel } from "../src/config/effective_catalog.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { configView } from "../src/config/preferences.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { mergeToolLoopMessages } from "../src/engine/merge.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import { assemblePrompt, formatWallClock, type PromptParams } from "../src/engine/prompt.ts";
import type { History } from "../src/protocol/History.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { readDurable } from "../src/storage/files.ts";
import { NO_PRIOR_CONTEXT } from "../src/engine/segments.ts";
import type { ContentBlock, ImageRef, Message, MessageNote } from "../src/engine/types.ts";
import { withAttemptNoted } from "../src/handler/attempts.ts";
import { buildChatShapeRequestFromDisk } from "../src/handler/context.ts";
import { buildGenerationRequest } from "../src/handler/setup.ts";
import { hostZone } from "../src/ledger/zoned.ts";
import { buildLlmMessages, inReadingOrder, type SentMessage } from "../src/handler/wire_messages.ts";
import type { WireMessage } from "../src/llm/types.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";
import { noisePng } from "./support/test_images.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";
import { Texts } from "../src/texts/texts.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12);
const at = (minutes: number): string => new Date(T0 + minutes * MINUTE).toISOString();
const NOT_SENT = "[These pictures in your last message were not sent, so only their names were shown:\n- ![[gone]]: no picture matches\nSend a picture again in a new message if you meant to show it.]";
const GONE: ImageRef = { path: "", embed: "![[gone]]", problem: "no picture matches" };

function said(id: string, role: Message["role"], words: string | ContentBlock[], minutes: number, extra: Partial<Message> = {}): Message {
  const blocks: ContentBlock[] = typeof words === "string" ? [{ type: "text", text: words }] : words;
  return {
    msg_id: id,
    role,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    images: [],
    content_blocks: blocks,
    timestamp: at(minutes),
    ...extra,
  };
}

async function request(messages: Message[], over: Partial<PromptParams> = {}): Promise<{ wire: WireMessage[]; sent: SentMessage[] }> {
  const prompt = assemblePrompt({ character_name: "ada", display_name: "eve", has_prior_context: false, user_timestamp_mode: "auto", sections: [], messages, texts: new Texts(), ...over }, "UTC");
  const { messages: wire, sent } = await buildLlmMessages(prompt, new Texts());
  return { wire, sent };
}

const texts = (message: WireMessage | undefined): string[] => (message?.content ?? []).map((block) => block.type === "text" ? block.text : `<${block.type}>`);
const start = (text: string): MessageNote => ({ place: "start", text });

test("each note Shore puts at the start of a user's message is recorded word for word, in the order the model reads them, and nothing for messages it adds nothing to", async () => {
  const running = '[A wake of yours in "ring" has been running since Friday 2026-10-30 · 1:55 PM. It can\'t see this conversation. It is only told that a message arrived.]';
  const status = '[Their status: "tired" for 30 minutes]';
  const later = "[2 hours later · Friday 2026-10-30 · 2:00 PM]";
  const { wire, sent } = await request([
    said("u1", "user", "hello", 0),
    said("a1", "assistant", "Here: ![[gone]]", 1, { images: [GONE] }),
    said("u2", "user", "back", 120, {
      wake_running: { started_at: at(115), thread: "ring" },
      presence: { statuses: [{ status: "tired", set_at: at(90) }], changed_at: at(90) },
    }),
  ]);

  expect(texts(wire[2])).toEqual([running, status, `${later}\n\n${NOT_SENT}`, "back"]);
  expect(sent).toEqual([
    { msg_id: "u1", notes: [] },
    { msg_id: "a1", notes: [] },
    { msg_id: "u2", notes: [start(running), start(status), start(later), start(NOT_SENT)] },
  ]);
});

test("a time line is recorded on the message it went into, which is the next with words of its own when a tool's result or a picture sent alone came first", async () => {
  const call: ContentBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
  const result: ContentBlock = { type: "tool_result", tool_use_id: "t1", content: "done" };
  const omitted = "[image omitted: cat.png — no longer cached]";
  const { wire, sent } = await request([
    said("u1", "user", "hello", 0),
    said("a1", "assistant", [{ type: "text", text: "Let me look." }, call], 1),
    said("r1", "user", [result], 61),
    said("u2", "user", [], 61, { images: [{ path: "/nowhere/cat.png" }] }),
    said("u3", "user", "thanks", 62),
  ], { has_prior_context: true });

  expect(wire.map(texts)).toEqual([
    ["[Friday 2026-10-30 · 12:00 PM]\n\nhello"],
    ["Let me look.", "<tool_use>"],
    ["<tool_result>"],
    [omitted],
    ["[Friday 2026-10-30 · 1:02 PM]\n\nthanks"],
  ]);
  expect(sent).toEqual([
    { msg_id: "u1", notes: [start("[Friday 2026-10-30 · 12:00 PM]")] },
    { msg_id: "a1", notes: [] },
    { msg_id: "r1", notes: [] },
    { msg_id: "u2", notes: [start(omitted)] },
    { msg_id: "u3", notes: [start("[Friday 2026-10-30 · 1:02 PM]")] },
  ]);
});

test("a turn Shore adds is recorded on the message that comes after it, and after the last message sent when nothing sent follows it", async () => {
  const opened = await request([said("a1", "assistant", "Part one.", 0), said("u1", "user", "go on", 1)]);
  expect(texts(opened.wire[0])).toEqual(["[this conversation starts with your message]"]);
  expect(opened.sent).toEqual([
    { msg_id: "a1", notes: [{ place: "before", text: "[this conversation starts with your message]" }] },
    { msg_id: "u1", notes: [] },
  ]);

  const earlier = await request([said("a1", "assistant", "Part one.", 0)], { has_prior_context: true });
  expect(earlier.sent).toEqual([{ msg_id: "a1", notes: [{ place: "before", text: "[earlier conversation not shown]" }] }]);

  const woke = await request([
    said("u1", "user", "hello", 0),
    said("a1", "assistant", "Here: ![[gone]]", 1, { images: [GONE] }),
    said("w1", "assistant", "And another thing.", 2, { origin: "autonomous" }),
    said("w2", "assistant", [], 3, { origin: "autonomous" }),
  ], { user_timestamp_mode: "always" });
  expect(texts(woke.wire[2])).toEqual([NOT_SENT, "[wake · Friday 2026-10-30 · 12:02 PM]"]);
  expect(texts(woke.wire.at(-1))).toEqual(["[wake · Friday 2026-10-30 · 12:03 PM]"]);
  expect(woke.sent.map(({ msg_id }) => msg_id)).toEqual(["u1", "a1", "w1"]);
  expect(woke.sent[2]?.notes).toEqual([
    { place: "before", text: NOT_SENT },
    { place: "before", text: "[wake · Friday 2026-10-30 · 12:02 PM]" },
    { place: "after", text: "[wake · Friday 2026-10-30 · 12:03 PM]" },
  ]);
});

test("a picture's name is recorded ahead of the other notes, a missing one says so, and a character's picture sent as words is recorded after its message", async () => {
  const root = testTmp(`message-notes-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const kept = join(root, "cat.png");
  await writeFile(kept, await noisePng(8, 8));
  const missing = join(root, "dog.png");
  const messages = [
    said("u1", "user", "look", 0, { images: [{ path: kept }, { path: missing }], presence: { statuses: [], changed_at: at(-5) } }),
    said("a1", "assistant", "Here is mine.", 1, { images: [{ path: kept, caption: "a cat" }, { path: missing }] }),
  ];
  const cleared = "[Their status was cleared 5 minutes ago.]";

  const words = await request(messages);
  expect(texts(words.wire[0])).toEqual([`[picture: ${kept}]`, "<image>", "[image omitted: dog.png — no longer cached]", cleared, "look"]);
  expect(texts(words.wire[1])).toEqual(["Here is mine.", "[sent an image: a cat]", "[sent an image]"]);
  expect(words.sent).toEqual([
    { msg_id: "u1", notes: [start(`[picture: ${kept}]`), start("[image omitted: dog.png — no longer cached]"), start(cleared)] },
    { msg_id: "a1", notes: [{ place: "end", text: "[sent an image: a cat]" }, { place: "end", text: "[sent an image]" }] },
  ]);
});

test("notes are put in the order the model reads them, keeping the order of notes in the same place", () => {
  const notes: MessageNote[] = [
    { place: "after", text: "f" },
    { place: "end", text: "e" },
    { place: "instead", text: "d" },
    { place: "start", text: "b" },
    { place: "before", text: "a" },
    { place: "start", text: "c" },
  ];
  expect(inReadingOrder(notes).map(({ text }) => text)).toEqual(["a", "b", "c", "d", "e", "f"]);
});

test("the note asking for a reply again is recorded after the last message sent, and nowhere when there is none", () => {
  const sent: SentMessage[] = [{ msg_id: "u1", notes: [] }, { msg_id: "u2", notes: [start("[noon]")] }];
  expect(withAttemptNoted(sent, "Write it again.")).toEqual([
    { msg_id: "u1", notes: [] },
    { msg_id: "u2", notes: [start("[noon]"), { place: "after", text: "Write it again." }] },
  ]);
  expect(withAttemptNoted(sent, undefined)).toEqual(sent);
  expect(withAttemptNoted([], "Write it again.")).toEqual([]);
  expect(sent[1]?.notes).toEqual([start("[noon]")]);
});

async function fixture(timestamps: "never" | "always"): Promise<{ config: LoadedConfig; resolved: ResolvedModel }> {
  const root = await mkdtemp(testTmp("shore-notes-"));
  const app = promptedAppConfig();
  app.chat.model = "fixture";
  app.chat.user_timestamps = timestamps;
  app.chat.display_name = "eve";
  app.tools.enabled = [];
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: "SHORE_NOTES_TEST_KEY", maxContextTokens: 200_000, maxOutputTokens: 4096,
  } as unknown as ResolvedModel);
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  return { config, resolved: findEffectiveModel(configView(config), config.dirs.cache, "fixture", true) };
}

async function diskRequest(messages: Message[], timestamps: "never" | "always" = "never"): Promise<{ wire: WireMessage[]; sent: SentMessage[] }> {
  const { config, resolved } = await fixture(timestamps);
  const built = await buildChatShapeRequestFromDisk("ada", characterDataDir(config.dirs.data, "ada"), config, resolved, messages, NO_PRIOR_CONTEXT, {
    env: { SHORE_NOTES_TEST_KEY: "key" },
  });
  return { wire: built.request.messages, sent: built.sent };
}

test("a reply's request is put together in the time zone it is given, or the host's, and says what it put with each message", async () => {
  const { config, resolved } = await fixture("always");
  const messages = [said("u1", "user", "hello", 0)];
  const engine = { thread: "main", messages: () => messages, messagesThroughLastUserTurn: () => messages, priorContext: () => NO_PRIOR_CONTEXT };
  const built = async (timeZone?: string) => await buildGenerationRequest({
    engine, dataDir: config.dirs.data, charName: "ada", config, resolved, regen: false,
    mcpRegistry: { toolDefsFiltered: () => [] }, ...(timeZone === undefined ? {} : { timeZone }),
  });
  const there = "[Saturday 2026-10-31 · 2:00 AM]";
  const kiritimati = await built("Pacific/Kiritimati");
  expect(texts(kiritimati.request.messages[0])).toEqual([`${there}\n\nhello`]);
  expect(kiritimati.sent).toEqual([{ msg_id: "u1", notes: [start(there)] }]);
  const host = `[${formatWallClock(T0, hostZone())}]`;
  expect((await built()).sent).toEqual([{ msg_id: "u1", notes: [start(host)] }]);
});

test("where the model reads other words in place of a message, the words it reads are recorded on it", async () => {
  const call: ContentBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
  const result: ContentBlock = { type: "tool_result", tool_use_id: "t1", content: "done" };
  const later = "[wake]\n\n[Your trigger \"ring\" fired at noon: look around]";
  const standIn = "[Your working in this wake isn't shown here: 1 tool call.]";
  const { wire, sent } = await diskRequest([
    said("u1", "user", "hello", 0),
    said("a1", "assistant", "hi", 1),
    said("o1", "user", "[wake]\n\n[Your trigger \"ring\" fired at noon: look around]\n\nThe whole of wake.md.", 2, { origin: "autonomous", shown_later: later }),
    said("w1", "assistant", [call], 3),
    said("w2", "user", [result], 4),
    said("w3", "assistant", "Done looking.", 5),
    said("u2", "user", "morning", 6),
  ]);

  expect(wire.map(texts)).toEqual([["hello"], ["hi"], [later], [standIn], ["morning"]]);
  expect(sent).toEqual([
    { msg_id: "u1", notes: [] },
    { msg_id: "a1", notes: [] },
    { msg_id: "o1", notes: [{ place: "instead", text: later }] },
    { msg_id: "w3", notes: [{ place: "instead", text: standIn }] },
    { msg_id: "u2", notes: [] },
  ]);
});

const notedHello = [start("[noon]")];

async function engineWith(messages: Message[]): Promise<{ engine: ConversationEngine; histories: History[]; data: string }> {
  const data = await mkdtemp(testTmp("shore-notes-engine-"));
  const histories: History[] = [];
  const engine = await ConversationEngine.load("ada", data, (history) => histories.push(history));
  for (const message of messages) await engine.appendMessage(message);
  histories.length = 0;
  return { engine, histories, data };
}

test("saved notes stay with their message across a reload, without counting as an edit, and saving the same notes again writes nothing", async () => {
  const { engine, data } = await engineWith([said("u1", "user", "hello", 0), said("a1", "assistant", "hi", 1), said("u2", "user", "again", 2)]);
  const path = join(data, "ada", "threads", "main", "active.jsonl");
  const versions = engine.messages().map((message) => message.version);
  const store = await MessageStore.load(path);

  expect(await store.setNotes([{ msg_id: "u2", notes: [start("[later]")] }, { msg_id: "u1", notes: notedHello }, { msg_id: "gone", notes: notedHello }])).toBe(0);
  const written = readDurable(path);
  expect(await store.setNotes([{ msg_id: "u1", notes: notedHello }, { msg_id: "a1", notes: [] }])).toBeUndefined();
  expect(readDurable(path)).toBe(written);

  const reloaded = (await MessageStore.load(path)).messages();
  expect(reloaded.map((message) => message.notes)).toEqual([notedHello, undefined, [start("[later]")]]);
  expect(reloaded.map((message) => message.version)).toEqual(versions);

  expect(await store.setNotes([{ msg_id: "u2", notes: [] }])).toBe(2);
  expect((await MessageStore.load(path)).messages().map((message) => "notes" in message)).toEqual([true, false, false]);
});

test("saving notes sends clients the conversation again from the turn of the first message whose notes changed, and nothing when none did", async () => {
  const call: ContentBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
  const result: ContentBlock = { type: "tool_result", tool_use_id: "t1", content: "done" };
  const { engine, histories } = await engineWith([
    said("u1", "user", "hello", 0),
    said("a1", "assistant", [call], 1),
    said("r1", "user", [result], 2),
    said("a2", "assistant", "Found it.", 3),
    said("u2", "user", "thanks", 4),
  ]);
  const revision = engine.currentRevision();

  await engine.saveNotes([{ msg_id: "u2", notes: notedHello }]);
  expect(histories.map(({ delta, messages }) => [delta, messages.map((message) => [message.msg_id, message.notes])])).toEqual([
    [{ base_revision: revision, after: "a2" }, [["u2", notedHello]]],
  ]);

  await engine.saveNotes([{ msg_id: "r1", notes: [{ place: "instead", text: "[stand-in]" }] }, { msg_id: "u2", notes: notedHello }]);
  expect(histories[1]?.delta).toEqual({ base_revision: revision + 1, after: "u1" });
  expect(histories[1]?.messages.map((message) => [message.msg_id, message.notes])).toEqual([
    ["a2", [{ place: "instead", text: "[stand-in]" }]],
    ["u2", notedHello],
  ]);

  await engine.saveNotes([{ msg_id: "u1", notes: [start("[first]")] }]);
  expect(histories[2]?.delta).toEqual({ base_revision: revision + 2, after: null });
  expect(histories[2]?.messages.map((message) => message.msg_id)).toEqual(["u1", "a2", "u2"]);

  await engine.saveNotes([{ msg_id: "u1", notes: [start("[first]")] }]);
  expect(histories).toHaveLength(3);
  expect(engine.currentRevision()).toBe(revision + 3);
  expect(engine.historySnapshot({}).messages.map((message) => message.notes)).toEqual([[start("[first]")], [{ place: "instead", text: "[stand-in]" }], notedHello]);
});

test("a tool loop shown as one message carries the notes of every message in it, in order", () => {
  const call: ContentBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
  const result: ContentBlock = { type: "tool_result", tool_use_id: "t1", content: "done" };
  const merged = mergeToolLoopMessages([
    said("a1", "assistant", [call], 1, { notes: [{ place: "before", text: "[wake]" }] }),
    said("r1", "user", [result], 2),
    said("a2", "assistant", "Found it.", 3, { notes: [{ place: "end", text: "[sent an image]" }] }),
  ]);
  expect(merged.map((message) => [message.msg_id, message.notes])).toEqual([["a2", [{ place: "before", text: "[wake]" }, { place: "end", text: "[sent an image]" }]]]);
  expect("notes" in required(mergeToolLoopMessages([said("a1", "assistant", [call], 1), said("r1", "user", [result], 2)])[0])).toBe(false);
});

test("notes are kept when their conversation is archived, and an archive made before notes existed takes them from then on", async () => {
  const { engine, data } = await engineWith([said("u1", "user", "hello", 0), said("a1", "assistant", "hi", 1)]);
  await engine.saveNotes([{ msg_id: "u1", notes: notedHello }]);
  const threadDir = join(data, "ada", "threads", "main");
  await archiveAndRetain(threadDir, { dbPath: join(data, HISTORY_DB_FILE), archiveKey: "ada" }, 0, readDurable(join(threadDir, "active.jsonl")));
  await engine.reload();

  expect((await engine.segments().readSegment(0)).map((message) => message.notes)).toEqual([notedHello, undefined]);
  expect(engine.displayHistoryPage(0, undefined, { kind: "count", value: 10 })?.messages.map((message) => message.notes)).toEqual([notedHello, undefined]);

  const old = join(await mkdtemp(testTmp("shore-notes-old-")), HISTORY_DB_FILE);
  const db = new Database(old);
  db.run(`CREATE TABLE history_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, character TEXT NOT NULL, segment INTEGER NOT NULL, ordinal INTEGER NOT NULL,
    msg_id TEXT NOT NULL, role TEXT NOT NULL, timestamp TEXT NOT NULL, provider_key TEXT, model TEXT, origin TEXT,
    alt_index INTEGER, alt_count INTEGER, images TEXT, blocks_hash TEXT NOT NULL, display_kind INTEGER NOT NULL,
    display_seq INTEGER, is_user_turn INTEGER NOT NULL, version TEXT, attempt TEXT)`);
  db.close();
  const store = HistoryStore.open(old);
  store.putSegment("ada", 0, { file: HISTORY_DB_FILE, compacted_at: at(5) }, [said("u1", "user", "hello", 0, { notes: notedHello })]);
  expect(store.readSegment("ada", 0).map((message) => message.notes)).toEqual([notedHello]);
  store.close();
});

test("notes saved from a request leave the next request as it was", async () => {
  const { engine } = await engineWith([
    said("u1", "user", "hello", 0, { presence: { statuses: [{ status: "tired", set_at: at(-30) }], changed_at: at(-30) } }),
    said("a1", "assistant", "Here: ![[gone]]", 1, { images: [GONE] }),
    said("u2", "user", "back", 120),
  ]);
  const first = await diskRequest([...engine.messages()], "always");
  await engine.saveNotes(first.sent);
  expect(engine.messages().map((message) => message.notes?.length ?? 0)).toEqual([2, 0, 2]);

  const second = await diskRequest([...engine.messages()], "always");
  expect(JSON.stringify(second.wire)).toBe(JSON.stringify(first.wire));
  expect(second.sent).toEqual(first.sent);
});

test("an archived message keeps what it was written with: its model and key, its version, its notes, a single other attempt, and a count of attempts it holds none of", async () => {
  const { engine, data } = await engineWith([said("u1", "user", "hello", 0)]);
  const reply = said("a1", "assistant", "hi", 1, {
    provider_key: "anthropic", model: "claude-lamp",
    alternatives: [{ content: "hi", images: [], content_blocks: [{ type: "text", text: "hi" }], timestamp: at(1) }],
    alt_index: 0, alt_count: 1,
  });
  await engine.appendMessage(reply);
  await engine.appendMessage(said("a2", "assistant", "more", 2, { alt_index: 1, alt_count: 2 }));
  await engine.saveNotes([{ msg_id: "a1", notes: [{ place: "end", text: "[sent an image]" }] }]);
  const stored = required(engine.messages()[1]);
  const threadDir = join(data, "ada", "threads", "main");
  await archiveAndRetain(threadDir, { dbPath: join(data, HISTORY_DB_FILE), archiveKey: "ada" }, 0, readDurable(join(threadDir, "active.jsonl")));
  await engine.reload();

  const archived = required((await engine.segments().readSegment(0))[1]);
  expect(archived).toMatchObject({ provider_key: "anthropic", model: "claude-lamp", alt_index: 0, alt_count: 1, notes: [{ place: "end", text: "[sent an image]" }] });
  expect(archived.version).toBe(required(stored.version));
  expect(archived.alternatives?.map((alternative) => alternative.content)).toEqual(["hi"]);
  expect((await engine.segments().readSegment(0))[2]).toMatchObject({ msg_id: "a2", alt_index: 1, alt_count: 2 });
});

test("an archived page says how much it read to show itself, and a page with nothing in it reads nothing", async () => {
  const { engine, data } = await engineWith([said("u1", "user", "hello", 0), said("a1", "assistant", "hi", 1)]);
  const threadDir = join(data, "ada", "threads", "main");
  await archiveAndRetain(threadDir, { dbPath: join(data, HISTORY_DB_FILE), archiveKey: "ada" }, 0, readDurable(join(threadDir, "active.jsonl")));
  await engine.reload();

  const body = (text: string): number => Buffer.byteLength(JSON.stringify([{ type: "text", text }]));
  const page = required(engine.displayHistoryPage(0, undefined, { kind: "count", value: 10 }));
  expect(page.messages.map((message) => message.msg_id)).toEqual(["u1", "a1"]);
  expect(page.metrics).toMatchObject({ segments_read: 1, rows_read: 2, decoded_body_bytes: body("hello") + body("hi") });
  const empty = required(engine.displayHistoryPage(0, 0, { kind: "count", value: 10 }));
  expect([empty.messages, empty.metrics]).toEqual([[], { segments_read: 0, rows_read: 0, decoded_body_bytes: 0, page_bytes: 2 }]);
});

test("a new history file reclaims space as it goes and lets readers in while it writes", async () => {
  const path = join(await mkdtemp(testTmp("shore-notes-pragma-")), HISTORY_DB_FILE);
  HistoryStore.open(path).close();
  const db = new Database(path);
  expect(db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  db.close();
});
