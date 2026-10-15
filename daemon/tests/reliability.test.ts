import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { testTmp } from "./support/tmp.ts";
import { writeState, readState } from "../src/storage/store.ts";
import { loadConfig } from "../src/config/loader.ts";
import { setTestEnv, restoreTestEnv } from "./support/env.ts";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { eventMatchesSession } from "../src/swp/routing.ts";
import { parseToolArgs } from "../src/llm/tool_args.ts";
import { type SidecarProvider, type StreamEvent } from "../src/llm/types.ts";
import { runProcess } from "../src/tools/process.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { clear } from "../src/commands/segments.ts";

test("a restored legacy file cannot overwrite authoritative database state", async () => {
  const root = await mkdtemp(testTmp("legacy-conflict-"));
  await mkdir(join(root, "ada"));
  writeState(root, "ada/state", "new DB content", "ada");
  await writeFile(join(root, "ada/state"), "old restored file");
  expect(readState(root, "ada/state")).toBe("new DB content");
  expect(readState(root, "ada/state")).toBe("new DB content");
});

test("invalid config reload does not adopt candidate environment values", async () => {
  const root = await mkdtemp(testTmp("dotenv-invalid-"));
  const path = join(root, "config.toml");
  setTestEnv("SHORE_RELIABILITY_ENV", "running");
  try {
    await writeFile(join(root, ".env"), "SHORE_RELIABILITY_ENV=candidate\n");
    await writeFile(path, "[invalid");
    expect(() => loadConfig(path)).toThrow();
    expect(process.env["SHORE_RELIABILITY_ENV"]).toBe("running");
  } finally { restoreTestEnv(); }
});

test("new messages from a side thread cannot enter the main thread's event stream", async () => {
  const h = await reliabilityGeneration({
    generate: async () => { throw new Error("stream only"); },
    async *stream() {
      yield { type: "done", content: "reply", finish_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
  }, "side");
  await h.run();
  const events = h.frames.filter((frame) => frame.type === "new_message");
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(eventMatchesSession(event, "ada", true, false, "main")).toBe(false);
    expect(eventMatchesSession(event, "ada", true, false, "side")).toBe(true);
  }
});

const TOOL = "mcp__audit__optional";
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
const timing = { total_ms: 1, time_to_first_token_ms: 1 };

function providerFor(input: ReturnType<typeof parseToolArgs>, completedBlocks = false): SidecarProvider {
  let calls = 0;
  return {
    generate: async () => { throw new Error("stream required"); },
    async *stream(): AsyncIterable<StreamEvent> {
      if (calls++ === 0) {
        yield { type: "tool_use", id: "call", name: TOOL, ...input };
        yield { type: "done", content: "", finish_reason: "tool_use", usage, timing,
          ...(completedBlocks ? { content_blocks: [{ type: "tool_use", id: "call", name: TOOL, input: input.input }] } : {}),
        };
      } else {
        yield { type: "done", content: "done", finish_reason: "end_turn", usage, timing };
      }
    },
  };
}

test("cancelling generation reaches an in-flight MCP tool", async () => {
  const h = await reliabilityGeneration(providerFor({ input: {} }));
  h.config.app.tools.enabled_tools = [TOOL];
  const parent = new AbortController();
  let observed: AbortSignal | undefined;
  const mcp = { call: async (_name: string, _input: unknown, signal?: AbortSignal) => {
    observed = signal;
    parent.abort();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    return "settled";
  } };
  h.deps.mcpRegistry = { ...mcp, toolDefsFiltered: () => [{ name: TOOL, description: "optional filters", input_schema: { type: "object" } }] };
  h.deps.tools = () => ({ mcpRegistry: mcp });
  const failure = await h.run(parent.signal).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeDefined();
  expect(observed).toBeDefined();
  expect(observed?.aborted).toBe(true);
});

test("process cancellation kills and reaps a child that ignores SIGTERM", async () => {
  const h = await reliabilityGeneration(providerFor({ input: {} }));
  const ready = join(h.root, "ready");
  const parent = new AbortController();
  const work = runProcess(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});
    await Bun.write(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `, ready], { signal: parent.signal });
  const outcome = work.catch((error: unknown) => error);
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { pid = Number(await readFile(ready, "utf8")); break; } catch {}
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  parent.abort();
  expect(await outcome).toBe(parent.signal.reason);
  expect(pid).toBeDefined();
  expect(() => process.kill(pid ?? 0, 0)).toThrow();
});

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
