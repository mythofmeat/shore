import { describe, expect, test } from "bun:test";

import type { ContentBlock } from "../src/engine/types.ts";
import { MAX_REQUEST_IMAGES } from "../src/llm/image_support.ts";
import { withToolImages, type ImagePolicy } from "../src/llm/tool_images.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest, StreamEvent, WireMessage } from "../src/llm/types.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import { required } from "../src/util/required.ts";

const GIF = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
const image = (): ContentBlock => ({ type: "image", source: { type: "base64", media_type: "image/gif", data: GIF } });
const pictured = (count = 1): WireMessage => ({ role: "user", content: [{ type: "text", text: "look" }, ...Array.from({ length: count }, image)] });
const REFUSED = Object.assign(new Error("this model does not support image input"), { status: 400 });

function request(messages: WireMessage[] = [pictured()]): SidecarRequest {
  return { sdk: "openai", provider_key: "local", model: "m", api_key: "k", max_tokens: 8, reasoning_replay: "all", messages };
}


const done: GenerateResponse = { content: "", content_blocks: [], finish_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 0, time_to_first_token_ms: 0 }, model: "m" };

const errorEvent = (message: string, cause: unknown): StreamEvent => ({ type: "error", message, cause, usage: done.usage, timing: done.timing });

interface Seen {
  calls: SidecarRequest[];
  rejected: SidecarRequest[];
  warnings: string[];
}

function world(script: ((req: SidecarRequest) => AsyncIterable<StreamEvent>)[], support?: boolean): { wrapped: SidecarProvider; seen: Seen } {
  const seen: Seen = { calls: [], rejected: [], warnings: [] };
  const provider: SidecarProvider = {
    stream: (req) => {
      seen.calls.push(req);
      const next = script.shift();
      if (next === undefined) throw new Error("no more streams scripted");
      return next(req);
    },
    generate: (req) => {
      seen.calls.push(req);
      return Promise.resolve(done);
    },
  };
  const policy: ImagePolicy = { support: () => support, rejected: (req) => seen.rejected.push(req), warn: (message) => seen.warnings.push(message) };
  return { wrapped: withToolImages(provider, policy), seen };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const images = (req: SidecarRequest | undefined): number => (req?.messages ?? []).flatMap((message) => message.content).filter((block) => block.type === "image").length;

async function* events(...list: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of list) {
    await Promise.resolve();
    yield event;
  }
}

async function* failing(before: StreamEvent[], error: unknown): AsyncIterable<StreamEvent> {
  for (const event of before) yield event;
  await Promise.resolve();
  throw error;
}

describe("pictures on their way to a provider", () => {
  test("a request within the limits goes as it is, and one past them goes with the oldest pictures left out and one warning however often it happens", async () => {
    const { wrapped, seen } = world([]);
    const small = request();
    await wrapped.generate(small);
    expect(seen.calls[0]).toBe(small);
    const crowded = request(Array.from({ length: MAX_REQUEST_IMAGES + 1 }, () => pictured()));
    await wrapped.generate(crowded);
    expect(seen.warnings).toHaveLength(1);
    await wrapped.generate(crowded);
    expect(images(seen.calls[1])).toBeLessThanOrEqual(MAX_REQUEST_IMAGES);
    expect(seen.calls[1]).not.toBe(crowded);
    expect(seen.warnings).toEqual([`50 older image(s) omitted from this request to stay within per-request image limits. Original images remain in conversation history.`]);
  });

  test("a model known to take no pictures gets none, with a warning for each request that had some, and a request with none goes as it is", async () => {
    const { wrapped, seen } = world([], false);
    await wrapped.generate(request());
    expect(images(seen.calls[0])).toBe(0);
    const plain = request([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    await wrapped.generate(plain);
    expect(seen.calls[1]).toBe(plain);
    expect(seen.warnings).toEqual(["local/m does not accept images; 1 image(s) omitted from this request. Original images remain in conversation history."]);
  });
});

describe("a provider that refuses pictures while streaming", () => {
  test("is asked again without them, said to have refused once, and from then on sent none", async () => {
    const { wrapped, seen } = world([
      () => failing([{ type: "start", model: "m" }, { type: "ping" }, { type: "provider_warning", message: "slow" }], REFUSED),
      () => events({ type: "text", text: "a reply" }),
      () => events({ type: "text", text: "later" }),
    ]);
    const first = request();
    expect(await collect(wrapped.stream(first))).toEqual([{ type: "start", model: "m" }, { type: "ping" }, { type: "provider_warning", message: "slow" }, { type: "text", text: "a reply" }]);
    expect(seen.calls.map(images)).toEqual([1, 0]);
    expect(seen.rejected).toEqual([first]);
    await collect(wrapped.stream(request()));
    expect(images(seen.calls[2])).toBe(0);
    expect(seen.rejected).toHaveLength(1);
  });

  test("a refusal that comes as an error event before any reply is handled the same, and one after a reply has begun is passed on", async () => {
    const early = world([() => events(errorEvent("this model does not support image input", REFUSED)), () => events({ type: "text", text: "ok" })]);
    expect(await collect(early.wrapped.stream(request()))).toEqual([{ type: "text", text: "ok" }]);
    expect(early.seen.rejected).toHaveLength(1);
    const late = world([() => events({ type: "text", text: "half" }, errorEvent("this model does not support image input", REFUSED))]);
    expect(await collect(late.wrapped.stream(request()))).toHaveLength(2);
    expect(late.seen.rejected).toEqual([]);
    const thrownLate = world([() => failing([{ type: "text", text: "half" }], REFUSED)]);
    expect(await collect(thrownLate.wrapped.stream(request())).catch((error: unknown) => error)).toBe(REFUSED);
    expect(thrownLate.seen.calls).toHaveLength(1);
  });

  test("an error that isn't a refusal, one when the request held no pictures, and one after the call was stopped are passed on and not retried", async () => {
    const other = Object.assign(new Error("overloaded"), { status: 529 });
    const notRefused = world([() => failing([], other)]);
    expect(await collect(notRefused.wrapped.stream(request())).catch((error: unknown) => error)).toBe(other);
    const noPictures = world([() => failing([], REFUSED)]);
    expect(await collect(noPictures.wrapped.stream(request([{ role: "user", content: [{ type: "text", text: "hi" }] }]))).catch((error: unknown) => error)).toBe(REFUSED);
    const stopped = new AbortController();
    stopped.abort();
    const aborted = world([() => failing([], REFUSED)]);
    expect(await collect(aborted.wrapped.stream(request(), stopped.signal)).catch((error: unknown) => error)).toBe(REFUSED);
    expect([notRefused.seen.calls.length, noPictures.seen.calls.length, aborted.seen.calls.length]).toEqual([1, 1, 1]);
    const event = world([() => events(errorEvent("overloaded", other))]);
    expect(await collect(event.wrapped.stream(request()))).toEqual([errorEvent("overloaded", other)]);
    const textOnly = world([() => events(errorEvent("this model does not support image input", REFUSED))]);
    expect(await collect(textOnly.wrapped.stream(request([{ role: "user", content: [{ type: "text", text: "hi" }] }])))).toHaveLength(1);
  });
});

describe("a provider's own tool loop", () => {
  test("is offered only when the provider has one, and each tool result goes to the model as the request's limits allow while the turn records the result as the tool gave it", async () => {
    expect("streamWithTools" in world([]).wrapped).toBe(false);
    const sent: ContentBlock[] = [];
    const recorded: ContentBlock[][] = [];
    const result: ContentBlock = { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a picture" }, image()] };
    const provider: SidecarProvider = {
      stream: () => events(),
      generate: () => Promise.resolve(done),
      streamWithTools: async function* (req, tools) {
        expect(images(req)).toBe(0);
        sent.push(await tools.runTool({ id: "t1", name: "look", input: {} }));
        sent.push(await tools.runTool({ id: "t2", name: "note", input: {} }));
        await tools.recordTurn("user", [...sent, { type: "text", text: "after" }]);
        yield { type: "text", text: "done" };
      },
    };
    const wrapped = withToolImages(provider, { support: () => false, rejected: () => {}, warn: () => {} });
    const plain: ContentBlock = { type: "text", text: "noted" };
    const phase: ToolPhase = {
      messages: [],
      runTool: (use) => Promise.resolve(use.id === "t1" ? result : plain),
      recordTurn: (_role, blocks) => { recorded.push(blocks); },
    };
    expect(await collect(required(wrapped.streamWithTools?.bind(wrapped))(request(), phase))).toEqual([{ type: "text", text: "done" }]);
    expect(sent[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect((sent[0] as { content: ContentBlock[] }).content.map((block) => block.type)).toEqual(["text", "text"]);
    expect(sent[1]).toBe(plain);
    expect(recorded).toEqual([[result, plain, { type: "text", text: "after" }]]);
  });
});
