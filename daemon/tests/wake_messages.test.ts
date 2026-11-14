import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { BackgroundLoopResult } from "../src/autonomy/background_loop.ts";
import { postWakeMessage, roundMessage } from "../src/autonomy/wake.ts";
import type { Message } from "../src/engine/types.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
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

async function post(loop: Partial<BackgroundLoopResult>, asked = ASKED, append?: (message: Message) => Promise<void>): Promise<Posted> {
  const { pictures } = await sender();
  const posted: Posted = { kept: undefined, stored: [], emitted: [], notified: [], noted: [] };
  posted.kept = await postWakeMessage(
    "ada",
    asked,
    { sendMessageText: undefined, images: [], rounds: 1, ...loop },
    {
      newId: () => "m_sent",
      nowIso: () => AT,
      emit: (character, revision, msg, thread) => { posted.emitted.push([character, revision, msg.msg_id, thread]); },
      notify: (title, body) => { posted.notified.push([title, body]); },
    },
    (kind, detail) => { posted.noted.push([kind, detail]); },
    { thread: "main", engine: { appendMessage: append ?? (async (message) => { posted.stored.push(message); }), currentRevision: () => 7 } },
    pictures,
  );
  return posted;
}

test("what a wake sends is stored as the character's own message, with the model that wrote it and any pictures it made", async () => {
  const posted = await post({
    sendMessageText: "The lamp is lit.",
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

test("a message from a model with no name or provider key is stored without them", async () => {
  const posted = await post({ sendMessageText: "Hello." }, UNNAMED);
  const stored = posted.stored[0] ?? {};
  expect(Object.keys(stored).sort()).toEqual(["alternatives", "content", "content_blocks", "images", "msg_id", "origin", "role", "timestamp", "version"]);
});

test("the log shows the first eighty characters of what a wake sent", async () => {
  const long = `${"a".repeat(79)}bcd and the rest of a long message`;
  const posted = await post({ sendMessageText: long });
  expect(posted.noted).toEqual([["message_sent", `Autonomous message sent: ${"a".repeat(79)}b`]]);
  expect(posted.notified).toEqual([["Shore - ada", long]]);
});

test("a message that can't be stored isn't shown to clients, and the wake is told nothing was kept", async () => {
  const posted = await post({ sendMessageText: "The lamp is lit." }, ASKED, async () => { throw new Error("disk full"); });
  expect(posted.kept).toBeUndefined();
  expect(posted.emitted).toEqual([]);
});

test("a wake that sent nothing says so in the log, and one whose model call failed says why instead", async () => {
  expect((await post({})).noted).toEqual([["message_skipped", "Wake completed — no message sent"]]);
  const failed = await post({ failedRound: 2, failure: new Error("the provider hung up") });
  expect(failed.noted).toEqual([["call_failed", "Model call failed on round 2 — the provider hung up"]]);
  expect(failed.stored).toEqual([]);
  expect(failed.kept).toBeUndefined();
  const long = await post({ failedRound: 0, failure: new Error("x".repeat(300)) });
  expect(long.noted).toEqual([["call_failed", `Model call failed on round 0 — ${"x".repeat(200)}…`]]);
  const timedOut = await post({ failedRound: 3, failure: new Error("aborted"), timedOut: true });
  expect(timedOut.noted).toEqual([]);
});

test("a wake that a budget stops partway says which budget, and still sends what it had written", async () => {
  const blocked = Object.assign(new Error("budget \"beats\" is over its month limit"), { name: "BudgetBlocked", summary: "budget \"beats\" is over its month limit ($4.00/$4.00)" });
  const paused = await post({ failedRound: 1, failure: new Error("generation failed", { cause: blocked }), sendMessageText: "Half done." });
  expect(paused.noted).toEqual([
    ["budget_paused", 'Wake paused on round 1 — budget "beats" is over its month limit ($4.00/$4.00)'],
    ["message_sent", "Autonomous message sent: Half done."],
  ]);
  expect(paused.stored.map((message) => message.content)).toEqual(["Half done."]);
  const bare = await post({ failedRound: 1, failure: Object.assign(new Error("over the limit"), { name: "BudgetBlocked" }) });
  expect(bare.noted).toEqual([["budget_paused", "Wake paused on round 1 — over the limit"]]);
});

async function round(given: Parameters<typeof roundMessage>[0], asked = ASKED): Promise<Message> {
  const { pictures } = await sender();
  return await roundMessage(given, asked, { newId: () => "m_round", nowIso: () => AT }, pictures);
}

test("each round of a wake is stored with the model that answered it, falling back to the model that was asked", async () => {
  const blocks = [{ type: "text" as const, text: "Reading the log." }];
  expect(await round({ role: "assistant", blocks, model: "claude-lamp-20261030" })).toStrictEqual({
    msg_id: "m_round",
    role: "assistant",
    content: "Reading the log.",
    images: [],
    content_blocks: blocks,
    alternatives: [],
    timestamp: AT,
    provider_key: "anthropic",
    model: "claude-lamp-20261030",
  });
  expect((await round({ role: "assistant", blocks, model: "" })).model).toBe("claude-lamp");
  expect((await round({ role: "assistant", blocks })).model).toBe("claude-lamp");
  const unnamed = await round({ role: "assistant", blocks }, UNNAMED);
  expect(Object.keys(unnamed).sort()).toEqual(["alternatives", "content", "content_blocks", "images", "msg_id", "role", "timestamp"]);
});

test("what Shore adds to a wake is marked as not written by the user, and tool results are left as they are", async () => {
  const nudge = await round({ role: "system", blocks: [{ type: "text", text: "[System nudge]" }], model: "claude-other" });
  expect(nudge).toStrictEqual({
    msg_id: "m_round", role: "system", content: "[System nudge]", images: [], content_blocks: [{ type: "text", text: "[System nudge]" }],
    alternatives: [], timestamp: AT, origin: "autonomous",
  });
  expect((await round({ role: "user", blocks: [{ type: "text", text: "[Your message has not been sent yet.]" }] })).origin).toBe("autonomous");
  const results = await round({ role: "user", blocks: [{ type: "tool_result", tool_use_id: "t1", content: "Ada", is_error: false }] });
  expect(Object.keys(results).sort()).toEqual(["alternatives", "content", "content_blocks", "images", "msg_id", "role", "timestamp"]);
});

test("a round that sends a picture keeps it with the round, and a round that only mentions one does not", async () => {
  const { dir, pictures } = await sender();
  await Bun.write(join(dir, "lamp.png"), transparentPng(16, 16));
  const deps = { newId: () => "m_round", nowIso: () => AT };
  const sent = await roundMessage({ role: "assistant", blocks: [{ type: "text", text: "Done.\n<sendMessage>Look: ![[lamp.png]]</sendMessage>" }] }, ASKED, deps, pictures);
  expect(sent.images.map((image) => [image.name, image.embed])).toEqual([["lamp.png", "![[lamp.png]]"]]);
  const mentioned = await roundMessage({ role: "assistant", blocks: [{ type: "text", text: "I could send ![[lamp.png]] later." }] }, ASKED, deps, pictures);
  expect(mentioned.images).toEqual([]);
  const quoted = await roundMessage({ role: "user", blocks: [{ type: "text", text: "<sendMessage>![[lamp.png]]</sendMessage>" }] }, ASKED, deps, pictures);
  expect(quoted.images).toEqual([]);
});
