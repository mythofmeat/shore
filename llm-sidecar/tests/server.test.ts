import { expect, test } from "bun:test";

import { createSidecarHandler } from "../src/server.ts";
import type {
  GenerateResponse,
  ImageRequest,
  ImageResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
} from "../src/llm/types.ts";

function sidecarReq(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "openai",
    model: "openai/gpt-test",
    api_key: "sk-test",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 128,
    ...over,
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://sidecar${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function lines(res: Response): Promise<unknown[]> {
  return (await res.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function generateResponse(over: Partial<GenerateResponse> = {}): GenerateResponse {
  return {
    content: "hello",
    content_blocks: [{ type: "text", text: "hello" }],
    finish_reason: "end_turn",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 3, time_to_first_token_ms: 3 },
    model: "openai/gpt-test",
    ...over,
  };
}

test("GET /healthz returns ok", async () => {
  const handler = createSidecarHandler();
  const res = await handler(new Request("http://sidecar/healthz"));

  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok\n");
});

test("POST /v1/generate routes to the selected provider", async () => {
  let seenReq: SidecarRequest | undefined;
  let seenSignal: AbortSignal | undefined;
  const provider: SidecarProvider = {
    stream: unreachableStream,
    async generate(req, signal) {
      seenReq = req;
      seenSignal = signal;
      return generateResponse({ model: req.model });
    },
  };

  const handler = createSidecarHandler({ providers: { openai: provider } });
  const res = await handler(post("/v1/generate", sidecarReq({ model: "openai/gpt-route" })));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(generateResponse({ model: "openai/gpt-route" }));
  expect(seenReq?.model).toBe("openai/gpt-route");
  expect(seenSignal).toBeInstanceOf(AbortSignal);
});

test("POST /v1/stream emits StreamEvents as NDJSON", async () => {
  const provider: SidecarProvider = {
    async *stream(req) {
      yield { type: "start", model: req.model };
      yield { type: "text", text: "hi" };
      yield {
        type: "done",
        content: "hi",
        finish_reason: "end_turn",
        usage: {
          input_tokens: 4,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        timing: { total_ms: 9, time_to_first_token_ms: 2 },
      };
    },
    async generate() {
      return generateResponse();
    },
  };

  const handler = createSidecarHandler({ providers: { openai: provider } });
  const res = await handler(post("/v1/stream", sidecarReq({ model: "openai/gpt-stream" })));

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/x-ndjson");
  expect(await lines(res)).toEqual([
    { type: "start", model: "openai/gpt-stream" },
    { type: "text", text: "hi" },
    {
      type: "done",
      content: "hi",
      finish_reason: "end_turn",
      usage: {
        input_tokens: 4,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      timing: { total_ms: 9, time_to_first_token_ms: 2 },
    },
  ]);
});

test("emits ping keepalives while the provider stream is quiet", async () => {
  // A max-effort reasoning turn can emit no forwarded bytes for many seconds
  // while the model thinks. Bun's idle timeout would otherwise close the socket
  // mid-flight (the daemon then sees an unexpected-EOF / IncompleteStream). The
  // streaming pump fills the gap with `ping` events so the socket never sits
  // idle. (Bun's per-request `server.timeout(req, 0)` is a no-op for streaming
  // bodies, so this keepalive — not a timeout override — is what holds it open.)
  const provider: SidecarProvider = {
    async *stream(req) {
      yield { type: "start", model: req.model };
      // Quiet gap long enough to span several heartbeat ticks.
      await new Promise((resolve) => setTimeout(resolve, 35));
      yield { type: "text", text: "done thinking" };
      yield {
        type: "done",
        content: "done thinking",
        finish_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 35, time_to_first_token_ms: 35 },
      };
    },
    async generate() {
      return generateResponse();
    },
  };
  const handler = createSidecarHandler({ providers: { openai: provider }, heartbeatMs: 10 });

  const res = await handler(post("/v1/stream", sidecarReq()));
  const events = (await lines(res)) as Array<{ type: string }>;

  const pings = events.filter((e) => e.type === "ping");
  expect(pings.length).toBeGreaterThanOrEqual(1);
  // Pings are interleaved keepalives, never a substitute for the real events:
  // start first, the content + terminal done still arrive in order.
  const substantive = events.filter((e) => e.type !== "ping").map((e) => e.type);
  expect(substantive).toEqual(["start", "text", "done"]);
});

test("disables the idle timeout for /v1 POSTs", async () => {
  // The per-request override is load-bearing for the non-streaming endpoints
  // (`/v1/generate`, `/v1/image`), where it actually disables Bun's idle timeout
  // for the awaited response. On `/v1/stream` it is a documented no-op (Bun
  // ignores it for a streaming body — the `ping` keepalive holds that path open)
  // but the handler still calls it uniformly for every POST.
  const calls: Array<{ request: Request; seconds: number }> = [];
  const server = {
    timeout(request: Request, seconds: number) {
      calls.push({ request, seconds });
    },
  };
  const provider: SidecarProvider = {
    async *stream(req) {
      yield { type: "start", model: req.model };
      yield {
        type: "done",
        content: "",
        finish_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
    async generate() {
      return generateResponse();
    },
  };
  const handler = createSidecarHandler({ providers: { openai: provider } });

  const streamReq = post("/v1/stream", sidecarReq());
  await handler(streamReq, server);
  const generateReq = post("/v1/generate", sidecarReq());
  await handler(generateReq, server);

  expect(calls).toEqual([
    { request: streamReq, seconds: 0 },
    { request: generateReq, seconds: 0 },
  ]);
});

test("does not touch the idle timeout for /healthz", async () => {
  const calls: number[] = [];
  const server = {
    timeout(_request: Request, seconds: number) {
      calls.push(seconds);
    },
  };
  const handler = createSidecarHandler();

  await handler(new Request("http://sidecar/healthz"), server);

  expect(calls).toEqual([]);
});

test("pre-stream provider errors become non-2xx responses", async () => {
  const err = Object.assign(new Error("rate limited"), {
    status: 429,
    body: "upstream said slow down",
  });
  const provider: SidecarProvider = {
    async *stream(): AsyncIterable<StreamEvent> {
      throw err;
    },
    async generate() {
      return generateResponse();
    },
  };

  const handler = createSidecarHandler({ providers: { openai: provider } });
  const res = await handler(post("/v1/stream", sidecarReq()));

  expect(res.status).toBe(429);
  expect(await res.text()).toBe("upstream said slow down");
});

test("mid-stream provider errors close without emitting done", async () => {
  const provider: SidecarProvider = {
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "start", model: "openai/gpt-stream" };
      yield { type: "text", text: "partial" };
      throw new Error("socket broke after streaming began");
    },
    async generate() {
      return generateResponse();
    },
  };

  const handler = createSidecarHandler({ providers: { openai: provider } });
  const res = await handler(post("/v1/stream", sidecarReq()));
  const out = await lines(res);

  expect(res.status).toBe(200);
  expect(out).toEqual([
    { type: "start", model: "openai/gpt-stream" },
    { type: "text", text: "partial" },
  ]);
});

test("stream body cancellation aborts the provider signal", async () => {
  let providerSignal: AbortSignal | undefined;
  const provider: SidecarProvider = {
    async *stream(_req, signal): AsyncIterable<StreamEvent> {
      providerSignal = signal;
      yield { type: "start", model: "openai/gpt-cancel" };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
    async generate() {
      return generateResponse();
    },
  };

  const handler = createSidecarHandler({ providers: { openai: provider } });
  const res = await handler(post("/v1/stream", sidecarReq()));
  const reader = res.body?.getReader();
  expect(reader).toBeDefined();
  await reader?.read();
  await reader?.cancel();

  expect(providerSignal?.aborted).toBe(true);
});

test("POST /v1/image routes to the image generator", async () => {
  let seenReq: ImageRequest | undefined;
  let seenSignal: AbortSignal | undefined;
  const imageGenerate = async (req: ImageRequest, signal?: AbortSignal): Promise<ImageResponse> => {
    seenReq = req;
    seenSignal = signal;
    return { url: "https://img.test/1.png", revised_prompt: "rev", timing: { total_ms: 12 } };
  };

  const handler = createSidecarHandler({ imageGenerate });
  const body: ImageRequest = {
    provider_key: "openai",
    model: "gpt-image-1",
    api_key: "sk-test",
    prompt: "paint the sea",
    size: "1024x1024",
  };
  const res = await handler(post("/v1/image", body));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    url: "https://img.test/1.png",
    revised_prompt: "rev",
    timing: { total_ms: 12 },
  });
  expect(seenReq?.prompt).toBe("paint the sea");
  expect(seenSignal).toBeInstanceOf(AbortSignal);
});

test("unknown SDKs return 501", async () => {
  const handler = createSidecarHandler();
  const res = await handler(
    post("/v1/stream", sidecarReq({ sdk: "bogus" as SidecarRequest["sdk"] })),
  );

  expect(res.status).toBe(501);
  expect(await res.text()).toContain("unsupported sdk: bogus");
});

async function* unreachableStream(): AsyncIterable<StreamEvent> {
  throw new Error("unexpected stream call");
}
