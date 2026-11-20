import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { testTmp } from "./support/tmp.ts";
import { untilAsync } from "./support/until.ts";
import { shoreLog } from "../src/log.ts";
import { writeState, readState } from "../src/storage/store.ts";
import { loadConfig } from "../src/config/loader.ts";
import { setTestEnv, restoreTestEnv } from "./support/env.ts";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { runGeneration } from "../src/handler/generation.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { eventMatchesSession } from "../src/swp/routing.ts";
import { parseToolArgs } from "../src/llm/tool_args.ts";
import { type SidecarProvider, type StreamEvent } from "../src/llm/types.ts";
import { runProcess } from "../src/tools/process.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { runCompactionPass } from "../src/memory/compaction/run.ts";

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
  h.config.app.tools.enabled = [TOOL];
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

const CANCEL_GUARD_MS = 15_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loopLag(): { worstMs: () => number; stop: () => void } {
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 20);
    last = now;
  }, 20);
  return { worstMs: () => Math.round(worst), stop: () => { clearInterval(timer); } };
}

test("process cancellation kills and reaps a child that ignores SIGTERM", async () => {
  const h = await reliabilityGeneration(providerFor({ input: {} }));
  const ready = join(h.root, "ready");
  const parent = new AbortController();
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  const lag = loopLag();
  try {
    const work = runProcess(process.execPath, ["-e", `
      process.on("SIGTERM", () => {});
      await Bun.write(process.argv[1], String(process.pid));
      setInterval(() => {}, 1000);
    `, ready], { signal: parent.signal });
    const outcome = work.catch((error: unknown) => error);
    let pid = 0;
    await untilAsync(async () => {
      pid = Number(await readFile(ready, "utf8").catch(() => ""));
      return pid > 0;
    }, "the child writing its pid");

    const cancelled = performance.now();
    parent.abort();
    const guard = Promise.withResolvers<"still running">();
    const guarding = setTimeout(() => { guard.resolve("still running"); }, CANCEL_GUARD_MS);
    const reaped = await Promise.race([outcome, guard.promise]);
    clearTimeout(guarding);
    if (reaped === "still running") {
      const state = alive(pid) ? "it is still alive" : "it is gone but its output never closed";
      if (alive(pid)) process.kill(-pid, "SIGKILL");
      throw new Error(
        `the child was not reaped ${String(Math.round(performance.now() - cancelled))} ms after it was cancelled: ${state}; ` +
        `the event loop ran up to ${String(lag.worstMs())} ms late; signals that could not be sent: ${JSON.stringify(warned.mock.calls.map((call) => String(call[0])))}`,
      );
    }
    expect(reaped).toBe(parent.signal.reason);
    expect(alive(pid)).toBe(false);
    expect(warned.mock.calls).toEqual([]);
  } finally {
    lag.stop();
    warned.mockRestore();
  }
}, 2 * CANCEL_GUARD_MS);

test("a signal that can't be sent to a cancelled process is logged, and the process is reaped once one gets through", async () => {
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  const send = process.kill.bind(process);
  let refused = 0;
  const kills = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === "SIGTERM" && refused === 0) {
      refused += 1;
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    return send(pid, signal);
  });
  try {
    const parent = new AbortController();
    const outcome = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { signal: parent.signal }).catch((error: unknown) => error);
    parent.abort();
    expect(await outcome).toBe(parent.signal.reason);
    expect(warned.mock.calls.map((call) => String(call[0]).replace(/process \d+/, "process N"))).toEqual(["shore: could not send SIGTERM to process N: Error: kill EPERM"]);
  } finally {
    kills.mockRestore();
    warned.mockRestore();
  }
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

test("an archive started while a reply is running waits for the reply, and archives it with the rest", async () => {
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
  const archiving = runCompactionPass("ada", { config: h.config }, { keepTurnsOverride: 0 });
  await delay(20);
  paused.release();
  await Promise.all([running, archiving]);
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

test("a reply that fails partway is reported only once what it already streamed has reached the client, and a frame that can't reach it doesn't hide why the reply failed", async () => {
  const h = await reliabilityGeneration({
    generate: async () => { throw new Error("stream only"); },
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text", text: "Half of it" };
      throw Object.assign(new Error("the model went away"), { status: 400 });
    },
  });
  const failing = (send: (frame: ServerMessage) => Promise<void>, logged: string[] = []) => runGeneration({ ...h.deps, log: { error: (message) => { logged.push(message); } } }, {
    meta: { session: { sessionId: 1 } } as never,
    body: { rid: null, text: "hello", stream: true, images: [], image_data: [] },
    regen: false, charName: "ada", rid: null, signal: new AbortController().signal, send,
  }).then(() => "finished", (error: unknown) => String(error));

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const delivered: string[] = [];
  const reported = failing(async (frame) => {
    if (frame.type === "stream_chunk") await held;
    delivered.push(frame.type);
  });
  expect(await Promise.race([reported.then(() => "reported"), Bun.sleep(300).then(() => "waiting")])).toBe("waiting");
  release();
  expect(await reported).toContain("the model went away");
  expect(delivered).toContain("stream_chunk");

  const logged: string[] = [];
  expect(await failing(async () => { throw new Error("the socket closed"); }, logged)).toContain("the model went away");
  expect(logged).toEqual(["generation frame delivery failed"]);
});
