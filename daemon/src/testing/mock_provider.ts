import { required } from "../util/required.ts";

import { shoreLog } from "../log.ts";

export interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface MockToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

export interface MockReply {
  text?: string;
  thinking?: string;
  toolCalls?: MockToolCall[];
  finishReason?: string;
  usage?: Partial<MockUsage>;
  status?: number;
  errorBody?: unknown;
  delayMs?: number;
}

export interface RecordedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: MockRequestBody;
  streaming: boolean;
}

export interface MockRequestBody extends Record<string, unknown> {
  messages: unknown[];
  model?: unknown;
  stream?: unknown;
  tools?: unknown[];
}

export interface MockProviderOptions {
  port?: number;
  script?: MockReply[];
  fallback?: MockReply | ((req: RecordedRequest) => MockReply) | null;
  models?: string[];
  chunkChars?: number;
  onRequest?: (req: RecordedRequest) => void;
}

export interface MockProvider {
  readonly url: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  push(...replies: MockReply[]): void;
  reset(): void;
  stop(): Promise<void>;
}

const DEFAULT_MODEL = "mock-model";

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
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const decoded: unknown =
        request.method === "POST" ? await request.json().catch(() => undefined) : undefined;
      const rawBody = isRecord(decoded) ? decoded : {};
      const body: MockRequestBody = {
        ...rawBody,
        messages: Array.isArray(rawBody["messages"]) ? rawBody["messages"] : [],
      };
      const recorded: RecordedRequest = {
        path: url.pathname,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body,
        streaming: body.stream === true,
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

      const model = typeof body.model === "string" ? body.model : required(models[0]);
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

function echoLastUserMessage(request: RecordedRequest): MockReply {
  const messages = request.body.messages;
  const lastUser = [...messages].reverse().find(isUserMessage);
  const text = typeof lastUser?.content === "string" ? lastUser.content : contentText(lastUser?.content);
  return { text: `mock reply to: ${text || "(nothing)"}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUserMessage(value: unknown): value is { role: "user"; content?: unknown } {
  return isRecord(value) && value["role"] === "user";
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  if (typeof block !== "object" || block === null) return false;
  const maybe = block as { type?: unknown; text?: unknown };
  return maybe.type === "text" && typeof maybe.text === "string";
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter(isTextBlock).map((b) => b.text).join("");
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

function split(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };

  const port = Number(flag("--port") ?? 0);
  const models = (flag("--model") ?? DEFAULT_MODEL).split(",");
  const quiet = argv.includes("--quiet");

  const scriptPath = flag("--script");
  const loadedScript: unknown =
    scriptPath === undefined ? [] : await Bun.file(scriptPath).json();
  if (!Array.isArray(loadedScript)) {
    shoreLog.error(`--script ${scriptPath}: expected a JSON array of replies`);
    process.exit(1);
  }
  const script = loadedScript as MockReply[];

  const trace = (req: RecordedRequest) => {
    const what = req.path.endsWith("/models")
      ? "model list"
      : `${req.streaming ? "stream" : "generate"} · ${
          Array.isArray(req.body?.messages) ? req.body.messages.length : 0
        } messages · ${Array.isArray(req.body?.tools) ? req.body.tools.length : 0} tools`;
    shoreLog.error(`${req.method} ${req.path} — ${what}`);
  };

  const mock = await startMockProvider({
    port,
    models,
    script,
    ...(quiet ? {} : { onRequest: trace }),
  });

  shoreLog.error(`mock provider listening on ${mock.url} (model: ${models.join(", ")})`);
  if (script.length > 0) shoreLog.error(`${script.length} scripted replies, then echo`);
  shoreLog.error("point a provider at it:\n");
  shoreLog.error(`  [providers.mock]`);
  shoreLog.error(`  sdk = "openai"`);
  shoreLog.error(`  base_url = "${mock.url}"`);
  shoreLog.error(`  api_key_env = "MOCK_API_KEY"\n`);

  const stop = () => {
    void mock.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
