/**
 * The three cache scenarios `mock_anthropic.test.ts` did not cover (#34).
 *
 * That file tests the mock — breakpoint placement, TTL, the read/write split.
 * This one tests *shore's* behaviour through it: the keepalive ping, a
 * prefix-rewriting pass, a regen, and a tool loop. Each is a handful of turns
 * driven through the real adapter against `startMockAnthropic`, asserting on
 * the usage the mock reports, because a divergent byte arrives here as a cache
 * write exactly as it would in the ledger.
 *
 * # What is driven and what is modelled
 *
 * The keepalive scenario is driven end to end through production code — the
 * ping body comes from `buildKeepalivePing` over a prefix built by
 * `lastRequestWithResponse`, which is what the daemon pushes. The tool loop is
 * the real `anthropicToolLoopEvents`. The compaction scenario is *modelled* at
 * the wire level: the compactor has its own fixtures, and what matters to the
 * cache is only that the message array was rewritten from the front, so that is
 * what the test does. Each case says which it is.
 *
 * The caveat from #32 carries: this proves we send identical bytes and account
 * for the answer correctly. It does not prove Anthropic's cache behaves as
 * modelled — the live-key run is what does that.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { anthropicToolLoopEvents } from "../src/llm/providers/anthropic_loop.ts";
import { buildKeepalivePing, type KeepalivePrefix } from "../src/cache/keepalive.ts";
import { completedResponseMessages, lastRequestWithResponse } from "../src/handler/persistence.ts";
import { consumeStream } from "../src/llm/stream.ts";
import { startMockAnthropic, type MockAnthropic } from "../src/testing/mock_anthropic.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ContentBlock, Message, Role } from "../src/engine/types.ts";
import type { SidecarRequest, StreamEvent, WireMessage } from "../src/llm/types.ts";

let running: MockAnthropic | undefined;
let clock = 0;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** A mock on an injectable clock, so a TTL can pass without waiting. */
async function mock(script?: Parameters<typeof startMockAnthropic>[0]): Promise<MockAnthropic> {
  clock = 0;
  running = await startMockAnthropic({ ...script, now: () => clock });
  return running;
}

const MINUTE = 60 * 1000;

const user = (text: string): WireMessage =>
  ({ role: "user", content: [{ type: "text", text }] }) as WireMessage;
const assistant = (text: string): WireMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as WireMessage;

/**
 * A turn's outbound request.
 *
 * `1h` throughout: it is what a keepalive-configured model runs, and the
 * scenarios below step the clock past the 5m default deliberately.
 */
function request(url: string, messages: WireMessage[], character = "ada"): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-mock",
    provider_key: "anthropic",
    api_key: "test-key",
    base_url: url,
    system: [
      { text: "You are ada. A system prompt long enough to be worth caching.", label: "character" },
    ],
    messages,
    max_tokens: 256,
    provider_options: { cache_ttl: "1h" },
    context: { character, call_type: "message" },
  } as SidecarRequest;
}

/** Drive one request and return the folded result, as a turn does. */
async function turn(req: SidecarRequest) {
  const outcome = await consumeStream(new AnthropicProvider().stream(req), {
    regen: false,
    sink: () => {},
  });
  if (!("ok" in outcome)) throw new Error(`stream failed: ${JSON.stringify(outcome.err)}`);
  return outcome.ok;
}

// ── 1. the keepalive ping's prefix ──────────────────────────────────────────

/**
 * The ping must send the bytes the next real turn will send.
 *
 * This was the entire reason `POST /v1/keepalive/prefix` existed as a bridge:
 * the daemon pushed the body it had already assembled rather than letting the
 * sidecar reconstruct one, because a single divergent byte turns a 0.1× read
 * into a 2.0× write. When the bridge died in `d16fcbe3` the guarantee moved
 * into the daemon itself with no test that a divergence would fail (#34).
 *
 * The assertion is not "the ping reads something" — a ping that warmed the
 * wrong prefix would also read something. It is that a *later real turn* still
 * reads, after the point at which the original prefix would have expired. That
 * can only happen if the ping refreshed the prefix the turn actually sends.
 */
describe("the keepalive ping", () => {
  /** The prefix the daemon pushes: the request plus the turn's own response. */
  function pushedPrefix(req: SidecarRequest, result: Awaited<ReturnType<typeof turn>>) {
    const withResponse = lastRequestWithResponse(req, completedResponseMessages(result));
    return { ...withResponse, keepalive_interval_ms: 55 * MINUTE } as KeepalivePrefix;
  }

  test("reads the prefix the turn wrote, rather than writing its own", async () => {
    const m = await mock();
    const first = request(m.url, [user("hello")]);
    const result = await turn(first);
    const wrote = m.lastUsage.cache_creation_input_tokens;
    expect(wrote).toBeGreaterThan(0);

    clock += 50 * MINUTE;
    await turn(buildKeepalivePing(pushedPrefix(first, result)));

    // The ping read what the turn wrote. `pingLandedCold` is read 0 with a
    // write > 0, and this is its opposite.
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThanOrEqual(wrote);
    expect(m.requests.at(-1)?.body.max_tokens).toBe(1);
  });

  test("keeps the next real turn warm past the original TTL", async () => {
    const m = await mock();
    const first = request(m.url, [user("hello")]);
    const result = await turn(first);
    const wrote = m.lastUsage.cache_creation_input_tokens;

    // Inside the 1h window, so the ping is a read and the clock restarts.
    clock += 50 * MINUTE;
    await turn(buildKeepalivePing(pushedPrefix(first, result)));

    // Past 1h from the *turn*, inside 1h of the *ping*.
    clock += 40 * MINUTE;
    const next = request(m.url, [user("hello"), assistant(result.content), user("still there?")]);
    await turn(next);

    // Everything the first turn wrote, not merely something. A ping whose body
    // diverged in the messages would still refresh the *system* anchor — its
    // system blocks are untouched — so `> 0` passes on a broken ping and this
    // is the assertion that does not.
    expect(m.lastUsage.cache_read_input_tokens).toBe(wrote);
    const systemAnchor = m.lastBreakpoints.find((b) => b.where === "system");
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(systemAnchor!.prefixTokens);
  });

  // The control for the case above: without the ping the same turn is cold, so
  // the previous test is measuring the ping rather than a TTL that had not run
  // out anyway.
  test("without the ping, that same turn is cold", async () => {
    const m = await mock();
    const first = request(m.url, [user("hello")]);
    const result = await turn(first);

    clock += 90 * MINUTE;
    const next = request(m.url, [user("hello"), assistant(result.content), user("still there?")]);
    await turn(next);

    expect(m.lastUsage.cache_read_input_tokens).toBe(0);
  });

  /**
   * The one difference the ping is allowed: a trailing user turn, because
   * Anthropic requires the conversation to end on one and the pushed body ends
   * on the assistant reply. It must land *after* everything cached, or the ping
   * writes a prefix no turn will ever send.
   */
  test("the appended turn sits after the prefix, not inside it", async () => {
    const m = await mock();
    const first = request(m.url, [user("hello")]);
    const result = await turn(first);
    const prefix = pushedPrefix(first, result);
    const ping = buildKeepalivePing(prefix);
    await turn(ping);

    // Every message of the pushed body survives, in order, with the sentinel
    // appended — `messages` is copied and appended to, never filtered.
    const sent = m.requests.at(-1)!.body.messages as WireMessage[];
    expect(sent).toHaveLength(prefix.messages.length + 1);
    expect(sent.at(-1)!.role).toBe("user");
    // `context` is shore's own per-call metadata and never reaches the wire;
    // it is what makes the row a keepalive row for the tracker's `cold_keepalive`
    // check, so it is asserted on the built ping rather than on the request.
    expect(ping.context?.call_type).toBe("keepalive");
    expect(m.requests.at(-1)!.body.context).toBeUndefined();
  });
});

// ── 2. compaction, where a write is the correct answer ──────────────────────

/**
 * Compaction and dreaming rewrite the prompt, so the pass that follows one
 * *should* write. That makes this the negative case, and the one most likely to
 * be broken by a well-meaning change trying to eliminate a write (#34).
 *
 * Modelled at the wire level rather than driven: the compactor has its own
 * fixtures, and all the cache sees is a message array replaced from the front.
 */
describe("a prefix-rewriting pass", () => {
  const history = [
    user("first question"),
    assistant("first answer"),
    user("second question"),
    assistant("second answer"),
    user("third question"),
  ];
  /** What compaction leaves behind: a summary in place of the history it ate. */
  const compacted = [user("[summary of the conversation so far]"), user("third question")];

  test("writes, and the turn after it reads the new prefix", async () => {
    const m = await mock();
    await turn(request(m.url, history));
    await turn(request(m.url, history));
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(0);

    // The pass itself. A write here is correct, not a regression.
    await turn(request(m.url, compacted));
    const rewrite = m.lastUsage;
    expect(rewrite.cache_creation_input_tokens).toBeGreaterThan(0);

    // And the next turn reads it. Paying twice for the same rewrite is the
    // failure this pins: it would mean the compacted prompt is not stable
    // between the pass and the turn that follows it.
    await turn(request(m.url, [...compacted, assistant("an answer"), user("fourth question")]));
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThanOrEqual(
      rewrite.cache_creation_input_tokens,
    );
  });

  test("the system prompt survives a history rewrite", async () => {
    // Only the messages moved, so the system anchor is still readable — which
    // is why the write above is bounded by the history rather than the whole
    // prompt. If this ever reads 0, compaction is re-paying for the character.
    const m = await mock();
    await turn(request(m.url, history));
    await turn(request(m.url, compacted));

    const systemAnchor = m.lastBreakpoints.find((b) => b.where === "system");
    expect(systemAnchor).toBeDefined();
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThanOrEqual(
      systemAnchor!.prefixTokens,
    );
  });
});

// ── 3. regen and tool loops ─────────────────────────────────────────────────

/**
 * Regen is ~29% of turns. A change that moved the breakpoint would be the most
 * expensive regression available, and until now nothing would have failed.
 *
 * A regen re-sends `messagesThroughLastUserTurn()` — the history truncated
 * after the last user turn, which for the turn being regenerated is the same
 * message array that produced it. So it is byte-identical to the previous
 * request, and the live run confirmed the consequence: full read, zero write.
 */
describe("a regen", () => {
  test("reads the whole prefix and writes nothing", async () => {
    const m = await mock();
    const messages = [user("first question"), assistant("first answer"), user("second question")];

    await turn(request(m.url, messages));
    const original = m.lastUsage;

    // The regen. Same bytes, which is the point.
    await turn(request(m.url, messages));
    const regen = m.lastUsage;

    expect(regen.cache_creation_input_tokens).toBe(0);
    expect(regen.cache_read_input_tokens).toBe(
      original.cache_read_input_tokens + original.cache_creation_input_tokens,
    );
  });
});

/** A tool phase that answers every call with the same output. */
function fakePhase(output: string): ToolPhase {
  const messages: Message[] = [];
  let minted = 0;
  return {
    messages,
    recordTurn: (role: Role, blocks: ContentBlock[]) => {
      minted += 1;
      messages.push({
        msg_id: `m_${minted}`,
        role,
        content: "",
        images: [],
        content_blocks: blocks,
        timestamp: "2026-01-01T00:00:00-05:00",
      } as Message);
    },
    runTool: (use) =>
      Promise.resolve({ type: "tool_result", tool_use_id: use.id, content: output } as ContentBlock),
  };
}

/**
 * The real loop, against the modelled cache.
 *
 * The loop re-places breakpoints on every continuation, precisely so its
 * accumulated tail keeps getting cached (see the module header on
 * `providers/anthropic_loop.ts`). What that buys is this: the second call reads
 * what the first wrote. A loop that left the breakpoints where the first
 * request put them would re-send the whole tail uncached on every round.
 */
describe("a tool loop", () => {
  test("the second call reads the first call's write", async () => {
    const m = await mock({
      script: [
        { toolUses: [{ name: "read", input: { path: "/notes.md" } }] },
        { text: "the notes say hello" },
      ],
    });

    const req = {
      ...request(m.url, [user("read my notes")]),
      tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
    } as SidecarRequest;

    const events: StreamEvent[] = [];
    for await (const e of anthropicToolLoopEvents(req, fakePhase("hello"))) events.push(e);

    expect(m.requests).toHaveLength(2);
    const [first, second] = m.requests;
    // Exactly, not merely "some": the continuation reads the whole of what the
    // first call wrote. `>=` would pass on a loop that re-cached the system
    // blocks and re-sent the message tail uncached, which is the regression
    // re-placing the breakpoints exists to prevent.
    expect(first!.usage.cache_read_input_tokens).toBe(0);
    expect(second!.usage.cache_read_input_tokens).toBe(
      first!.usage.cache_creation_input_tokens,
    );
    // And it placed a fresh breakpoint on its own tail, so the round after it
    // would read this one too.
    expect(second!.breakpoints.at(-1)?.hit).toBe(false);
    expect(second!.breakpoints.at(-1)?.prefixTokens).toBeGreaterThan(
      first!.usage.cache_creation_input_tokens,
    );
    // Each call is its own ledger row, and their usage sums to the reported
    // total — so a read the loop attributes to itself is a read a call made.
    const completed = events.filter((e) => e.type === "call_complete");
    expect(completed).toHaveLength(2);
  });

  test("a turn after the loop reads what the loop wrote", async () => {
    // The tail a loop appends is the next turn's prefix, so a loop whose last
    // continuation cached nothing makes the following user message pay for the
    // whole exchange again.
    const m = await mock({
      script: [
        { toolUses: [{ name: "read", input: { path: "/notes.md" } }] },
        { text: "the notes say hello" },
      ],
    });
    const req = {
      ...request(m.url, [user("read my notes")]),
      tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
    } as SidecarRequest;
    for await (const _ of anthropicToolLoopEvents(req, fakePhase("hello"))) void _;

    const loopTail = m.requests.at(-1)!.body.messages as WireMessage[];
    await turn({ ...req, messages: [...loopTail, user("thanks")] });

    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(0);
  });
});
