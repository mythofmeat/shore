import { required } from "../src/util/required.ts";

import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import rawFixture from "./command_captures/conversation.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);

import {
  alt,
  deleteMessages,
  edit,
  get,
  historyPage,
  injectSystem,
  listAlternatives,
  log,
  resolveRef,
} from "../src/commands/conversation.ts";
import { CommandError } from "../src/commands/errors.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { mergeToolLoopMessages } from "../src/engine/merge.ts";
import type { ImageRef, Message } from "../src/engine/types.ts";
import { testTmp } from "./support/tmp.ts";

interface WireError {
  code: string;
  message: string;
}

interface Step {
  op: string;
  args: Record<string, unknown>;
  history_pushes: number;
  err?: WireError;
}

interface Scenario {
  name: string;
  note?: string;
  archived: Message[];
  active: Message[];
  files: { name: string; bytes_utf8: string }[];
  initial_messages?: Message[];
  initial_display_history?: Message[];
  steps: Step[];
}

const scenarios = fixture.scenarios as unknown as Scenario[];

function isMessage(v: Record<string, unknown>): boolean {
  return "msg_id" in v && "role" in v && "content_blocks" in v;
}

function serdeShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serdeShape);
  if (value === null || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const message = isMessage(input);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (message && key === "alternatives" && Array.isArray(v) && v.length === 0) continue;
    out[key] = serdeShape(v);
  }
  return out;
}

const UUID_RE = /^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

const STUB_ID = "m_00000000-0000-4000-8000-000000000000";
const STUB_NOW = "2026-01-02T03:04:05.678+00:00";

async function buildScenario(
  scenario: Scenario,
): Promise<{ engine: ConversationEngine; pushes: () => number; root: string }> {
  const root = await mkdtemp(testTmp("shore-conv-"));
  const characterDir = join(root, "TestChar");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });

  for (const file of scenario.files) {
    await writeFile(join(root, file.name), file.bytes_utf8);
  }

  const substitute = (messages: Message[]): Message[] =>
    JSON.parse(JSON.stringify(messages).replaceAll("<tmp>", root)) as Message[];
  const jsonl = (messages: Message[]) =>
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n";

  const active = substitute(scenario.active);
  if (scenario.archived.length > 0) {
    const archived = substitute(scenario.archived);
    await mkdir(join(characterDir, "threads", "main", "segments"), { recursive: true });
    await writeFile(join(characterDir, "threads", "main", "segments", "0001.jsonl"), jsonl(archived));
    await writeFile(
      join(characterDir, "threads", "main", "compaction.json"),
      JSON.stringify(
        {
          segments: [
            {
              file: "0001.jsonl",
              message_count: archived.length,
              compacted_at: "2026-01-01T00:00:00Z",
            },
          ],
          total_compacted_messages: archived.length,
        },
        null,
        2,
      ),
    );
  }
  await writeFile(join(characterDir, "threads", "main", "active.jsonl"), jsonl(active));

  let count = 0;
  const engine = await ConversationEngine.load("TestChar", root, () => {
    count += 1;
  });
  return { engine, pushes: () => count, root };
}

function expand(value: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll("<tmp>", root)) as unknown;
}

async function runStep(engine: ConversationEngine, step: Step): Promise<unknown> {
  const args = step.args;
  switch (step.op) {
    case "get":
      return get(engine, args);
    case "log":
      return await log(engine, args);
    case "history_page":
      return await historyPage(engine, args);
    case "list_alternatives":
      return listAlternatives(engine, args);
    case "edit":
      return await edit(engine, args);
    case "delete":
      return await deleteMessages(engine, args);
    case "alt":
      return await alt(engine, args);
    case "inject_system":
      return await injectSystem(
        engine,
        args,
        () => STUB_ID,
        () => STUB_NOW,
      );
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

interface Snapshot {
  ids: string[];
  byId: Map<string, string>;
}

function snapshot(engine: ConversationEngine): Snapshot {
  const messages = engine.messages();
  const seen = new Map<string, number>();
  const byId = new Map<string, string>();
  for (const msg of messages) {
    const nth = seen.get(msg.msg_id) ?? 0;
    seen.set(msg.msg_id, nth + 1);
    byId.set(nth === 0 ? msg.msg_id : `${msg.msg_id}#${nth}`, JSON.stringify(serdeShape(msg)));
  }
  return { ids: messages.map((m) => m.msg_id), byId };
}

function expectOnlyTheseChanged(
  before: Snapshot,
  after: Snapshot,
  changed: readonly string[],
  label: string,
): void {
  for (const [id, json] of before.byId) {
    const now = after.byId.get(id);
    if (now === undefined || changed.includes(id)) continue;
    expect(now, `${label}: ${id} was not the message this touched`).toBe(json);
  }
}

function expectUntouched(before: Snapshot, after: Snapshot, label: string): void {
  expect(after.ids, `${label}: reading the conversation does not change it`).toEqual(before.ids);
  expectOnlyTheseChanged(before, after, [], label);
}

function isToolResultOnly(msg: Message): boolean {
  return (
    msg.role === "user" &&
    msg.content_blocks.length > 0 &&
    msg.content_blocks.every((b) => b.type === "tool_result")
  );
}

function expectImagesEmbedded(images: readonly ImageRef[], want: boolean, label: string): void {
  for (const img of images) {
    if (want && !existsSync(img.path)) continue;
    expect(img.data !== undefined, `${label}: ${img.path} carries its bytes`).toBe(want);
  }
}

function expectPage(
  row: Record<string, unknown>,
  history: { messages: Message[]; activeStart: number },
  args: Record<string, unknown>,
  label: string,
): void {
  const page = row["messages"] as Message[];
  const cursor = row["cursor"] as number;
  const activeStart = row["active_start"] as number;
  const role = args["role"];

  expect(row["next_before"], `${label}: the page tells you where to ask for the one before it`).toBe(
    cursor,
  );
  expect(row["has_more_before"], `${label}: there is more before iff this page is not the start`).toBe(
    cursor > 0,
  );
  expect(
    row["global_active_start"],
    `${label}: the page says where the live file starts in the whole history`,
  ).toBe(history.activeStart);

  const turns = history.messages.filter((m) => m.role === "user" && !isToolResultOnly(m)).length;
  expect(row["total_turns"], `${label}: the total counts typed turns, not this page`).toBe(turns);
  expect(row["total_messages"], `${label}: the two totals are one number under two names`).toBe(
    row["total_turns"],
  );

  expect(
    activeStart >= 0 && activeStart <= page.length,
    `${label}: active_start points into the page it came with`,
  ).toBe(true);

  const positions = new Map<string, number[]>();
  history.messages.forEach((m, i) => {
    positions.set(m.msg_id, [...(positions.get(m.msg_id) ?? []), i]);
  });
  let previous = cursor - 1;
  page.forEach((msg, i) => {
    const at = (positions.get(msg.msg_id) ?? []).find((n) => n > previous);
    expect(at, `${label}: entry ${i} is a message of this conversation`).toBeDefined();
    const idx = at as number;
    expect(idx > previous, `${label}: the page runs forwards from its cursor`).toBe(true);
    expect(idx >= cursor, `${label}: nothing before the cursor is on the page`).toBe(true);
    previous = idx;

    if (role === undefined) {
      expect(idx, `${label}: an unfiltered page is an unbroken run from the cursor`).toBe(cursor + i);
    } else {
      expect(msg.role, `${label}: a filtered page holds only that role`).toBe(role as never);
    }

    expect(
      i < activeStart,
      `${label}: entry ${i} is above active_start iff it comes from an archived segment`,
    ).toBe(idx < history.activeStart);

    const live = i >= activeStart;
    expectImagesEmbedded(msg.images, live, `${label}: entry ${i}`);
    for (const alternative of msg.alternatives ?? []) {
      expectImagesEmbedded(alternative.images, live, `${label}: entry ${i} alternative`);
    }
  });

  if (role !== undefined) return;

  const u64 = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
  const count = u64(args["count"]);
  const wanted = u64(args["turns"]);
  if (wanted === 0) {
    expect(page.length, `${label}: asking for no turns asks for no messages`).toBe(0);
  } else if (wanted === undefined && count !== undefined) {
    expect(
      page.length === count || cursor === 0,
      `${label}: count asks for that many messages, or everything there is`,
    ).toBe(true);
  } else {
    const asked = wanted ?? 64;
    const users = page.filter((m) => m.role === "user").length;
    expect(
      users === asked || cursor === 0,
      `${label}: turns wins over count, and asks for that many user messages`,
    ).toBe(true);
  }
}

function expectShapeOf(
  step: Step,
  result: unknown,
  engine: ConversationEngine,
  history: { messages: Message[]; activeStart: number },
  before: Snapshot,
  mergedBefore: Message[],
  label: string,
): void {
  const row = result as Record<string, unknown>;
  const after = snapshot(engine);
  const merged = mergeToolLoopMessages([...engine.messages()]);
  const role = step.args["role"];

  switch (step.op) {
    case "log":
    case "history_page":
      expectUntouched(before, after, label);
      expectPage(row, history, step.args, label);
      return;

    case "get": {
      expectUntouched(before, after, label);
      const visible = merged.filter((m) => role === undefined || m.role === role);
      const found = visible.find((m) => m.msg_id === row["msg_id"]);
      expect(found, `${label}: get answers with a message that is in the conversation`).toBeDefined();
      expect(serdeShape(row), `${label}: get answers with that message, unaltered`).toEqual(
        serdeShape(found) as never,
      );
      expect(
        resolveRef(visible, String(step.args["ref"])),
        `${label}: get honours the same ref rules as everything else`,
      ).toBe(row["msg_id"] as string);
      return;
    }

    case "list_alternatives": {
      expectUntouched(before, after, label);
      const ref = String(row["ref"]);
      const msg = required(merged.find((m) => m.msg_id === ref));
      expect(msg.role, `${label}: only an assistant message has alternates`).toBe("assistant");

      const alts = row["alternatives"] as {
        index: number;
        position: number;
        active: boolean;
        content: string;
        images: ImageRef[];
      }[];
      expect(row["alt_count"], `${label}: the count is how many were listed`).toBe(alts.length);
      expect(
        alts.map((a) => a.content),
        `${label}: the listed alternates are the message's own`,
      ).toEqual((msg.alternatives ?? []).map((a) => a.content));
      alts.forEach((a, i) => {
        expect(a.index, `${label}: alternate ${i} is numbered from zero`).toBe(i);
        expect(a.position, `${label}: its position is that index counted from one`).toBe(i + 1);
        expectImagesEmbedded(a.images, true, `${label}: alternate ${i}`);
      });

      const stored = row["alt_index"];
      expect(
        row["position"],
        `${label}: a message with no chosen alternate has no position either`,
      ).toBe(stored === null ? null : (stored as number) + 1);

      if (alts.length === 0) {
        expect(alts.some((a) => a.active), `${label}: nothing is active when there is nothing`).toBe(
          false,
        );
        return;
      }
      const active = alts.filter((a) => a.active);
      expect(active.length, `${label}: exactly one alternate is the live one`).toBe(1);
      expect(
        required(active[0]).index,
        `${label}: a stored index past the end falls back to the last alternate`,
      ).toBe(Math.min(msg.alt_index ?? 0, alts.length - 1));
      return;
    }

    case "edit": {
      const ref = String(row["ref"]);
      expect(row["edited"], `${label}: edit says it edited`).toBe(true);
      expect(
        ref,
        `${label}: edit counts tool loops as the one message the log shows`,
      ).toBe(resolveRef(mergedBefore, String(step.args["ref"])));
      expect(after.ids, `${label}: editing adds and removes nothing`).toEqual(before.ids);
      expectOnlyTheseChanged(before, after, [ref], label);
      expect(
        required(engine.messages().find((m) => m.msg_id === ref)).content,
        `${label}: the message now reads as asked`,
      ).toBe(step.args["content"] as string);
      return;
    }

    case "delete": {
      const deleted = row["deleted"] as string[];
      expect(new Set(deleted).size, `${label}: nothing is reported deleted twice`).toBe(
        deleted.length,
      );
      for (const id of deleted) {
        expect(after.byId.has(id), `${label}: ${id} was reported deleted and is gone`).toBe(false);
      }
      expect(
        after.ids,
        `${label}: what survives keeps the order it had`,
      ).toEqual(before.ids.filter((id) => after.byId.has(id)));
      expectOnlyTheseChanged(before, after, [], label);

      const offered = new Set(
        engine
          .messages()
          .flatMap((m) => m.content_blocks)
          .filter((b) => b.type === "tool_use")
          .map((b) => b.id),
      );
      for (const msg of engine.messages()) {
        for (const block of msg.content_blocks) {
          if (block.type !== "tool_result") continue;
          expect(
            offered.has(block.tool_use_id),
            `${label}: no tool result is left without its call`,
          ).toBe(true);
        }
      }
      return;
    }

    case "alt": {
      const ref = String(row["ref"]);
      expect(after.ids, `${label}: choosing an alternate adds and removes nothing`).toEqual(
        before.ids,
      );
      expectOnlyTheseChanged(before, after, [ref], label);

      const msg = required(engine.messages().find((m) => m.msg_id === ref));
      const alts = msg.alternatives ?? [];
      const index = row["alt_index"] as number;
      expect(row["alt_count"], `${label}: the count is the message's alternates`).toBe(alts.length);
      expect(
        index >= 0 && index < alts.length,
        `${label}: the chosen index is one that exists`,
      ).toBe(true);
      expect(row["position"], `${label}: position is the index counted from one`).toBe(index + 1);
      expect(row["content"], `${label}: it answers with the alternate it chose`).toBe(
        required(alts[index]).content,
      );
      expect(msg.content, `${label}: and the message now reads as that alternate`).toBe(
        row["content"] as string,
      );
      expect(msg.alt_index, `${label}: and remembers which one is live`).toBe(index);
      return;
    }

    case "inject_system": {
      expect(row["injected"], `${label}: inject says it injected`).toBe(true);
      expect(
        after.ids.slice(0, before.ids.length),
        `${label}: the injected message goes on the end, disturbing nothing`,
      ).toEqual(before.ids);
      expect(after.ids.length, `${label}: exactly one message was added`).toBe(before.ids.length + 1);
      expectOnlyTheseChanged(before, after, [], label);

      const text = step.args["text"];
      const last = required(engine.messages()[after.ids.length - 1]);
      expect(last.role, `${label}: what was injected is a system message`).toBe("system");
      expect(last.content, `${label}: carrying the text asked for`).toBe(text as string);
      expect(last.content_blocks, `${label}: as a single text block`).toEqual([
        { type: "text", text: text as string },
      ]);
      return;
    }

    default:
      throw new Error(`${label}: no shape stated for ${step.op}`);
  }
}

describe("resolveRef picks a message out of a conversation", () => {
  function conversation(count: number): Message[] {
    return Array.from({ length: count }, (_, i) => ({
      msg_id: `m${i + 1}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: String.fromCharCode(65 + i),
      images: [],
      content_blocks: [{ type: "text" as const, text: String.fromCharCode(65 + i) }],
      timestamp: "2026-01-01T00:00:00Z",
    }));
  }

  const resolves: [note: string, messages: number, ref: string, msgId: string][] = [
    ["the last message, whatever its role", 3, "last", "m3"],
    ["latest is a spelling of last", 3, "latest", "m3"],
    ["-1 is the last", 3, "-1", "m3"],
    ["and counts backwards from there", 3, "-2", "m2"],
    ["as far as the first", 3, "-3", "m1"],
    ["positive indices start at one", 3, "1", "m1"],
    ["counting forwards", 3, "2", "m2"],
    ["to the last", 3, "3", "m3"],
    ["a leading plus is still an index", 3, "+2", "m2"],
    ["an id that exists is itself", 1, "m1", "m1"],
    ["an id that does not exist is passed through for the caller to reject", 1, "nope", "nope"],
    ["something that is not a whole number is an id, not an index", 1, "1.5", "1.5"],
    ["and needs no messages to be passed through", 0, "m_whatever", "m_whatever"],
  ];

  const refuses: [note: string, messages: number, ref: string, code: string, message: string][] = [
    [
      "zero is neither a first nor a last",
      3,
      "0",
      "invalid_request",
      "Message index must be non-zero (use 1 for first, -1 for last)",
    ],
    [
      "past the end",
      1,
      "99",
      "not_found",
      "Message index 99 out of range (conversation has 1 messages)",
    ],
    [
      "past the start",
      1,
      "-99",
      "not_found",
      "Message index -99 out of range (conversation has 1 messages)",
    ],
    [
      "one before the first",
      3,
      "-4",
      "not_found",
      "Message index -4 out of range (conversation has 3 messages)",
    ],
    [
      "one past the last",
      3,
      "4",
      "not_found",
      "Message index 4 out of range (conversation has 3 messages)",
    ],
    ["there is no last message of nothing", 0, "last", "not_found", "No messages in conversation"],
    [
      "nor a -1",
      0,
      "-1",
      "not_found",
      "Message index -1 out of range (conversation has 0 messages)",
    ],
    ["nor a 1", 0, "1", "not_found", "Message index 1 out of range (conversation has 0 messages)"],
  ];

  for (const [note, count, ref, msgId] of resolves) {
    test(`${JSON.stringify(ref)}: ${note}`, () => {
      expect(resolveRef(conversation(count), ref)).toBe(msgId);
    });
  }

  for (const [note, count, ref, code, message] of refuses) {
    test(`${JSON.stringify(ref)}: ${note}`, () => {
      let thrown: unknown;
      try {
        resolveRef(conversation(count), ref);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(CommandError);
      expect((thrown as CommandError).code).toBe(code as never);
      expect((thrown as CommandError).message).toBe(message);
    });
  }
});

describe("a message reference shore refuses to resolve", () => {
  const messages: Message[] = [
    { msg_id: "m1", role: "user", content: "A", images: [], content_blocks: [], timestamp: "t" },
    { msg_id: "m2", role: "user", content: "B", images: [], content_blocks: [], timestamp: "t" },
  ];
  for (const literal of ["1.5", " 2", "2 ", "1e1", "0x2", "２", "", "1_0", "Infinity"]) {
    test(`${JSON.stringify(literal)} is a literal, not an index`, () => {
      expect(resolveRef(messages, literal)).toBe(literal);
    });
  }
  test("a value past i64 is a literal, not a saturated index", () => {
    expect(resolveRef(messages, "99999999999999999999")).toBe("99999999999999999999");
  });
});

describe("conversation commands", () => {
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const { engine, pushes, root } = await buildScenario(scenario);

      expect(serdeShape(engine.messages())).toEqual(
        expand(scenario.initial_messages ?? scenario.active, root) as never,
      );
      const display = await engine.displayHistory();
      expect(serdeShape(display.messages)).toEqual(
        expand(scenario.initial_display_history ?? scenario.active, root) as never,
      );

      let seen = pushes();
      for (const step of scenario.steps) {
        const label = `${step.op} ${JSON.stringify(step.args)}`;
        const before = snapshot(engine);
        const mergedBefore = mergeToolLoopMessages([...engine.messages()]);
        const history = await engine.displayHistory();

        let result: unknown;
        let thrown: unknown;
        try {
          result = await runStep(engine, step);
        } catch (e) {
          thrown = e;
        }

        if (step.err !== undefined) {
          expect(thrown, label).toBeInstanceOf(CommandError);
          expect((thrown as CommandError).code, label).toBe(step.err.code as never);
          expect((thrown as CommandError).message, label).toBe(step.err.message);
          expectUntouched(before, snapshot(engine), `${label} — a refused command`);
        } else {
          expect(thrown, label).toBeUndefined();
          expectShapeOf(step, result, engine, history, before, mergedBefore, label);
        }

        expect(pushes() - seen, `${label} — history pushes`).toBe(step.history_pushes);
        seen = pushes();
      }
    });
  }
});

describe("log stops at 64 user turns unless told otherwise", () => {
  async function engineOf(userTurns: number): Promise<ConversationEngine> {
    const root = await mkdtemp(testTmp("shore-bound-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    const messages = Array.from({ length: userTurns }, (_, i) => ({
      msg_id: `m${i + 1}`,
      role: "user" as const,
      content: `turn ${i + 1}`,
      images: [],
      content_blocks: [{ type: "text" as const, text: `turn ${i + 1}` }],
      timestamp: "2026-01-01T00:00:00Z",
    }));
    await writeFile(
      join(characterDir, "threads", "main", "active.jsonl"),
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
    return await ConversationEngine.load("TestChar", root, () => {});
  }

  test("a longer conversation is cut to the last 64", async () => {
    const engine = await engineOf(66);
    const page = (await log(engine, {})) as { messages: Message[]; cursor: number };

    expect(page.messages.length).toBe(64);
    expect(page.cursor).toBe(2);
    expect(required(page.messages[0]).content).toBe("turn 3");
  });

  test("asking for more than there is gives everything, not an error", async () => {
    const engine = await engineOf(66);
    for (const turns of [66, 67, 400]) {
      const page = (await log(engine, { turns })) as { messages: Message[]; cursor: number };
      expect(page.messages.length, `turns: ${turns}`).toBe(66);
      expect(page.cursor, `turns: ${turns}`).toBe(0);
    }
  });

  test("a conversation shorter than the bound is not padded or truncated", async () => {
    const engine = await engineOf(5);
    const page = (await log(engine, {})) as { messages: Message[] };
    expect(page.messages.length).toBe(5);
  });
});

describe("which page an argument asks for", () => {
  async function engineOf(messages: Message[]): Promise<ConversationEngine> {
    const root = await mkdtemp(testTmp("shore-args-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    await writeFile(
      join(characterDir, "threads", "main", "active.jsonl"),
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
    return await ConversationEngine.load("TestChar", root, () => {});
  }

  function alternating(count: number): Message[] {
    return Array.from({ length: count }, (_, i) => ({
      msg_id: `m${i + 1}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `line ${i + 1}`,
      images: [],
      content_blocks: [{ type: "text" as const, text: `line ${i + 1}` }],
      timestamp: "2026-01-01T00:00:00Z",
    }));
  }

  const ids = (page: unknown): string[] =>
    (page as { messages: Message[] }).messages.map((m) => m.msg_id);

  test("turns wins over count when both are given", async () => {
    const engine = await engineOf(alternating(12));

    const both = ids(await log(engine, { count: 3, turns: 1 }));
    expect(both).toEqual(ids(await log(engine, { turns: 1 })));
    expect(both).not.toEqual(ids(await log(engine, { count: 3 })));
  });

  test("history_page with no cursor reads the end, the same as log", async () => {
    const engine = await engineOf(alternating(12));

    const page = await historyPage(engine, { turns: 2 });
    expect(ids(page)).toEqual(ids(await log(engine, { turns: 2 })));
    expect(ids(page).length).toBeGreaterThan(0);
  });

  test("a cursor of zero reads the start, not the end", async () => {
    const engine = await engineOf(alternating(12));

    expect(ids(await historyPage(engine, { before: 0, count: 4 }))).toEqual([]);
  });
});

describe("storage-native conversation paging", () => {
  const archivedMessage = (id: string, role: "user" | "assistant"): Message => ({
    msg_id: id,
    role,
    content: role === "user" ? "prompt" : "reply",
    images: [],
    content_blocks: [{ type: "text", text: role === "user" ? "prompt" : "reply" }],
    timestamp: "2026-01-01T00:00:00Z",
  });
  const jsonl = (messages: readonly Message[]) =>
    messages.map((message) => JSON.stringify(message)).join("\n") + "\n";

  test("every page reads bounded rows independent of lifetime history", async () => {
    const root = await mkdtemp(testTmp("shore-bounded-history-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    await writeFile(join(characterDir, "threads", "main", "active.jsonl"), "");
    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    const expected: string[] = [];
    for (let segment = 0; segment < 200; segment += 1) {
      const suffix = String(segment).padStart(4, "0");
      const messages = [
        archivedMessage(`u${suffix}`, "user"),
        archivedMessage(`a${suffix}`, "assistant"),
      ];
      expected.push(...messages.map((message) => message.msg_id));
      store.putSegment(
        "TestChar",
        segment,
        {
          file: HISTORY_DB_FILE,
          message_count: messages.length,
          compacted_at: "2026-01-01T00:00:00Z",
        },
        messages,
      );
    }
    store.close();

    const engine = await ConversationEngine.load("TestChar", root, () => {});
    const loaded: string[] = [];
    const decodedSizes = new Set<number>();
    let before: number | undefined;
    for (;;) {
      const page = await engine.displayHistoryPage(before, { kind: "count", value: 8 });
      expect(page.metrics.storage_native).toBe(true);
      expect(page.metrics.rows_read).toBeLessThanOrEqual(8);
      expect(page.metrics.segments_read).toBeLessThanOrEqual(4);
      if (page.messages.length === 8) decodedSizes.add(page.metrics.decoded_body_bytes);
      loaded.unshift(...page.messages.map((message) => message.msg_id));
      if (page.cursor === 0) break;
      before = page.cursor;
    }

    expect(loaded).toEqual(expected);
    expect(decodedSizes.size).toBe(1);
    engine.segments().close();
  });

  test("a numeric cursor survives active appends and compaction movement", async () => {
    const root = await mkdtemp(testTmp("shore-stable-history-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    const archived = [archivedMessage("u0", "user"), archivedMessage("a0", "assistant")];
    const active = [
      archivedMessage("u1", "user"),
      archivedMessage("a1", "assistant"),
      archivedMessage("u2", "user"),
      archivedMessage("a2", "assistant"),
    ];
    const dbPath = join(root, HISTORY_DB_FILE);
    const store = HistoryStore.open(dbPath);
    store.putSegment(
      "TestChar",
      0,
      {
        file: HISTORY_DB_FILE,
        message_count: archived.length,
        compacted_at: "2026-01-01T00:00:00Z",
      },
      archived,
    );
    store.close();
    await writeFile(join(characterDir, "threads", "main", "active.jsonl"), jsonl(active));

    const engine = await ConversationEngine.load("TestChar", root, () => {});
    const before = 4;
    const original = await engine.displayHistoryPage(before, { kind: "count", value: 2 });
    expect(original.messages.map((message) => message.msg_id)).toEqual(["u1", "a1"]);

    await engine.appendMessage(archivedMessage("u3", "user"));
    const afterAppend = await engine.displayHistoryPage(before, { kind: "count", value: 2 });
    expect(afterAppend.messages).toEqual(original.messages);
    expect(afterAppend.cursor).toBe(original.cursor);

    const compactionStore = HistoryStore.open(dbPath);
    compactionStore.putSegment(
      "TestChar",
      1,
      {
        file: HISTORY_DB_FILE,
        message_count: 2,
        compacted_at: "2026-01-01T00:01:00Z",
      },
      active.slice(0, 2),
    );
    compactionStore.close();
    await writeFile(
      join(characterDir, "threads", "main", "active.jsonl"),
      jsonl([...active.slice(2), archivedMessage("u3", "user")]),
    );
    await engine.reload();

    const afterCompaction = await engine.displayHistoryPage(before, {
      kind: "count",
      value: 2,
    });
    expect(afterCompaction.messages).toEqual(original.messages);
    expect(afterCompaction.cursor).toBe(original.cursor);
    engine.segments().close();
  });
});

describe("which alternate an argument selects", () => {
  async function threeAnswers(): Promise<ConversationEngine> {
    const root = await mkdtemp(testTmp("shore-alt-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    const answer = (text: string) => ({
      content: text,
      images: [],
      content_blocks: [{ type: "text", text }],
      timestamp: "2026-01-01T00:00:00Z",
    });
    const messages = [
      {
        msg_id: "u1",
        role: "user",
        content: "Prompt",
        images: [],
        content_blocks: [{ type: "text", text: "Prompt" }],
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        msg_id: "a2",
        role: "assistant",
        content: "one",
        images: [],
        content_blocks: [{ type: "text", text: "one" }],
        alt_index: 0,
        alt_count: 3,
        alternatives: [answer("one"), answer("two"), answer("three")],
        timestamp: "2026-01-01T00:00:00Z",
      },
    ];
    await writeFile(
      join(characterDir, "threads", "main", "active.jsonl"),
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
    return await ConversationEngine.load("TestChar", root, () => {});
  }

  const cases: [args: Record<string, unknown>, from: number, index: number, note: string][] = [
    [{ index: 2 }, 0, 2, "an index is zero-based"],
    [{ position: 2 }, 0, 1, "a position is that index counted from one"],
    [{ index: 0, position: 3 }, 0, 0, "index wins over position"],
    [{ index: 2, direction: "first" }, 0, 2, "index wins over direction"],
    [{ position: 3, direction: "first" }, 0, 2, "position wins over direction"],
    [{}, 0, 1, "with nothing said, the next one"],
    [{ direction: "next" }, 0, 1, "next steps forward"],
    [{ direction: "next" }, 2, 2, "and stops at the last"],
    [{ direction: "prev" }, 2, 1, "prev steps back"],
    [{ direction: "previous" }, 2, 1, "previous is a spelling of prev"],
    [{ direction: "prev" }, 0, 0, "and stops at the first"],
    [{ direction: "first" }, 2, 0, "first is the first"],
    [{ direction: "last" }, 0, 2, "last is the last"],
  ];

  for (const [args, from, index, note] of cases) {
    test(`${JSON.stringify(args)} from ${from}: ${note}`, async () => {
      const engine = await threeAnswers();
      if (from !== 0) await alt(engine, { index: from });

      const chosen = (await alt(engine, args)) as { alt_index: number; content: string };
      expect(chosen.alt_index).toBe(index);
      expect(chosen.content).toBe(required(["one", "two", "three"][index]));
    });
  }
});

describe("injectSystem generates a uuid and a local timestamp", () => {
  test("the defaults produce the shapes the fixture masked", async () => {
    const { engine } = await buildScenario(
      required(scenarios.find((s) => s.name === "inject_system")),
    );
    await injectSystem(engine, { text: "hello" });
    const appended = required(engine.messages()[engine.messages().length - 1]);
    expect(appended.msg_id).toMatch(UUID_RE);
    expect(appended.timestamp).toMatch(LOCAL_RFC3339_RE);
    expect(Number.isNaN(Date.parse(appended.timestamp))).toBe(false);
  });
});

describe("editing an assistant message", () => {
  test("the command preserves its thinking block and signature", async () => {
    const thinking = {
      type: "thinking" as const,
      thinking: "weighing the answer",
      signature: "sig-preserved",
    };
    const scenario: Scenario = {
      name: "assistant edit preserves thinking",
      archived: [],
      active: [
        {
          msg_id: "m1",
          role: "assistant",
          content: "before",
          images: [],
          content_blocks: [thinking, { type: "text", text: "before" }],
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      files: [],
      steps: [],
    };
    const { engine } = await buildScenario(scenario);

    await edit(engine, { ref: "last", content: "after" });

    expect(required(engine.messages()[0]).content_blocks).toEqual([
      thinking,
      { type: "text", text: "after" },
    ]);
  });
});

describe("deleting a tool loop leaves nothing the API will reject", () => {
  function msg(msg_id: string, role: Message["role"], blocks: Message["content_blocks"]): Message {
    return {
      msg_id,
      role,
      content: blocks.map((b) => (b.type === "text" ? b.text : "")).join(""),
      images: [],
      content_blocks: blocks,
      timestamp: "2026-01-01T00:00:00.000+00:00",
    };
  }

  const wedgeShape: Message[] = [
    msg("m_29", "assistant", [{ type: "thinking", thinking: "hm" }, { type: "text", text: "sure" }]),
    msg("m_30", "user", [{ type: "text", text: "the typed message" }]),
    msg("m_31", "assistant", [
      { type: "thinking", thinking: "call it" },
      { type: "tool_use", id: "toolu_017aWq", name: "search", input: {} },
    ]),
    msg("m_32", "user", [{ type: "tool_result", tool_use_id: "toolu_017aWq", content: "hits" }]),
  ];

  async function engineOver(messages: Message[]): Promise<ConversationEngine> {
    const root = await mkdtemp(testTmp("shore-orphan-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    await writeFile(
      join(characterDir, "threads", "main", "active.jsonl"),
      messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
    return await ConversationEngine.load("TestChar", root, () => {});
  }

  function orphanedToolResults(messages: readonly Message[]): string[] {
    const orphans: string[] = [];
    messages.forEach((m, i) => {
      const prev = messages[i - 1];
      const offered = new Set(
        prev?.role === "assistant"
          ? prev.content_blocks.filter((b) => b.type === "tool_use").map((b) => b.id)
          : [],
      );
      for (const b of m.content_blocks) {
        if (b.type === "tool_result" && !offered.has(b.tool_use_id)) orphans.push(b.tool_use_id);
      }
    });
    return orphans;
  }

  test("deleting the last turn takes the whole tool loop, not just the assistant", async () => {
    const engine = await engineOver(wedgeShape);
    const result = (await deleteMessages(engine, { refs: "last" })) as { deleted: string[] };

    expect(result.deleted.sort()).toEqual(["m_31", "m_32"]);
    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_29", "m_30"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });

  test("two refs inside one tool loop delete it once", async () => {
    const engine = await engineOver(wedgeShape);
    const result = (await deleteMessages(engine, { refs: ["m_31", "m_32"] })) as {
      deleted: string[];
    };

    expect(result.deleted.sort()).toEqual(["m_31", "m_32"]);
    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_29", "m_30"]);
  });

  test("deleting the assistant by raw msg_id takes its tool results too", async () => {
    const engine = await engineOver(wedgeShape);
    await deleteMessages(engine, { refs: "m_31" });

    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_29", "m_30"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });

  test("a multi-round loop goes as one turn", async () => {
    const engine = await engineOver([
      msg("m_1", "user", [{ type: "text", text: "go" }]),
      msg("m_2", "assistant", [{ type: "tool_use", id: "t1", name: "a", input: {} }]),
      msg("m_3", "user", [{ type: "tool_result", tool_use_id: "t1", content: "r1" }]),
      msg("m_4", "assistant", [{ type: "tool_use", id: "t2", name: "b", input: {} }]),
      msg("m_5", "user", [{ type: "tool_result", tool_use_id: "t2", content: "r2" }]),
      msg("m_6", "assistant", [{ type: "text", text: "done" }]),
    ]);
    await deleteMessages(engine, { refs: "last" });

    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_1"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });

  test("an already-orphaned tool_result is swept by the next delete", async () => {
    const engine = await engineOver([
      msg("m_29", "assistant", [{ type: "text", text: "sure" }]),
      msg("m_32", "user", [{ type: "tool_result", tool_use_id: "toolu_017aWq", content: "hits" }]),
      msg("m_33", "user", [{ type: "text", text: "still here" }]),
    ]);
    await deleteMessages(engine, { refs: "m_29" });

    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_33"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });

  test("one unknown ref means nothing at all is deleted", async () => {
    const engine = await engineOver([
      msg("m_1", "user", [{ type: "text", text: "go" }]),
      msg("m_2", "assistant", [{ type: "text", text: "done" }]),
    ]);
    let thrown: unknown;
    try {
      await deleteMessages(engine, { refs: ["m_1", "nope"] });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(CommandError);
    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_1", "m_2"]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a delete that cannot be written is reported, not swallowed",
    async () => {
      const root = await mkdtemp(testTmp("shore-readonly-"));
      const characterDir = join(root, "TestChar");
      await mkdir(join(characterDir, "threads", "main"), { recursive: true });
      await writeFile(
        join(characterDir, "threads", "main", "active.jsonl"),
        [msg("m_1", "user", [{ type: "text", text: "go" }]), msg("m_2", "user", [{ type: "text", text: "stay" }])]
          .map((m) => JSON.stringify(m))
          .join("\n") + "\n",
      );
      const engine = await ConversationEngine.load("TestChar", root, () => {});

      await chmod(join(characterDir, "threads", "main"), 0o555);
      let thrown: unknown;
      try {
        await deleteMessages(engine, { refs: ["m_1"] });
      } catch (e) {
        thrown = e;
      } finally {
        await chmod(join(characterDir, "threads", "main"), 0o755);
      }

      expect(thrown, "a store that refused the write is an error, not a silent success").toBeInstanceOf(
        CommandError,
      );
    },
  );

  test("a tool_result the delete did not orphan is left alone", async () => {
    const engine = await engineOver([
      msg("m_1", "user", [{ type: "text", text: "go" }]),
      msg("m_2", "assistant", [{ type: "tool_use", id: "t1", name: "a", input: {} }]),
      msg("m_3", "user", [{ type: "tool_result", tool_use_id: "t1", content: "r1" }]),
      msg("m_4", "assistant", [{ type: "text", text: "done" }]),
      msg("m_5", "user", [{ type: "text", text: "thanks" }]),
    ]);
    await deleteMessages(engine, { refs: "m_5" });

    expect(engine.messages().map((m) => m.msg_id)).toEqual(["m_1", "m_2", "m_3", "m_4"]);
    expect(orphanedToolResults(engine.messages())).toEqual([]);
  });
});

describe("paging when the legacy import could not finish", () => {
  const msg = (id: string, role: "user" | "assistant"): Message => ({
    msg_id: id,
    role,
    content: id,
    images: [],
    content_blocks: [{ type: "text", text: id }],
    timestamp: "2026-01-01T00:00:00Z",
  });

  async function engineWhoseLegacyImportAborted(): Promise<ConversationEngine> {
    const root = await mkdtemp(testTmp("shore-fallback-page-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main", "segments"), { recursive: true });

    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    store.putSegment(
      "TestChar",
      0,
      {
        file: "0001.jsonl",
        message_count: 4,
        compacted_at: "2026-01-01T00:00:00Z",
        compaction_id: "compact-1",
      },
      [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant")],
    );
    store.close();

    await writeFile(
      join(characterDir, "threads", "main", "compaction.json"),
      JSON.stringify({
        segments: [
          { file: "0001.jsonl", message_count: 4, compacted_at: "2026-01-01T00:00:00Z" },
          { file: "0002.jsonl", message_count: 2, compacted_at: "2026-01-01T00:00:00Z" },
        ],
        total_compacted_messages: 6,
      }),
    );
    await writeFile(join(characterDir, "threads", "main", "segments", "0002.jsonl"), "{ not json at all\n");
    await writeFile(
      join(characterDir, "threads", "main", "active.jsonl"),
      [msg("u3", "user"), msg("a3", "assistant"), msg("u4", "user"), msg("a4", "assistant")]
        .map((m) => JSON.stringify(m))
        .join("\n") + "\n",
    );
    return await ConversationEngine.load("TestChar", root, () => {});
  }

  test("the fallback is the path under test", async () => {
    const engine = await engineWhoseLegacyImportAborted();
    const page = await engine.displayHistoryPage(undefined, { kind: "count", value: 100 });
    expect(page.metrics.storage_native).toBe(false);
    expect(page.messages.map((m) => m.msg_id)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"]);
    expect(page.globalActiveStart).toBe(4);
  });

  test("a turn bound stops on the turn's own message, counting only user turns", async () => {
    const engine = await engineWhoseLegacyImportAborted();
    const page = await engine.displayHistoryPage(undefined, { kind: "turns", value: 2 });

    expect(page.cursor).toBe(4);
    expect(page.messages.map((m) => m.msg_id)).toEqual(["u3", "a3", "u4", "a4"]);
  });

  test("zero turns asks for nothing, not for everything", async () => {
    const engine = await engineWhoseLegacyImportAborted();
    const page = await engine.displayHistoryPage(undefined, { kind: "turns", value: 0 });

    expect(page.messages).toEqual([]);
    expect(page.cursor).toBe(8);
  });

  test("a count larger than the conversation clamps to the start", async () => {
    const engine = await engineWhoseLegacyImportAborted();
    const page = await engine.displayHistoryPage(undefined, { kind: "count", value: 100 });

    expect(page.cursor).toBe(0);
    expect(page.messages).toHaveLength(8);
  });

  test("the active boundary is rebased on the page, and the totals are not", async () => {
    const engine = await engineWhoseLegacyImportAborted();
    const page = await engine.displayHistoryPage(undefined, { kind: "turns", value: 2 });

    expect(page.activeStart).toBe(0);
    expect(page.globalActiveStart).toBe(4);
    expect(page.totalTurns).toBe(4);

    const whole = await engine.displayHistoryPage(undefined, { kind: "count", value: 100 });
    expect(whole.activeStart).toBe(4);
    expect(whole.totalTurns).toBe(4);
  });
});

describe("a turn budget spent across the archive boundary", () => {
  const msg = (id: string, role: "user" | "assistant"): Message => ({
    msg_id: id,
    role,
    content: id,
    images: [],
    content_blocks: [{ type: "text", text: id }],
    timestamp: "2026-01-01T00:00:00Z",
  });

  async function engineOf(): Promise<ConversationEngine> {
    const root = await mkdtemp(testTmp("shore-boundary-page-"));
    const characterDir = join(root, "TestChar");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });

    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    for (const segment of [0, 1]) {
      store.putSegment(
        "TestChar",
        segment,
        {
          file: `000${segment + 1}.jsonl`,
          message_count: 2,
          compacted_at: "2026-01-01T00:00:00Z",
          compaction_id: `compact-${segment}`,
        },
        [msg(`u${segment}`, "user"), msg(`a${segment}`, "assistant")],
      );
    }
    store.close();

    await writeFile(
      join(characterDir, "threads", "main", "active.jsonl"),
      [msg("ux", "user"), msg("ax", "assistant")].map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
    return await ConversationEngine.load("TestChar", root, () => {});
  }

  test("storage is asked only for the turns the active tail did not cover", async () => {
    const engine = await engineOf();
    const page = await engine.displayHistoryPage(undefined, { kind: "turns", value: 2 });

    expect(page.metrics.storage_native).toBe(true);
    expect(page.cursor).toBe(2);
    expect(page.messages.map((m) => m.msg_id)).toEqual(["u1", "a1", "ux", "ax"]);
    expect(page.activeStart).toBe(2);
  });

  test("a cursor set before an archived user turn hands off at the cursor, not the boundary", async () => {
    const engine = await engineOf();
    const page = await engine.displayHistoryPage(2, { kind: "turns", value: 1 });

    expect(page.cursor).toBe(0);
    expect(page.messages.map((m) => m.msg_id)).toEqual(["u0", "a0"]);
  });

  test("a page wholly inside the active tail reads no archive rows", async () => {
    const engine = await engineOf();
    const page = await engine.displayHistoryPage(undefined, { kind: "count", value: 1 });

    expect(page.cursor).toBe(5);
    expect(page.messages.map((m) => m.msg_id)).toEqual(["ax"]);
    expect(page.activeStart).toBe(0);
  });
});
