import { describe, expect, test } from "bun:test";

import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { encodeServerMessage, OutboundQueue } from "../src/swp/outbound.ts";
import { required } from "../src/util/required.ts";

const chunk = (text: string, stream: { rid?: string; content_type?: string; subagent?: string; task_id?: string } = {}): ServerMessage =>
  ({ type: "stream_chunk", rid: "r", content_type: "text", subagent: null, task_id: null, ...stream, text });
const history = (padding: string): ServerMessage => ({ type: "history", messages: [], config: padding, revision: 0 });
const ping: ServerMessage = { type: "ping" };
const size = (message: ServerMessage): number => encodeServerMessage(message).bytes;
const sized = (bytes: number, rid = "sized"): ServerMessage => {
  const message = chunk("", { rid });
  return chunk("s".repeat(bytes - size(message)), { rid });
};

function drain(queue: OutboundQueue): ServerMessage[] {
  const out: ServerMessage[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) out.push(next);
  return out;
}

describe("what a client's outgoing queue holds", () => {
  test("a queue without limits takes everything and gives it back in order", () => {
    const queue = new OutboundQueue();
    const sent = Array.from({ length: 300 }, (_, i) => chunk(String(i)));
    for (const message of sent) expect(queue.push(message)).toBe(true);
    expect(queue.length).toBe(300);
    expect(drain(queue)).toEqual(sent);
    expect(queue.length).toBe(0);
  });

  test("live messages are capped by count, and each one taken frees its place", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((rid) => chunk(rid, { rid }));
    const queue = new OutboundQueue({ messages: 2, bytes: Infinity });
    expect([queue.push(required(a)), queue.push(required(b)), queue.push(required(c))]).toEqual([true, true, false]);
    expect(queue.shift()).toBe(required(a));
    expect([queue.push(required(c)), queue.push(required(d))]).toEqual([true, false]);
    expect(drain(queue)).toEqual([required(b), required(c)]);
  });

  test("live messages are capped by their encoded size, and each one taken gives its bytes back", () => {
    const a = sized(300, "a");
    const b = sized(200, "b");
    const queue = new OutboundQueue({ messages: 100, bytes: 500 });
    expect([queue.push(a), queue.push(b), queue.push(ping)]).toEqual([true, true, false]);
    expect(queue.shift()).toBe(a);
    expect([queue.push(a), queue.push(ping)]).toEqual([true, false]);
    expect(drain(queue)).toEqual([b, a]);
  });

  test("a history bigger than the byte budget goes out alone, without using the budget, when the queue allows that", () => {
    const big = history("x".repeat(500));
    const bigger = history("y".repeat(900));
    const queue = new OutboundQueue({ messages: 10, bytes: 200, largeHistory: true });
    expect([queue.push(big), queue.push(bigger), queue.push(sized(200))]).toEqual([true, false, true]);
    expect(queue.shift()).toBe(big);
    expect([queue.push(bigger), queue.push(big)]).toEqual([true, false]);
    expect(drain(queue)).toEqual([sized(200), bigger]);
  });

  test("a history that fits the budget is counted like anything else, and only histories may go over it", () => {
    const fits = history("x".repeat(200 - size(history(""))));
    expect(size(fits)).toBe(200);
    const allowing = new OutboundQueue({ messages: 10, bytes: 200, largeHistory: true });
    expect([allowing.push(fits), allowing.push(ping)]).toEqual([true, false]);
    expect(new OutboundQueue({ messages: 10, bytes: 200, largeHistory: true }).push(sized(201))).toBe(false);
    expect(new OutboundQueue({ messages: 10, bytes: 200 }).push(history("x".repeat(500)))).toBe(false);
  });
});

describe("a client's outgoing stream text", () => {
  test("joins only onto the stream chunk right before it, from the same reply, kind, helper and task", () => {
    const other = { rid: "other" };
    const thinking = { ...other, content_type: "thinking" };
    const helper = { ...thinking, subagent: "helper" };
    const task = { ...helper, task_id: "task" };
    const queue = new OutboundQueue({ messages: 20, bytes: Infinity, coalesceStreams: true });
    for (const message of [
      chunk("a"), chunk("b"), chunk("c", other), chunk("d", thinking), chunk("e", helper), chunk("f", task), chunk("g", task), ping, chunk("h", task),
    ]) expect(queue.push(message)).toBe(true);
    expect(drain(queue)).toEqual([chunk("ab"), chunk("c", other), chunk("d", thinking), chunk("e", helper), chunk("fg", task), ping, chunk("h", task)]);
    const separate = new OutboundQueue({ messages: 20, bytes: Infinity });
    for (const message of [chunk("a"), chunk("b")]) separate.push(message);
    expect(drain(separate)).toEqual([chunk("a"), chunk("b")]);
  });

  test("joined text counts by the bytes it adds, and leaves the queue with them", () => {
    const first = chunk("a");
    const budget = size(first) + 2;
    const queue = new OutboundQueue({ messages: 10, bytes: budget, coalesceStreams: true });
    expect([queue.push(first), queue.push(chunk("bc")), queue.push(chunk("d"))]).toEqual([true, true, false]);
    expect(drain(queue)).toEqual([chunk("abc")]);
    expect([queue.push(sized(budget, "x")), queue.push(chunk("e", { rid: "other" }))]).toEqual([true, false]);
  });

  test("text that would take a joined chunk over the budget is refused and the chunk is left as it was", () => {
    const queue = new OutboundQueue({ messages: 10, bytes: size(chunk("ab")), coalesceStreams: true });
    expect([queue.push(chunk("a")), queue.push(chunk("b")), queue.push(chunk("c"))]).toEqual([true, true, false]);
    expect(drain(queue)).toEqual([chunk("ab")]);
  });
});

describe("catching a client up", () => {
  test("what is sent to catch a client up is never refused and leaves the whole live budget free", () => {
    const caught = [history("x".repeat(5000)), ...Array.from({ length: 300 }, (_, i) => chunk(String(i), { rid: String(i % 2) }))];
    const live = sized(100, "live");
    const queue = new OutboundQueue({ messages: 1, bytes: 100, largeHistory: true, coalesceStreams: true });
    for (const message of caught) expect(queue.push(message, true)).toBe(true);
    expect([queue.push(live), queue.push(ping)]).toEqual([true, false]);
    for (const message of caught) expect(queue.shift()).toBe(message);
    expect(queue.push(ping)).toBe(false);
    expect(drain(queue)).toEqual([live]);
  });

  test("taking what caught a client up gives back no budget it never used", () => {
    const counted = new OutboundQueue({ messages: 1, bytes: Infinity });
    const bounded = new OutboundQueue({ messages: 10, bytes: 100 });
    const allowing = new OutboundQueue({ messages: 10, bytes: 100, largeHistory: true });
    for (const queue of [counted, bounded]) {
      for (const message of [chunk("a"), chunk("b"), chunk("c"), chunk("d")]) queue.push(message, true);
      expect(drain(queue)).toEqual([chunk("a"), chunk("b"), chunk("c"), chunk("d")]);
    }
    expect([counted.push(chunk("e")), counted.push(chunk("f", { rid: "f" }))]).toEqual([true, false]);
    expect([bounded.push(sized(104)), bounded.push(sized(100))]).toEqual([false, true]);
    allowing.push(history("x".repeat(500)), true);
    allowing.shift();
    expect([allowing.push(history("y".repeat(500))), allowing.push(history("z".repeat(500)))]).toEqual([true, false]);
  });
});

test("clearing a queue empties it and frees its whole budget", () => {
  const big = history("x".repeat(500));
  const queue = new OutboundQueue({ messages: 2, bytes: 200, largeHistory: true });
  expect([queue.push(big), queue.push(sized(200)), queue.push(chunk("caught"), true)]).toEqual([true, true, true]);
  queue.clear();
  expect(queue.length).toBe(0);
  expect(queue.shift()).toBeUndefined();
  expect([queue.push(history("y".repeat(500))), queue.push(sized(200)), queue.push(ping)]).toEqual([true, true, false]);
});
