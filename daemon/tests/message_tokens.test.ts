import { expect, test } from "bun:test";

import { estimateMessageTokens } from "../src/engine/prompt.ts";
import type { Message } from "../src/engine/types.ts";

const UNREADABLE_PICTURE = 4784;

function said(extra: Partial<Message> = {}): Message {
  return { msg_id: "m", role: "user", content: "hello there", images: [], content_blocks: [{ type: "text", text: "hello there" }], timestamp: "2026-10-30T12:00:00.000Z", ...extra };
}

test("a message's size counts its words and each picture attached to it, a picture Shore can't measure at the most one can cost", () => {
  const lamp = { path: "/nowhere/lamp.png" };
  expect(estimateMessageTokens(said())).toBe(4);
  expect(estimateMessageTokens(said({ images: [lamp] }))).toBe(4 + UNREADABLE_PICTURE);
  expect(estimateMessageTokens(said({ images: [lamp, { path: "/nowhere/door.png" }] }))).toBe(4 + 2 * UNREADABLE_PICTURE);
});

test("a picture embedded in a message's text, or riding on a tool's result, isn't counted again as an attachment", () => {
  expect(estimateMessageTokens(said({ images: [{ path: "/nowhere/lamp.png", embed: "![[lamp.png]]" }] }))).toBe(4);
  expect(estimateMessageTokens(said({ images: [{ path: "/nowhere/lamp.png", embed: "![[lamp.png]]" }, { path: "/nowhere/door.png" }] }))).toBe(4 + UNREADABLE_PICTURE);
  const result = said({ content: "", content_blocks: [{ type: "tool_result", tool_use_id: "t", content: "done" }], images: [{ path: "/nowhere/lamp.png" }] });
  expect(estimateMessageTokens(result)).toBe(2);
});
