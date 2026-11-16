import { expect, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { dispatchLoopTools, type BackgroundLoopResult, type LoopToolResult } from "../src/autonomy/background_loop.ts";
import { postMessage, type Poster, type Sending } from "../src/autonomy/outbox.ts";
import { noteOutcome, roundMessage } from "../src/autonomy/wake.ts";
import type { Message } from "../src/engine/types.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { shoreLog } from "../src/log.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { transparentPng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

const AT = "2026-10-30T12:00:00.000Z";

const ASKED: SidecarRequest = { sdk: "anthropic", model: "claude-lamp", api_key: "k", messages: [], max_tokens: 1024, reasoning_replay: "all", provider_key: "anthropic" };

const UNNAMED: SidecarRequest = { sdk: "anthropic", model: "", api_key: "k", messages: [], max_tokens: 1024, reasoning_replay: "all" };

async function sender() {
  const root = testTmp(`wake-messages-${crypto.randomUUID()}`);
  const dir = join(root, "workspace");
  const sent = join(root, "sent");
  await mkdir(dir, { recursive: true });
  await mkdir(sent, { recursive: true });
  return { dir, pictures: { workspace: new CharacterWorkspace(dir), dir: sent } };
}

interface Posted {
  kept: Message | undefined;
  stored: Message[];
  emitted: [character: string, revision: number, id: string, thread: string][];
  notified: [title: string, body: string][];
  noted: [kind: string, detail: string][];
}

interface Posting {
  asked?: SidecarRequest;
  append?: (message: Message) => Promise<void>;
  push?: Poster["push"];
  dir?: (dir: string) => Promise<void>;
}

async function post(sending: Partial<Sending>, posting: Posting = {}): Promise<Posted> {
  const { dir, pictures } = await sender();
  await posting.dir?.(dir);
  const posted: Posted = { kept: undefined, stored: [], emitted: [], notified: [], noted: [] };
  posted.kept = await postMessage(
    "ada",
    posting.asked ?? ASKED,
    { text: "", images: [], push: false, ...sending },
    {
      newId: () => "m_sent",
      nowIso: () => AT,
      emit: (character, revision, msg, thread) => { posted.emitted.push([character, revision, msg.msg_id, thread]); },
      notify: (title, body) => { posted.notified.push([title, body]); },
      ...(posting.push === undefined ? {} : { push: posting.push }),
    },
    (kind, detail) => { posted.noted.push([kind, detail]); },
    { thread: "main", engine: { appendMessage: posting.append ?? (async (message) => { posted.stored.push(message); }), currentRevision: () => 7 } },
    pictures,
  );
  return posted;
}

test("a message is stored as the character's own, unprompted, with the model that wrote it and any pictures it made", async () => {
  const posted = await post({
    text: "The lamp is lit.",
    images: [{ path: "/sent/lamp.png", caption: "the lamp", data: "QUJD" }, { path: "/sent/bare.png" }],
  });
  const { version, ...message } = posted.stored[0] ?? {};
  expect(message).toStrictEqual({
    msg_id: "m_sent",
    origin: "autonomous",
    role: "assistant",
    content: "The lamp is lit.",
    images: [{ path: "/sent/lamp.png", caption: "the lamp", data: "QUJD" }, { path: "/sent/bare.png" }],
    content_blocks: [{ type: "text", text: "The lamp is lit." }],
    alternatives: [],
    provider_key: "anthropic",
    model: "claude-lamp",
    timestamp: AT,
  });
  expect(version).toBeString();
  expect(posted.stored).toHaveLength(1);
  expect(posted.kept).toBe(posted.stored[0]);
  expect(posted.emitted).toEqual([["ada", 7, "m_sent", "main"]]);
  expect(posted.notified).toEqual([["Shore - ada", "The lamp is lit."]]);
  expect(posted.noted).toEqual([["message_sent", "Autonomous message sent: The lamp is lit."]]);
});

test("a picture embedded in a message goes with it", async () => {
  const posted = await post({ text: "Look: ![[lamp.png]]" }, { dir: async (dir) => { await Bun.write(join(dir, "lamp.png"), transparentPng(16, 16)); } });
  expect(posted.stored[0]?.images.map((image) => [image.name, image.embed])).toEqual([["lamp.png", "![[lamp.png]]"]]);
});

test("a message from a model with no name or provider key is stored without them", async () => {
  const posted = await post({ text: "Hello." }, { asked: UNNAMED });
  const stored = posted.stored[0] ?? {};
  expect(Object.keys(stored).sort()).toEqual(["alternatives", "content", "content_blocks", "images", "msg_id", "origin", "role", "timestamp", "version"]);
});

test("the log shows the first eighty characters of what was sent", async () => {
  const long = `${"a".repeat(79)}bcd and the rest of a long message`;
  const posted = await post({ text: long });
  expect(posted.noted).toEqual([["message_sent", `Autonomous message sent: ${"a".repeat(79)}b`]]);
  expect(posted.notified).toEqual([["Shore - ada", long]]);
});

test("a message that can't be stored isn't shown to clients, and the log says why", async () => {
  const said = spyOn(shoreLog, "error").mockImplementation(() => {});
  try {
    const posted = await post({ text: "The lamp is lit." }, { append: async () => { throw new Error("disk full"); } });
    expect(posted.kept).toBeUndefined();
    expect(posted.emitted).toEqual([]);
    expect(said.mock.calls.map((call) => String(call[0]))).toEqual(["shore: a message for ada could not be delivered to main: Error: disk full"]);
  } finally {
    said.mockRestore();
  }
});

test("a message sent with a push pushes what the user is shown, once it is stored, and the log says when the push didn't go", async () => {
  const pushed: string[] = [];
  const sent = await post({ text: "The lamp is lit.", push: true }, { push: async (message) => { pushed.push(message); return { kind: "sent", nextAt: 0 }; } });
  expect(pushed).toEqual(["The lamp is lit."]);
  expect(sent.noted).toEqual([["message_sent", "Autonomous message sent: The lamp is lit."]]);
  expect((await post({ text: "No push asked." }, { push: async (message) => { pushed.push(message); return { kind: "sent", nextAt: 0 }; } })).noted).toHaveLength(1);
  expect(pushed).toHaveLength(1);

  const late = "The push that went with a message was not sent: by then a push was no longer allowed";
  const tooSoon = await post({ text: "Again.", push: true }, { push: async () => ({ kind: "too_soon", lastAt: 0, nextAt: 1 }) });
  expect(tooSoon.noted).toEqual([["message_sent", "Autonomous message sent: Again."], ["call_failed", late]]);
  expect(tooSoon.stored.map((message) => message.content)).toEqual(["Again."]);
  expect((await post({ text: "Again.", push: true })).noted.at(-1)).toEqual(["call_failed", late]);
  const broke = await post({ text: "Again.", push: true }, { push: async () => { throw new Error(`ntfy said no ${"x".repeat(200)}`); } });
  expect(broke.noted.at(-1)).toEqual(["call_failed", `The push that went with a message failed: Error: ntfy said no ${"x".repeat(100)}…`]);
});

test("a picture a wake's tool made is kept to go with what it sends, and a tool that failed, made none or isn't the picture tool adds nothing", async () => {
  const made = { path: "/media/lamp.png", caption: "the lamp" };
  const answers: Record<string, LoopToolResult> = {
    made: { output: "made the lamp", isError: false, value: made },
    failed: { output: "no credit", isError: true, value: { path: "/media/failed.png" } },
    read: { output: "Ada", isError: false, value: { path: "/media/read.png" } },
    odd: { output: "done", isError: false, value: "not a picture" },
    block: { output: "kept", isError: false, block: { type: "tool_result", tool_use_id: "block", content: [{ type: "text", text: "as given" }] } },
  };
  const noted: string[] = [];
  const run = await dispatchLoopTools(
    [["made", "generate_image", { prompt: "a lamp" }], ["failed", "generate_image", {}], ["read", "read", {}], ["odd", "generate_image", {}], ["block", "read", {}]],
    { dispatch: async (_name, _input, id) => answers[id ?? ""] ?? { output: "", isError: true }, note: (detail) => { noted.push(detail); } },
  );
  expect(run.images).toEqual([{ path: "/media/lamp.png", caption: "the lamp", data: undefined }]);
  expect(run.results).toEqual([
    { type: "tool_result", tool_use_id: "made", content: "made the lamp", is_error: false },
    { type: "tool_result", tool_use_id: "failed", content: "no credit", is_error: true },
    { type: "tool_result", tool_use_id: "read", content: "Ada", is_error: false },
    { type: "tool_result", tool_use_id: "odd", content: "done", is_error: false },
    { type: "tool_result", tool_use_id: "block", content: [{ type: "text", text: "as given" }] },
  ]);
  expect(run.captured.map((tool) => [tool.name, tool.input, tool.output, tool.isError]).slice(0, 2)).toEqual([
    ["generate_image", { prompt: "a lamp" }, "made the lamp", false],
    ["generate_image", {}, "no credit", true],
  ]);
  expect(noted).toEqual(["Tool: generate_image → made the lamp", "Tool: generate_image → no credit", "Tool: read → Ada", "Tool: generate_image → done", "Tool: read → kept"]);
});

function outcome(loop: Partial<BackgroundLoopResult>, nothingSent = true): [kind: string, detail: string][] {
  const noted: [kind: string, detail: string][] = [];
  const said = spyOn(shoreLog, "error").mockImplementation(() => {});
  const told = spyOn(shoreLog, "info").mockImplementation(() => {});
  try {
    noteOutcome("ada", { ...loop }, nothingSent, (kind, detail) => { noted.push([kind, detail]); });
  } finally {
    said.mockRestore();
    told.mockRestore();
  }
  return noted;
}

test("a wake that sent nothing says so in the log, and one whose model call failed says why instead", () => {
  expect(outcome({})).toEqual([["message_skipped", "Wake completed — no message sent"]]);
  expect(outcome({}, false)).toEqual([]);
  expect(outcome({ failedRound: 2, failure: new Error("the provider hung up") })).toEqual([["call_failed", "Model call failed on round 2 — the provider hung up"]]);
  expect(outcome({ failedRound: 0, failure: new Error("x".repeat(300)) })).toEqual([["call_failed", `Model call failed on round 0 — ${"x".repeat(200)}…`]]);
  expect(outcome({ failedRound: 3, failure: new Error("aborted"), timedOut: true })).toEqual([]);
});

test("a wake that a budget stops partway says which budget", () => {
  const blocked = Object.assign(new Error("budget \"beats\" is over its month limit"), { name: "BudgetBlocked", summary: "budget \"beats\" is over its month limit ($4.00/$4.00)" });
  expect(outcome({ failedRound: 1, failure: new Error("generation failed", { cause: blocked }) }, false)).toEqual([
    ["budget_paused", 'Wake paused on round 1 — budget "beats" is over its month limit ($4.00/$4.00)'],
  ]);
  expect(outcome({ failedRound: 1, failure: Object.assign(new Error("over the limit"), { name: "BudgetBlocked" }) })).toEqual([["budget_paused", "Wake paused on round 1 — over the limit"]]);
});

function round(given: Parameters<typeof roundMessage>[0], asked = ASKED): Message {
  return roundMessage(given, asked, { newId: () => "m_round", nowIso: () => AT });
}

test("each round of a wake is stored with the model that answered it, falling back to the model that was asked", () => {
  const blocks = [{ type: "text" as const, text: "Reading the log. ![[lamp.png]]" }];
  expect(round({ role: "assistant", blocks, model: "claude-lamp-20261030" })).toStrictEqual({
    msg_id: "m_round",
    role: "assistant",
    content: "Reading the log. ![[lamp.png]]",
    images: [],
    content_blocks: blocks,
    alternatives: [],
    timestamp: AT,
    provider_key: "anthropic",
    model: "claude-lamp-20261030",
  });
  expect(round({ role: "assistant", blocks, model: "" }).model).toBe("claude-lamp");
  expect(round({ role: "assistant", blocks }).model).toBe("claude-lamp");
  const unnamed = round({ role: "assistant", blocks }, UNNAMED);
  expect(Object.keys(unnamed).sort()).toEqual(["alternatives", "content", "content_blocks", "images", "msg_id", "role", "timestamp"]);
});

test("what Shore adds to a wake is marked as not written by the user, and tool results are left as they are", () => {
  const nudge = round({ role: "system", blocks: [{ type: "text", text: "[System nudge]" }], model: "claude-other" });
  expect(nudge).toStrictEqual({
    msg_id: "m_round", role: "system", content: "[System nudge]", images: [], content_blocks: [{ type: "text", text: "[System nudge]" }],
    alternatives: [], timestamp: AT, origin: "autonomous",
  });
  expect(round({ role: "user", blocks: [{ type: "text", text: "[Something fired.]" }] }).origin).toBe("autonomous");
  const results = round({ role: "user", blocks: [{ type: "tool_result", tool_use_id: "t1", content: "Ada", is_error: false }] });
  expect(Object.keys(results).sort()).toEqual(["alternatives", "content", "content_blocks", "images", "msg_id", "role", "timestamp"]);
});
