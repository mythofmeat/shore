import { expect, test } from "bun:test";

import { assemblePrompt, type PromptParams, type PromptSection } from "../src/engine/prompt.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12);
const NOT_SENT = "[These pictures in your last message were not sent, so only their names were shown:\n- ![[gone]]: no picture matches\nSend a picture again in a new message if you meant to show it.]";

function said(role: Message["role"], words: string | ContentBlock[], minutes: number, extra: Partial<Message> = {}): Message {
  const blocks: ContentBlock[] = typeof words === "string" ? [{ type: "text", text: words }] : words;
  return {
    msg_id: `m${String(minutes)}`,
    role,
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    images: [],
    content_blocks: blocks,
    timestamp: new Date(T0 + minutes * MINUTE).toISOString(),
    ...extra,
  };
}

function prompt(messages: Message[], over: Partial<PromptParams> = {}): ReturnType<typeof assemblePrompt> {
  return assemblePrompt({ character_name: "ada", display_name: "eve", has_prior_context: false, user_timestamp_mode: "never", sections: [], messages, ...over }, "UTC");
}

function shown(messages: Message[], over: Partial<PromptParams> = {}): [role: string, text: string][] {
  return prompt(messages, over).messages.map((message) => [message.role, message.content_blocks.map((block) => block.type === "text" ? block.text : `<${block.type}>`).join("|")]);
}

function sized(tokens: number, letter: string): string {
  return letter.repeat(Math.floor(tokens * 3.2));
}

const OPENING: PromptSection[] = [{
  label: "system_prompt",
  template: true,
  text: "You are {{char}}, in conversation with {{user}}.\nThis is a text conversation. Communicate directly rather than narrating actions or using roleplay formatting.\nBe consistent with established details and avoid fabricating memory.",
}];

const call: ContentBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
const result: ContentBlock = { type: "tool_result", tool_use_id: "t1", content: "done" };

test("a prompt keeps the newest messages that fit its budget, one that fits exactly included, and its newest message even when that alone is too much", () => {
  const small = { max_context_tokens: 2_000, max_output_tokens: 500, sections: OPENING };
  const budget = prompt([], small).messageBudget;
  expect(budget).toBe(1288);
  const kept = (messages: Message[]): string[] => prompt(messages, small).messages.map((message) => `${message.content.slice(0, 1)}${String(message.content.length)}`);

  expect(kept([said("user", sized(10, "a"), 0), said("user", sized(10, "b"), 1), said("user", sized(1278, "c"), 2)])).toEqual(["b32", "c4089"]);
  expect(kept([said("user", sized(10, "a"), 0), said("user", sized(11, "b"), 1), said("user", sized(1278, "c"), 2)])).toEqual(["c4089"]);
  expect(kept([said("user", sized(10, "a"), 0), said("user", sized(1388, "c"), 1)])).toEqual(["c4441"]);
  expect(kept([said("user", sized(10, "a"), 0), said("user", sized(10, "b"), 1), said("user", sized(1268, "c"), 2)])).toEqual(["a32", "b32", "c4057"]);
});

test("a message is sent with the model and key that wrote it, when it has them", () => {
  const messages = prompt([said("user", "hello", 0), said("assistant", "hi", 1, { provider_key: "anthropic", model: "claude-lamp" })]).messages;
  expect(messages).toEqual([
    { role: "user", content: "hello", images: [], content_blocks: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: "hi", images: [], content_blocks: [{ type: "text", text: "hi" }], provider_key: "anthropic", model: "claude-lamp" },
  ]);
  expect(Object.keys(messages[0] ?? {})).toEqual(["role", "content", "images", "content_blocks"]);
});

test("a prompt that would open inside a tool loop opens after it, and one holding nothing else is empty", () => {
  expect(shown([said("assistant", [call], 0), said("user", [result], 1), said("assistant", "The answer.", 2), said("user", "thanks", 3)])).toEqual([
    ["user", "[earlier conversation not shown]"],
    ["assistant", "The answer."],
    ["user", "thanks"],
  ]);
  expect(shown([said("user", [result], 0)])).toEqual([]);
  expect(shown([said("assistant", [call], 0), said("user", [result], 1)])).toEqual([]);
  expect(shown([said("assistant", [{ type: "text", text: "Let me look." }, call], 0), said("user", [result], 1)])).toEqual([
    ["user", "[this conversation starts with your message]"],
    ["assistant", "Let me look.|<tool_use>"],
    ["user", "<tool_result>"],
  ]);
});

test("a thread that opens with the character's own message says so, or that earlier conversation isn't shown when there was some", () => {
  const opened = [said("assistant", "Part one.", 0), said("user", "go on", 1)];
  expect(shown(opened)).toEqual([["user", "[this conversation starts with your message]"], ["assistant", "Part one."], ["user", "go on"]]);
  expect(shown(opened, { has_prior_context: true })).toEqual([["user", "[earlier conversation not shown]"], ["assistant", "Part one."], ["user", "go on"]]);
  expect(shown([said("system", "[A note.]", 0), said("assistant", "Part one.", 1)])).toEqual([["user", "[this conversation starts with your message]"], ["system", "[A note.]"], ["assistant", "Part one."]]);
  expect(shown([said("user", "hello", 0), said("assistant", "hi", 1)])).toEqual([["user", "hello"], ["assistant", "hi"]]);
});

test("pictures of the character's that weren't sent are named above the user's next message, once, and not on a tool's result", () => {
  const gone = { path: "", embed: "![[gone]]", problem: "no picture matches" };
  const messages = [
    said("user", "show me", 0),
    said("assistant", [{ type: "text", text: "Here: ![[gone]]" }, call], 1, { images: [gone] }),
    said("user", [result], 2),
    said("assistant", "That is it.", 3),
    said("user", "I see nothing", 4),
    said("assistant", "Sorry.", 5),
    said("user", "never mind", 6),
  ];
  const built = prompt(messages).messages;
  expect(built.map((message) => message.content_blocks.map((block) => block.type === "text" ? block.text : `<${block.type}>`))).toEqual([
    ["show me"],
    ["Here: ![[gone]]", "<tool_use>"],
    ["<tool_result>"],
    ["That is it."],
    [NOT_SENT, "I see nothing"],
    ["Sorry."],
    ["never mind"],
  ]);
  expect(built[4]?.content).toBe(`${NOT_SENT}\n\nI see nothing`);
  expect(built[2]?.content).toBe("");
});

test("a picture of the user's is never named as one that wasn't sent, and a wake's message is told of the character's own before it", () => {
  const gone = { path: "", embed: "![[gone]]", problem: "no picture matches" };
  expect(shown([said("user", "look", 0, { images: [gone] }), said("assistant", "I see.", 1), said("user", "good", 2)])).toEqual([
    ["user", "look"], ["assistant", "I see."], ["user", "good"],
  ]);
  expect(shown([said("user", "hello", 0), said("assistant", "Here: ![[gone]]", 1, { images: [gone] }), said("assistant", "And another thing.", 2, { origin: "autonomous" })])).toEqual([
    ["user", "hello"],
    ["assistant", "Here: ![[gone]]"],
    ["user", `${NOT_SENT}|[wake]`],
    ["assistant", "And another thing."],
  ]);
});

test("with times always shown every message of the user's says when it was, on its first block of text only, and nothing else does", () => {
  const messages = [
    said("user", [{ type: "text", text: "hello" }, { type: "text", text: "again" }], 0),
    said("assistant", [{ type: "text", text: "Let me look." }, call], 1),
    said("user", [result], 2),
    said("assistant", "hi", 3),
  ];
  const built = prompt(messages, { user_timestamp_mode: "always" }).messages;
  expect(built.map((message) => message.content_blocks.map((block) => block.type === "text" ? block.text : `<${block.type}>`))).toEqual([
    ["[Friday 2026-10-30 · 12:00 PM]\n\nhello", "again"],
    ["Let me look.", "<tool_use>"],
    ["<tool_result>"],
    ["hi"],
  ]);
  expect(built.map((message) => message.content)).toEqual(["[Friday 2026-10-30 · 12:00 PM]\n\nhelloagain", "Let me look.", "[Friday 2026-10-30 · 12:02 PM]\n\n", "hi"]);
});

test("with times never shown no message says when it was, however long the gap", () => {
  expect(shown([said("user", "hello", 0), said("assistant", "hi", 1), said("user", "back", 600)], { has_prior_context: true })).toEqual([
    ["user", "hello"], ["assistant", "hi"], ["user", "back"],
  ]);
});

test("left to Shore, a time is shown after half an hour's gap, once an hour has passed since the last one shown, and on the first message after earlier conversation that isn't shown", () => {
  const auto = { user_timestamp_mode: "auto" as const };
  expect(shown([said("user", "hello", 0), said("assistant", "hi", 1), said("user", "soon", 30), said("user", "sooner", 59.99), said("user", "later", 90)], auto)).toEqual([
    ["user", "hello"],
    ["assistant", "hi"],
    ["user", "soon"],
    ["user", "sooner"],
    ["user", "[about an hour later · Friday 2026-10-30 · 1:30 PM]\n\nlater"],
  ]);
  expect(shown([said("user", "hello", 0), said("user", "exactly", 30)], auto)).toEqual([
    ["user", "hello"],
    ["user", "[about an hour later · Friday 2026-10-30 · 12:30 PM]\n\nexactly"],
  ]);

  const steady = [said("user", "one", 0), said("user", "two", 20), said("user", "three", 40), said("user", "four", 59.99), said("user", "five", 60), said("user", "six", 80)];
  expect(shown(steady, { ...auto, has_prior_context: true })).toEqual([
    ["user", "[Friday 2026-10-30 · 12:00 PM]\n\none"],
    ["user", "two"],
    ["user", "three"],
    ["user", "four"],
    ["user", "[Friday 2026-10-30 · 1:00 PM]\n\nfive"],
    ["user", "six"],
  ]);
  expect(shown(steady.slice(0, 2), auto)).toEqual([["user", "one"], ["user", "two"]]);
});

test("what was cut or archived before the first message shown still counts for how long it has been, and one message cut is enough to say that earlier conversation isn't shown", () => {
  const small = { max_context_tokens: 2_000, max_output_tokens: 500, sections: OPENING };
  const cut = shown([said("user", sized(10, "a"), 0), said("user", sized(1280, "c"), 120)], { ...small, user_timestamp_mode: "auto" });
  expect(cut.map(([role, text]) => [role, text.slice(0, 50)])).toEqual([["user", "[2 hours later · Friday 2026-10-30 · 2:00 PM]\n\nccc"]]);
  expect(shown([said("user", sized(10, "a"), 0), said("assistant", sized(10, "b"), 1), said("user", sized(1278, "c"), 2)], small).map(([role, text]) => [role, text.slice(0, 32)])).toEqual([
    ["user", "[earlier conversation not shown]"],
    ["assistant", "b".repeat(32)],
    ["user", "c".repeat(32)],
  ]);
  expect(shown([said("user", "hello", 0)], { user_timestamp_mode: "auto", has_prior_context: true, archived_last_at: new Date(T0 - 180 * MINUTE).toISOString() })).toEqual([
    ["user", "[3 hours later · Friday 2026-10-30 · 12:00 PM]\n\nhello"],
  ]);
});

test("a message that arrived while a wake was running elsewhere says so above what the user wrote, in its text as well as its blocks", () => {
  const running = '[A wake of yours in "ring" has been running since Friday 2026-10-30 · 11:55 AM. It can\'t see this conversation. It is only told that a message arrived.]';
  const built = prompt([said("user", "hello", 0, { wake_running: { started_at: new Date(T0 - 5 * MINUTE).toISOString(), thread: "ring" } })]).messages;
  expect(built[0]?.content).toBe(`${running}\n\nhello`);
  expect(built[0]?.content_blocks).toEqual([{ type: "text", text: running }, { type: "text", text: "hello" }]);
});

test("the system prompt has a block for each listed part that has something in it, in the order listed", () => {
  const thread = { id: "story", home: "main", created_at: new Date(T0).toISOString(), started_by_you: false, pins: [{ pin: "notes.md", content: "Chapter three." }] };
  const sections: PromptSection[] = [
    { shore: "thread_pins" },
    { label: "MAP.md", text: "- {{char}}'s notes", template: false },
    { label: "system_prompt", text: "You are {{char}}, talking with {{user}}.", template: true },
    { label: "SOUL.md", text: undefined, template: false },
    { label: "USER.md", text: " \n", template: false },
    { shore: "thread" },
  ];
  const full = prompt([said("user", "hi", 0)], { sections, thread }).system;
  expect(full.map((block) => block.label)).toEqual(["thread_pins", "MAP.md", "system_prompt", "thread"]);
  expect(full[1]?.content).toBe("- {{char}}'s notes");
  expect(full[2]?.content).toBe("You are ada, talking with eve.");
  expect(full[3]?.content).toContain(`side thread "story"`);

  expect(prompt([said("user", "hi", 0)], { sections }).system.map((block) => block.label)).toEqual(["MAP.md", "system_prompt"]);
  expect(prompt([said("user", "hi", 0)], { sections, thread: { ...thread, pins: [] } }).system.map((block) => block.label)).toEqual(["MAP.md", "system_prompt", "thread"]);
});
