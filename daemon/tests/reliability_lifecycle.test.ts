import { expect, test } from "bun:test";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { clear } from "../src/commands/segments.ts";
import type { StreamEvent } from "../src/llm/types.ts";

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}
const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const done = (content = "reply"): StreamEvent => ({
  type: "done", content, finish_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
  timing: { total_ms: 1, time_to_first_token_ms: 1 },
});
const plain = { generate: async () => { throw new Error("stream only"); }, async *stream() { yield done(); } };

async function seed(engine: ConversationEngine, count: number) {
  for (let i = 0; i < count; i += 1) await engine.appendMessage({
    msg_id: `seed-${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `seed ${i}`,
    content_blocks: [{ type: "text", text: `seed ${i}` }], images: [], timestamp: new Date().toISOString(),
  });
}

test("concurrent generation requests own complete turns in submission order", async () => {
  const first = gate();
  const started = gate();
  let calls = 0;
  const h = await reliabilityGeneration({ ...plain, async *stream() {
    const call = ++calls;
    if (call === 1) { started.release(); await first.ready; }
    yield done(`reply ${call}`);
  } });
  const a = h.run(undefined, "A");
  await started.ready;
  const b = h.run(undefined, "B");
  await delay(20);
  const inFlight = calls;
  first.release();
  await Promise.all([a, b]);
  expect(inFlight).toBe(1);
  expect(h.engine.messages().map((message) => message.content)).toEqual(["A", "reply 1", "B", "reply 2"]);
});

test("clear cannot be undone by a generation that was already running", async () => {
  const paused = gate();
  const started = gate();
  const h = await reliabilityGeneration({ ...plain, async *stream(_request, signal) {
    signal?.addEventListener("abort", paused.release, { once: true });
    started.release();
    await paused.ready;
    yield done("stale reply");
  } });
  const running = h.run().catch(() => {});
  await started.ready;
  const clearing = clear(h.engine, { dataDir: h.config.dirs.data }, {});
  await delay(20);
  paused.release();
  await Promise.all([running, clearing]);
  expect(h.engine.messages()).toEqual([]);
});

test("an edit cancels the active turn and invalidates turns queued before the edit", async () => {
  const started = gate();
  const release = gate();
  let calls = 0;
  const h = await reliabilityGeneration({ ...plain, async *stream(_request, signal) {
    calls += 1;
    signal?.addEventListener("abort", release.release, { once: true });
    started.release();
    await release.ready;
    yield done("obsolete");
  } });
  const first = h.run(undefined, "original").catch(() => {});
  await started.ready;
  const queued = h.run(undefined, "queued").catch(() => {});
  await delay(10);
  await h.engine.editMessage(h.engine.messages()[0]?.msg_id ?? "missing", "corrected");
  await Promise.all([first, queued]);
  expect(calls).toBe(1);
  expect(h.engine.messages().map((message) => message.content)).toEqual(["corrected"]);
});

test("a running turn does not block a different conversation", async () => {
  const started = gate();
  const release = gate();
  const h = await reliabilityGeneration({ ...plain, async *stream() {
    started.release();
    await release.ready;
    yield done();
  } });
  const running = h.run();
  await started.ready;
  const side = await ConversationEngine.load("ada", h.config.dirs.data, undefined, "side");
  try {
    await seed(side, 2);
    expect(side.messageCount()).toBe(2);
  } finally {
    release.release();
    await running;
  }
});
