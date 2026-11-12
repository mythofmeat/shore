import { expect, test } from "bun:test";

import { withoutWakeWorking } from "../src/autonomy/wake_working.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";

const T0 = Date.UTC(2026, 9, 30, 12);

function thread(...parts: [role: Message["role"], blocks: ContentBlock[] | string, origin?: Message["origin"]][]): Message[] {
  return parts.map(([role, said, origin], index) => {
    const blocks: ContentBlock[] = typeof said === "string" ? [{ type: "text", text: said }] : said;
    return {
      msg_id: `m${String(index)}`,
      role,
      content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
      images: [],
      content_blocks: blocks,
      timestamp: new Date(T0 + index * 60_000).toISOString(),
      ...(origin === undefined ? {} : { origin }),
    };
  });
}

function call(name: string, id = name): ContentBlock {
  return { type: "tool_use", id, name, input: {} };
}

function result(id: string, content = "done"): ContentBlock {
  return { type: "tool_result", tool_use_id: id, content };
}

function shown(messages: readonly Message[]): [role: string, text: string][] {
  return withoutWakeWorking(messages).map((message) => [
    message.role,
    message.content_blocks.map((block) => block.type === "text" ? block.text : `<${block.type}>`).join("|"),
  ]);
}

test("a wake that finished is seen later as how it opened, a line counting its tool calls, its note without the thinking, and what it sent", () => {
  const stored = thread(
    ["user", "tell me a story"],
    ["assistant", [call("read", "r0")]],
    ["user", [result("r0")]],
    ["assistant", [{ type: "thinking", thinking: "A fox.", signature: "s0" }, { type: "text", text: "Once there was a fox." }]],
    ["user", "[wake]\n\nThe show.", "autonomous"],
    ["system", "[Their status: asleep]", "autonomous"],
    ["assistant", [{ type: "thinking", thinking: "Where was I?", signature: "s1" }, { type: "text", text: "Let me look." }, call("bash", "b1")]],
    ["user", [result("b1", "a long listing")]],
    ["system", "[System nudge: wrap up.]", "autonomous"],
    ["assistant", [call("read", "r2"), call("write", "w2")]],
    ["user", [result("r2"), result("w2")]],
    ["assistant", [
      { type: "thinking", thinking: "Done now.", signature: "s2" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Told part one.\n[sent to eve as the next message here]" },
    ]],
    ["assistant", "Part one: the fox came to the gate.", "autonomous"],
    ["user", "and then?"],
    ["assistant", [{ type: "thinking", thinking: "Part two.", signature: "s3" }, call("read", "r3")]],
    ["user", [result("r3")]],
    ["assistant", "Then it rained."],
  );
  const seen = withoutWakeWorking(stored);

  expect(seen.slice(0, 6)).toEqual(stored.slice(0, 6));
  expect(seen[6]).toEqual({
    msg_id: "m10",
    role: "system",
    origin: "autonomous",
    content: "[Your working in this wake isn't shown here: 3 tool calls. Your note from the end of it follows.]",
    images: [],
    content_blocks: [{ type: "text", text: "[Your working in this wake isn't shown here: 3 tool calls. Your note from the end of it follows.]" }],
    timestamp: "2026-10-30T12:10:00.000Z",
  });
  expect(seen[7]).toEqual({ ...stored[11], content_blocks: [{ type: "text", text: "Told part one.\n[sent to eve as the next message here]" }] } as Message);
  expect(seen.slice(8)).toEqual(stored.slice(12));
  expect(seen).toHaveLength(13);
});

test("a wake that was stopped is seen later with how far it had got: its tool calls, the last of them, and the last thing the character wrote", () => {
  expect(shown(thread(
    ["user", "[wake]\n\nThe show.", "autonomous"],
    ["assistant", [{ type: "text", text: "  Let me look.\n" }, call("read", "r1")]],
    ["user", [result("r1")]],
    ["system", "[System nudge: wrap up.]", "autonomous"],
    ["assistant", [{ type: "text", text: "  " }, call("bash", "b2")]],
    ["user", [result("b2")]],
    ["system", "[eve wrote here, so Shore stopped it.]", "autonomous"],
    ["user", "wait, what is the fox called?"],
    ["assistant", "Rue."],
  ))).toEqual([
    ["user", "[wake]\n\nThe show."],
    ["system", "[Your working in this wake isn't shown here: 2 tool calls, ending with `bash`. It ended without a note from you. The last thing you wrote in it: \"Let me look.\"]"],
    ["system", "[eve wrote here, so Shore stopped it.]"],
    ["user", "wait, what is the fox called?"],
    ["assistant", "Rue."],
  ]);

  expect(shown(thread(
    ["user", "[wake]", "autonomous"],
    ["assistant", [{ type: "text", text: "Trying the door." }, call("bash", "b1")]],
  ))).toEqual([
    ["user", "[wake]"],
    ["system", "[Your working in this wake isn't shown here: 1 tool call, ending with `bash`. It ended without a note from you. The last thing you wrote in it: \"Trying the door.\"]"],
  ]);

  expect(shown(thread(
    ["user", "[wake]", "autonomous"],
    ["assistant", [call("bash", "b1")]],
    ["user", [result("b1")]],
    ["assistant", [{ type: "thinking", thinking: "Nothing to say.", signature: "s" }, { type: "text", text: " \n" }]],
  ))).toEqual([
    ["user", "[wake]"],
    ["system", "[Your working in this wake isn't shown here: 1 tool call, ending with `bash`. It ended without a note from you.]"],
    ["assistant", " \n"],
  ]);

  expect(shown(thread(
    ["user", "[wake]", "autonomous"],
    ["assistant", [call("bash", "b1")]],
    ["user", [result("b1")]],
    ["assistant", "Sent before it stopped.", "autonomous"],
    ["user", "hm"],
  ))).toEqual([
    ["user", "[wake]"],
    ["system", "[Your working in this wake isn't shown here: 1 tool call, ending with `bash`. It ended without a note from you.]"],
    ["assistant", "Sent before it stopped."],
    ["user", "hm"],
  ]);

  expect(shown(thread(
    ["user", "[wake]", "autonomous"],
    ["user", [result("lost")]],
  ))).toEqual([
    ["user", "[wake]"],
    ["system", "[Your working in this wake isn't shown here: 0 tool calls. It ended without a note from you.]"],
  ]);
});

test("the last thing a stopped wake wrote is cut at 1,500 characters, counted as characters and not as bytes", () => {
  const last = (words: string): string => shown(thread(
    ["user", "[wake]", "autonomous"],
    ["assistant", [{ type: "text", text: words }, call("bash", "b1")]],
  ))[1]?.[1] ?? "";
  const whole = "🦊".repeat(1500);
  expect(last(whole)).toEndWith(`The last thing you wrote in it: "${whole}"]`);
  expect(last(`${whole}!`)).toEndWith(`The last thing you wrote in it: "${whole}… [cut]"]`);
});

test("a wake with nothing but its note keeps the note, and two wakes in a row are each cut down on their own", () => {
  expect(shown(thread(
    ["user", "[wake]\n\nFirst.", "autonomous"],
    ["assistant", [{ type: "thinking", thinking: "Nothing to do.", signature: "s" }, { type: "text", text: "All quiet." }]],
    ["user", "[wake]\n\nSecond.", "autonomous"],
    ["assistant", [call("read", "r1")]],
    ["user", [result("r1")]],
    ["assistant", "Read it."],
    ["user", "[Your message has not been sent yet.]", "autonomous"],
    ["assistant", "Fixed the picture."],
    ["assistant", "Here it is.", "autonomous"],
  ))).toEqual([
    ["user", "[wake]\n\nFirst."],
    ["assistant", "All quiet."],
    ["user", "[wake]\n\nSecond."],
    ["system", "[Your working in this wake isn't shown here: 1 tool call. Your note from the end of it follows.]"],
    ["assistant", "Read it."],
    ["user", "[Your message has not been sent yet.]"],
    ["assistant", "Fixed the picture."],
    ["assistant", "Here it is."],
  ]);
});

test("everything outside a wake is sent as it is stored: a reply's own tool rounds and thinking, and a thread that opens partway through", () => {
  const opensPartway = thread(
    ["assistant", [{ type: "thinking", thinking: "Hm.", signature: "s" }, call("read", "r0")]],
    ["user", [result("r0")]],
    ["assistant", "From before."],
    ["assistant", "A message from a heartbeat.", "autonomous"],
    ["user", "hello"],
    ["assistant", [{ type: "thinking", thinking: "Hi.", signature: "s1" }, call("read", "r1")]],
    ["user", [result("r1")]],
    ["system", "[A note in a reply.]", "autonomous"],
    ["assistant", [{ type: "thinking", thinking: "Hello.", signature: "s2" }, { type: "text", text: "hello to you" }]],
  );
  expect(withoutWakeWorking(opensPartway)).toEqual(opensPartway);
  expect(withoutWakeWorking([])).toEqual([]);

  const onlyOpened = thread(
    ["user", "[heartbeat]\n\nNothing has been said.", "autonomous"],
    ["system", "[Current time: noon]", "autonomous"],
  );
  expect(withoutWakeWorking(onlyOpened)).toEqual(onlyOpened);
});
