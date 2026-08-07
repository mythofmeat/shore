/**
 * An OpenAI-compatible provider that answers from a script.
 *
 * Point `[providers.*]` at it and the daemon makes real provider calls —
 * through the real `openai` SDK, the real adapter, the real stream consumer —
 * against something that costs nothing, never rate-limits, and says exactly
 * what the test told it to say. It is the piece that was missing for testing
 * anything above the wire: every suite in `tests/` either stops at the request
 * it would have sent or substitutes a fake adapter, so the path from
 * `handler/turn.ts` down through `providers/openai.ts` and back up into
 * `active.jsonl` had no coverage that ran it end to end.
 *
 * Two ways in:
 *
 * ```ts
 * const mock = await startMockProvider({ script: [{ text: "hi" }] });
 * // …point a daemon at mock.url, drive it, then:
 * expect(mock.requests[0].body.messages.at(-1).content).toBe("hello");
 * await mock.stop();
 * ```
 *
 * ```console
 * $ bun run src/testing/mock_provider.ts --port 8899
 * mock provider listening on http://127.0.0.1:8899/v1 (model: mock-model)
 * ```
 *
 * The standalone form echoes the user's last message, which is enough to hold
 * a conversation in the TUI and see turns land on disk.
 *
 * # Why OpenAI-compatible
 *
 * It is the dialect with the most adapters behind it — `providers/openai.ts`
 * fronts OpenAI, DeepSeek, Kimi, xAI and every other gateway that differs only
 * by `base_url` — so one mock exercises the widest path. `sdk = "anthropic"`
 * and `sdk = "gemini"` speak different wires and would each need their own;
 * they are worth adding when something needs them, not before.
 *
 * # What it is faithful to
 *
 * The shapes the `openai` SDK parses and the adapter reads, and no more:
 * `choices[0].delta.{content,reasoning_content,tool_calls}`, `finish_reason`,
 * and a trailing `usage` chunk (the adapter sends
 * `stream_options: {include_usage: true}`, so a stream without one reports
 * zero tokens and the ledger records a free call). Tool-call arguments are
 * emitted as fragments across chunks, because a mock that always sent them
 * whole would never exercise the adapter's accumulator — which is the part
 * that can break.
 */

/** A `usage` block, in the OpenAI spelling the adapter's `extractUsage` reads. */
export interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** One tool call for the model to ask for. */
export interface MockToolCall {
  /** Defaults to `call_<n>` within the reply. */
  id?: string;
  name: string;
  /** Serialized with `JSON.stringify` and split across chunks when streaming. */
  arguments: unknown;
}

/**
 * One answer.
 *
 * A reply with `status` is a failure and everything else on it is ignored —
 * that is how you make the daemon's retry and fallback paths run.
 */
export interface MockReply {
  /** Assistant text. */
  text?: string;
  /** Emitted as `reasoning_content`, which the adapter turns into `thinking`. */
  thinking?: string;
  toolCalls?: MockToolCall[];
  /** Defaults to `tool_calls` when `toolCalls` is set, else `stop`. */
  finishReason?: string;
  usage?: Partial<MockUsage>;
  /** Non-2xx status. Makes this call fail instead of answering. */
  status?: number;
  /** Body for a `status` reply. Defaults to an OpenAI-shaped error object. */
  errorBody?: unknown;
  /** Wait before responding. For timeouts, cancellation and keepalives. */
  delayMs?: number;
}

/** What the mock saw, for assertions. */
export interface RecordedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or `undefined` for a GET. */
  body: any;
  /** True when the daemon asked for SSE. */
  streaming: boolean;
}

export interface MockProviderOptions {
  /** 0 (the default) asks the kernel for a free one. */
  port?: number;
  /** Answers, in order. When exhausted, {@link MockProviderOptions.fallback} takes over. */
  script?: MockReply[];
  /**
   * What to answer once the script runs out.
   *
   * Defaults to echoing the last user message, so the standalone server is
   * usable without a script. Pass `null` to fail instead — which is what a
   * test wants, since a turn nobody scripted is a turn nobody meant.
   */
  fallback?: MockReply | ((req: RecordedRequest) => MockReply) | null;
  /** Model ids `GET /v1/models` reports. Defaults to `["mock-model"]`. */
  models?: string[];
  /** Characters per streamed text chunk. Defaults to 8. */
  chunkChars?: number;
  /** Called for each request. For logging in the standalone server. */
  onRequest?: (req: RecordedRequest) => void;
}

export interface MockProvider {
  /** The `base_url` to put in `[providers.<name>]` — includes the `/v1`. */
  readonly url: string;
  readonly port: number;
  /** Every request, in arrival order. */
  readonly requests: RecordedRequest[];
  /** Append to the script at runtime. */
  push(...replies: MockReply[]): void;
  /** Drop recorded requests and any unconsumed script. */
  reset(): void;
  stop(): Promise<void>;
}

const DEFAULT_MODEL = "mock-model";

/** Start the server and resolve once it is accepting. */
export async function startMockProvider(
  options: MockProviderOptions = {},
): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];
  const script: MockReply[] = [...(options.script ?? [])];
  const models = options.models ?? [DEFAULT_MODEL];
  const chunkChars = options.chunkChars ?? 8;
  const fallback = options.fallback === undefined ? echoLastUserMessage : options.fallback;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    // A scripted `delayMs` is the point of some tests, so the server must not
    // be the thing that gives up first.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body: any =
        request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
      const recorded: RecordedRequest = {
        path: url.pathname,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body,
        streaming: body?.stream === true,
      };
      requests.push(recorded);
      options.onRequest?.(recorded);

      if (url.pathname.endsWith("/models") && request.method === "GET") {
        return Response.json({
          object: "list",
          data: models.map((id) => ({ id, object: "model", owned_by: "mock" })),
        });
      }

      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const reply = nextReply(script, fallback, recorded);
      if (reply === undefined) {
        return Response.json(
          { error: { message: "mock provider: no scripted reply left", type: "mock_exhausted" } },
          { status: 500 },
        );
      }
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      if (reply.status !== undefined && reply.status >= 400) {
        return Response.json(
          reply.errorBody ?? {
            error: { message: `mock provider: scripted ${reply.status}`, type: "mock_error" },
          },
          { status: reply.status },
        );
      }

      const model = typeof body?.model === "string" ? body.model : models[0]!;
      return recorded.streaming
        ? streamResponse(reply, model, chunkChars)
        : Response.json(completionResponse(reply, model));
    },
  });

  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    push: (...replies) => script.push(...replies),
    reset: () => {
      requests.length = 0;
      script.length = 0;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** The script first, then the fallback; `undefined` means answer with an error. */
function nextReply(
  script: MockReply[],
  fallback: MockReply | ((req: RecordedRequest) => MockReply) | null,
  request: RecordedRequest,
): MockReply | undefined {
  const scripted = script.shift();
  if (scripted !== undefined) return scripted;
  if (fallback === null) return undefined;
  return typeof fallback === "function" ? fallback(request) : fallback;
}

/**
 * Echo the last user message.
 *
 * Deliberately not an empty reply: a turn that persists an empty assistant
 * message looks the same on disk as a turn that never ran, and the standalone
 * server exists to make a working turn visible.
 */
function echoLastUserMessage(request: RecordedRequest): MockReply {
  const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : contentText(lastUser?.content);
  return { text: `mock reply to: ${text || "(nothing)"}` };
}

/** OpenAI multipart content → its text, for the echo. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
}

function usageOf(reply: MockReply): MockUsage {
  const prompt = reply.usage?.prompt_tokens ?? 11;
  const completion = reply.usage?.completion_tokens ?? Math.max(1, Math.ceil((reply.text ?? "").length / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: reply.usage?.total_tokens ?? prompt + completion,
    ...(reply.usage?.prompt_tokens_details === undefined
      ? {}
      : { prompt_tokens_details: reply.usage.prompt_tokens_details }),
  };
}

function finishReasonOf(reply: MockReply): string {
  return reply.finishReason ?? (reply.toolCalls?.length ? "tool_calls" : "stop");
}

function toolCallId(call: MockToolCall, index: number): string {
  return call.id ?? `call_${index}`;
}

/** `POST /v1/chat/completions` without `stream`. */
function completionResponse(reply: MockReply, model: string): unknown {
  const message: Record<string, unknown> = { role: "assistant" };
  if (reply.text) message.content = reply.text;
  if (reply.thinking) message.reasoning_content = reply.thinking;
  if (reply.toolCalls?.length) {
    message.tool_calls = reply.toolCalls.map((call, i) => ({
      id: toolCallId(call, i),
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finishReasonOf(reply) }],
    usage: usageOf(reply),
  };
}

/**
 * The same answer as SSE.
 *
 * Text and tool arguments go out in fragments rather than whole, because the
 * adapter accumulates both and an always-whole mock would leave that
 * accumulation untested. `usage` rides its own trailing chunk with an empty
 * `choices`, which is where the real API puts it under
 * `stream_options.include_usage`.
 */
function streamResponse(reply: MockReply, model: string, chunkChars: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (payload: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const chunk = (delta: unknown, finish: string | null = null) =>
        send({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });

      chunk({ role: "assistant" });
      for (const piece of split(reply.thinking ?? "", chunkChars)) chunk({ reasoning_content: piece });
      for (const piece of split(reply.text ?? "", chunkChars)) chunk({ content: piece });

      reply.toolCalls?.forEach((call, index) => {
        // The opening fragment carries id and name; the rest carry arguments
        // only, keyed by `index`. That is the real wire's shape and the reason
        // the adapter keys its accumulator on `index` rather than `id`.
        chunk({
          tool_calls: [
            { index, id: toolCallId(call, index), type: "function", function: { name: call.name, arguments: "" } },
          ],
        });
        for (const piece of split(JSON.stringify(call.arguments), chunkChars)) {
          chunk({ tool_calls: [{ index, function: { arguments: piece } }] });
        }
      });

      chunk({}, finishReasonOf(reply));
      send({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [],
        usage: usageOf(reply),
      });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Split into pieces of at most `size`. An empty string yields nothing. */
function split(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// ── standalone ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };

  const port = Number(flag("--port") ?? 0);
  const models = (flag("--model") ?? DEFAULT_MODEL).split(",");
  const quiet = argv.includes("--quiet");

  // A JSON array of `MockReply`, consumed in order before the echo takes over.
  // This is what makes a tool loop drivable by hand: script the tool call and
  // the answer that follows it, then talk to the daemon normally.
  const scriptPath = flag("--script");
  const script: MockReply[] = scriptPath === undefined ? [] : await Bun.file(scriptPath).json();
  if (!Array.isArray(script)) {
    console.error(`--script ${scriptPath}: expected a JSON array of replies`);
    process.exit(1);
  }

  const trace = (req: RecordedRequest) => {
    const what = req.path.endsWith("/models")
      ? "model list"
      : `${req.streaming ? "stream" : "generate"} · ${
          Array.isArray(req.body?.messages) ? req.body.messages.length : 0
        } messages · ${Array.isArray(req.body?.tools) ? req.body.tools.length : 0} tools`;
    console.error(`${req.method} ${req.path} — ${what}`);
  };

  const mock = await startMockProvider({
    port,
    models,
    script,
    ...(quiet ? {} : { onRequest: trace }),
  });

  console.error(`mock provider listening on ${mock.url} (model: ${models.join(", ")})`);
  if (script.length > 0) console.error(`${script.length} scripted replies, then echo`);
  console.error("point a provider at it:\n");
  console.error(`  [providers.mock]`);
  console.error(`  sdk = "openai"`);
  console.error(`  base_url = "${mock.url}"`);
  console.error(`  api_key_env = "MOCK_API_KEY"\n`);

  const stop = () => {
    void mock.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
