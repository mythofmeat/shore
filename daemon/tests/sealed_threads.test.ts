import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { addDiaryNote, keptDiary, recentDiary, unfoldedDiary, unseenDiary } from "../src/autonomy/diary.ts";
import { triggerFiredNote } from "../src/autonomy/heartbeat_shape.ts";
import { firedBy } from "../src/autonomy/runner.ts";
import { sealedListNote, sealedWakeNote } from "../src/autonomy/sealed_notes.ts";
import { CallStore } from "../src/call_store.ts";
import { threadDataDir } from "../src/config/dirs.ts";
import { openDueSeals, sealThread } from "../src/engine/sealed.ts";
import { keepSealedThreads, sealedIn, sealedThreads } from "../src/engine/sealed_list.ts";
import { createThread, readThreadsIndex, ThreadError, threadReadMark } from "../src/engine/threads.ts";
import { withCallCapture } from "../src/llm/capture.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { writeCharacterState } from "../src/storage/store.ts";
import { handleListThreads } from "../src/tools/list_threads.ts";
import { handleStartSealedThread, sealedThreadRequest } from "../src/tools/start_sealed_thread.ts";
import { testTmp } from "./support/tmp.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 12);

async function world(): Promise<{ data: string; characterDir: string }> {
  const data = join(await mkdtemp(testTmp("shore-sealed-")), "data");
  await createThread(data, "ada", "ring", new Date(T0).toISOString());
  return { data, characterDir: join(data, "ada") };
}

async function refusal(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    return `${error instanceof ThreadError ? `${error.kind}: ` : ""}${error instanceof Error ? error.message : String(error)}`;
  }
  return "";
}

test("sealing a thread keeps it in a list of its own, with a place for its messages and everything in it unread from the start", async () => {
  const { data, characterDir } = await world();
  const gift = await sealThread(data, "ada", { id: "gift", label: "  Something for you ", unsealAt: T0 + 1 }, T0);
  expect(gift).toEqual({ id: "gift", label: "Something for you", unseal_at: new Date(T0 + 1).toISOString(), created_at: new Date(T0).toISOString() });
  await sealThread(data, "ada", { id: "later", label: "Later", unsealAt: T0 + 2 * HOUR }, T0 + 5);
  expect(sealedThreads(characterDir).map((sealed) => [sealed.id, sealed.unseal_at])).toEqual([
    ["gift", new Date(T0 + 1).toISOString()], ["later", new Date(T0 + 2 * HOUR).toISOString()],
  ]);
  expect(sealedIn(characterDir, "later")?.label).toBe("Later");
  expect(sealedIn(characterDir, "ring")).toBeUndefined();
  expect((await readThreadsIndex(data, "ada"))?.threads.map((record) => record.id)).toEqual(["main", "ring"]);
  expect(existsSync(threadDataDir(data, "ada", "gift"))).toBe(true);
  expect([threadReadMark(data, "ada", "gift"), threadReadMark(data, "ada", "later")]).toEqual([T0 - 1, T0 + 4]);
});

test("a thread can't be sealed under a name that is taken or unusable, without a label, or to open at a time already here", async () => {
  const { data, characterDir } = await world();
  await sealThread(data, "ada", { id: "gift", label: "A", unsealAt: T0 + HOUR }, T0);
  const seal = async (id: string, label: string, unsealAt: number): Promise<string> => await refusal(sealThread(data, "ada", { id, label, unsealAt }, T0));
  expect(await seal("the gift", "A", T0 + HOUR)).toStartWith('invalid_id: invalid thread id "the gift"');
  expect(await seal("box", "  ", T0 + HOUR)).toBe("invalid_seal: a sealed thread needs a label, which is all your other threads see of it");
  expect(await seal("box", "A", T0)).toBe("invalid_seal: a sealed thread has to open at a time that is still to come");
  expect(await seal("box", "A", Number.NaN)).toBe("invalid_seal: a sealed thread has to open at a time that is still to come");
  expect(await seal("ring", "A", T0 + HOUR)).toBe('exists: thread "ring" already exists for ada');
  expect(await seal("gift", "A", T0 + HOUR)).toBe('exists: thread "gift" already exists for ada');
  expect(sealedThreads(characterDir).map((sealed) => sealed.id)).toEqual(["gift"]);
  expect(existsSync(threadDataDir(data, "ada", "box"))).toBe(false);

  await mkdir(threadDataDir(data, "ada", "box"), { recursive: true });
  expect((await sealThread(data, "ada", { id: "box", label: "A", unsealAt: T0 + HOUR }, T0)).id).toBe("box");
});

test("a seal comes off at its time and not before, and the thread joins the list once however often that is tried", async () => {
  const { data, characterDir } = await world();
  await sealThread(data, "ada", { id: "gift", label: "Something for you", unsealAt: T0 + HOUR }, T0);
  await sealThread(data, "ada", { id: "later", label: "Later", unsealAt: T0 + 2 * HOUR }, T0);
  expect(await openDueSeals(data, "ada", T0 + HOUR - 1)).toEqual({ opened: [], index: undefined });
  expect(sealedThreads(characterDir)).toHaveLength(2);

  const first = await openDueSeals(data, "ada", T0 + HOUR);
  expect(first.opened.map((sealed) => sealed.id)).toEqual(["gift"]);
  expect(first.index?.threads.at(-1)).toEqual({ id: "gift", label: "Something for you", created_at: new Date(T0).toISOString(), created_by: "character", compaction: true });
  expect(sealedThreads(characterDir).map((sealed) => sealed.id)).toEqual(["later"]);

  keepSealedThreads(characterDir, [...first.opened, ...sealedThreads(characterDir)]);
  const again = await openDueSeals(data, "ada", T0 + 3 * HOUR);
  expect(again.opened.map((sealed) => sealed.id)).toEqual(["gift", "later"]);
  expect(again.index?.threads.map((record) => record.id)).toEqual(["main", "ring", "gift", "later"]);
  expect(sealedThreads(characterDir)).toEqual([]);
});

test("a damaged list of sealed threads is read as far as it makes sense", async () => {
  const { characterDir } = await world();
  const read = (content: string): string[] => {
    writeCharacterState(characterDir, "sealed.json", content);
    return sealedThreads(characterDir).map((sealed) => sealed.id);
  };
  const good = { id: "gift", label: "A", unseal_at: "2026-10-31T08:00:00.000Z", created_at: "2026-10-30T12:00:00.000Z" };
  expect(read("not json")).toEqual([]);
  expect(read(JSON.stringify({ gift: good }))).toEqual([]);
  expect(read(JSON.stringify([
    good, null, "gift", { ...good, id: 5 }, { ...good, id: "nolabel", label: undefined }, { ...good, id: "undated", unseal_at: "soon" },
    { ...good, id: "nodate", unseal_at: 5 }, { ...good, id: "unmade", created_at: 5 }, { ...good, id: "second" },
  ]))).toEqual(["gift", "second"]);
});

test("the character's other turns are told of a sealed thread only its name, its label and when it opens", () => {
  const gift = { id: "gift", label: "Something for you", unseal_at: "2026-10-31T08:00:00.000Z", created_at: "2026-10-30T12:00:00.000Z" };
  const later = { id: "later", label: "Later", unseal_at: "2026-12-24T18:30:00.000Z", created_at: "2026-10-30T12:00:00.000Z" };
  expect(sealedListNote([], "UTC")).toBeUndefined();
  expect(sealedListNote([gift, later], "UTC")).toBe(
    "[Your sealed threads. Only a wake inside one can see what is in it, and `wake_in_thread` takes you there.\n" +
    '- `gift` "Something for you", opens Saturday 2026-10-31 · 8:00 AM\n- `later` "Later", opens Thursday 2026-12-24 · 6:30 PM]',
  );
  expect(sealedWakeNote(gift, "/home/ada/sealed/gift", "eve", "UTC")).toBe(
    '[This thread is sealed until Saturday 2026-10-31 · 8:00 AM. eve can\'t see it, or anything you do or send here, until then, and your other threads are shown only its label, "Something for you". ' +
    "What you send here waits in the thread for them. Keep what you make for it in /home/ada/sealed/gift, which is outside your workspace.]",
  );
  const opened = { name: "", reason: "eve can see it now.", at: T0, thread: "gift", seal: true };
  expect(triggerFiredNote(opened, "UTC")).toBe("[The seal on this thread came off at Friday 2026-10-30 · 12:00 PM. eve can see it now.]");
  expect(firedBy([opened])).toBe("its seal coming off");
  expect(firedBy([{ name: "show", reason: "r", at: T0, thread: "gift" }, { name: "", reason: "r", at: T0, thread: "gift", from: "main" }, opened])).toBe(
    'trigger "show" and a hand-off from "main" and its seal coming off',
  );
});

test("the tool that seals a thread needs a name, a label and a local time to open at, and says where its files go", async () => {
  expect(sealedThreadRequest({ name: " gift ", label: " Something for you ", opens: " 2026-12-24 08:00 " }, "UTC")).toEqual({ id: "gift", label: "Something for you", unsealAt: Date.UTC(2026, 11, 24, 8) });
  expect(sealedThreadRequest({ name: "gift", label: "A", opens: "2026-12-24T08:00" }, "America/New_York").unsealAt).toBe(Date.UTC(2026, 11, 24, 13));
  const wrong = async (input: Record<string, unknown>): Promise<string> => await refusal(() => sealedThreadRequest(input, "UTC"));
  const name = "name must be letters, digits, dot, dash or underscore, starting with a letter or digit, at most 64 characters";
  expect(await wrong({ label: "A", opens: "2026-12-24 08:00" })).toContain(name);
  expect(await wrong({ name: 5, label: "A", opens: "2026-12-24 08:00" })).toContain(name);
  expect(await wrong({ name: "the gift", label: "A", opens: "2026-12-24 08:00" })).toContain(name);
  expect(await wrong({ name: "gift", opens: "2026-12-24 08:00" })).toContain("label is required");
  expect(await wrong({ name: "gift", label: 5, opens: "2026-12-24 08:00" })).toContain("label is required");
  expect(await wrong({ name: "gift", label: " ", opens: "2026-12-24 08:00" })).toContain("label is required");
  const opens = 'opens must be a local date and 24-hour time, like "2026-12-24 08:00"';
  for (const value of [undefined, 5, "tomorrow", "2026-02-30 08:00", "2026-12-24 8:00", "2026-12-24 25:00"]) {
    expect(await wrong({ name: "gift", label: "A", opens: value })).toContain(opens);
  }

  const asked: unknown[] = [];
  const input = { name: "gift", label: "Something for you", opens: "2026-12-24 08:00" };
  expect(await handleStartSealedThread(input, async (wanted) => {
    asked.push(wanted);
    return { unsealAt: new Date(wanted.unsealAt).toISOString(), filesDir: "/home/ada/sealed/gift" };
  }, "eve", "UTC")).toBe(
    'Sealed the thread "gift" (Something for you) until Thursday 2026-12-24 · 8:00 AM. eve can\'t see it until then, and your other turns are shown only its label and that time. ' +
    "`wake_in_thread` takes you into it. Keep what you make for it in /home/ada/sealed/gift, which is outside your workspace.",
  );
  expect(asked).toEqual([{ id: "gift", label: "Something for you", unsealAt: Date.UTC(2026, 11, 24, 8) }]);
  expect(await refusal(handleStartSealedThread(input, undefined, "eve", "UTC"))).toContain("sealed threads can't be started from here");
  expect(await refusal(handleStartSealedThread(input, async () => { throw new ThreadError("exists", "thread \"gift\" already exists for ada"); }, "eve", "UTC"))).toBe('io: thread "gift" already exists for ada');
  expect(await refusal(handleStartSealedThread(input, async () => { throw new Error("the disk is full"); }, "eve", "UTC"))).toBe("the disk is full");
});

test("diary entries written in a sealed thread are shown nowhere until its seal comes off, and an entry about a thread isn't repeated inside it", async () => {
  const { data, characterDir } = await world();
  await sealThread(data, "ada", { id: "gift", label: "A", unsealAt: T0 + HOUR }, T0);
  addDiaryNote(characterDir, { at: T0 + 1, thread: "gift", source: "wake", text: "Made a card." });
  addDiaryNote(characterDir, { at: T0 + 2, thread: "gift", source: "note", text: "Buy ribbon." });
  addDiaryNote(characterDir, { at: T0 + 3, thread: "ring", source: "wake", text: "Told part one." });
  addDiaryNote(characterDir, { at: T0 + 4, thread: "ring", source: "shore", text: "About the ring." });
  const texts = (notes: readonly { text: string }[]): string[] => notes.map((note) => note.text);
  expect(texts(recentDiary(characterDir, T0 + 10).notes)).toEqual(["Told part one.", "About the ring."]);
  expect(texts(unfoldedDiary(characterDir))).toEqual(["Told part one.", "About the ring."]);
  expect(texts(unseenDiary(characterDir, [], T0 + 10, "main"))).toEqual(["Told part one.", "About the ring."]);
  expect(texts(unseenDiary(characterDir, [], T0 + 10, "gift"))).toEqual(["Told part one.", "About the ring."]);
  expect(texts(unseenDiary(characterDir, [], T0 + 10, "ring"))).toEqual([]);
  expect(texts(keptDiary(characterDir, T0 + 10))).toEqual(["Told part one.", "About the ring."]);

  await openDueSeals(data, "ada", T0 + HOUR);
  expect(texts(keptDiary(characterDir, T0 + HOUR))).toEqual(["Made a card.", "Buy ribbon.", "Told part one.", "About the ring."]);
  expect(texts(unfoldedDiary(characterDir))).toEqual(["Made a card.", "Buy ribbon.", "Told part one.", "About the ring."]);
  expect(texts(unseenDiary(characterDir, [], T0 + HOUR, "main"))).toEqual(["Made a card.", "Buy ribbon.", "Told part one.", "About the ring."]);
  expect(texts(unseenDiary(characterDir, [], T0 + HOUR, "gift"))).toEqual(["Told part one.", "About the ring."]);
});

test("from inside a sealed thread the list of threads says where the character is, and marks no other thread as that place", async () => {
  const { data } = await world();
  await sealThread(data, "ada", { id: "gift", label: "Something for you", unsealAt: T0 + HOUR }, T0);
  const listed = await handleListThreads({ dataDir: data, character: "ada", thread: "gift", userName: "eve", timeZone: "UTC", now: () => T0 });
  expect(listed).toStartWith('Your home thread is "main", where the messages you send from heartbeats arrive. You\'re in "gift", which is sealed.\n\nmain (home) · compaction on');
  expect(listed).not.toContain("you're here");
  expect(listed).toEndWith('- `gift` "Something for you", opens Friday 2026-10-30 · 1:00 PM]');
  const elsewhere = await handleListThreads({ dataDir: data, character: "ada", thread: "ring", userName: "eve", timeZone: "UTC", now: () => T0 });
  expect(elsewhere).toStartWith('Your home thread is "main", where the messages you send from heartbeats arrive. You\'re in "ring".\n\n');
  expect(elsewhere).toContain("ring (you're here) · compaction off");
  const nowhere = await handleListThreads({ dataDir: data, character: "ada", thread: "ghost", userName: "eve", timeZone: "UTC", now: () => T0 });
  expect(nowhere).toStartWith('Your home thread is "main", where the messages you send from heartbeats arrive. You\'re in it.\n\nmain (home, you\'re here) · compaction on');
});

function request(sealed: boolean): SidecarRequest {
  return {
    sdk: "anthropic", model: "claude-fixture", provider_key: "anthropic", api_key: "key", max_tokens: 64, replay_prior_thinking: "all",
    messages: [{ role: "user", content: [{ type: "text", text: "the card" }] }],
    context: { character: "ada", call_type: "heartbeat", thinking_enabled: false, ...(sealed ? { sealed: true } : {}) },
  };
}

function provider(): SidecarProvider {
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const done: StreamEvent = { type: "done", content: "ok", usage, timing: { total_ms: 1, time_to_first_token_ms: 1 }, finish_reason: "end_turn" };
  const response = { model: "claude-fixture", content: "ok", content_blocks: [{ type: "text", text: "ok" }], finish_reason: "end_turn", usage, timing: { total_ms: 1, time_to_first_token_ms: 1 } } satisfies GenerateResponse;
  return {
    async *stream() {
      yield done;
    },
    generate: async () => response,
  };
}

test("a call made inside a sealed thread is kept out of the record of calls, whichever way it is made", async () => {
  const store = CallStore.openInMemory();
  try {
    const captured = withCallCapture(provider(), store);
    const made = async (sealed: boolean): Promise<string[]> => {
      const got: string[] = [];
      for await (const event of captured.stream(request(sealed))) got.push(event.type);
      const tools = { messages: [], parallel: false, runTool: async () => ({ type: "text" as const, text: "" }), recordTurn: async () => {} };
      for await (const event of captured.streamWithTools?.(request(sealed), tools) ?? []) got.push(event.type);
      got.push((await captured.generate(request(sealed))).content);
      return got;
    };
    const quiet = await made(true);
    expect(quiet.filter((type) => type === "done" || type === "ok")).toEqual(["done", "done", "ok"]);
    expect(store.callCount()).toBe(0);
    expect(await made(false)).toEqual(quiet);
    expect(store.callCount()).toBe(3);
  } finally {
    store.close();
  }
});
