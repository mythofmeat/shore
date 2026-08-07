import { createHash } from "node:crypto";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface MockToolUse {
  id?: string;
  name: string;
  input: unknown;
}

export interface AnthropicReply {
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  toolUses?: MockToolUse[];
  stopReason?: string;
  usage?: Partial<AnthropicUsage>;
  status?: number;
  errorBody?: unknown;
  delayMs?: number;
}

export interface SeenBreakpoint {
  where: "system" | "messages";
  index: number;
  prefixTokens: number;
  hit: boolean;
  ttl: string;
}

export interface AnthropicRequestRecord {
  body: any;
  streaming: boolean;
  headers: Record<string, string>;
  breakpoints: SeenBreakpoint[];
  usage: AnthropicUsage;
}

export interface MockAnthropicOptions {
  port?: number;
  script?: AnthropicReply[];
  fallback?: AnthropicReply | ((req: AnthropicRequestRecord) => AnthropicReply) | null;
  now?: () => number;
  chunkChars?: number;
  onRequest?: (req: AnthropicRequestRecord) => void;
}

export interface MockAnthropic {
  readonly url: string;
  readonly port: number;
  readonly requests: AnthropicRequestRecord[];
  readonly lastUsage: AnthropicUsage;
  readonly lastBreakpoints: SeenBreakpoint[];
  push(...replies: AnthropicReply[]): void;
  evictCache(): void;
  reset(): void;
  stop(): Promise<void>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const HOUR_TTL_MS = 60 * 60 * 1000;

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.max(1, Math.ceil(text.length / 4));
}

function hashPrefix(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function cacheControlOf(block: unknown): { ttl?: string } | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const cc = (block as { cache_control?: unknown }).cache_control;
  if (typeof cc !== "object" || cc === null) return undefined;
  return cc as { ttl?: string };
}

function ttlMsOf(cc: { ttl?: string }): number {
  return cc.ttl === "1h" ? HOUR_TTL_MS : DEFAULT_TTL_MS;
}

interface CacheEntry {
  tokens: number;
  expiresAt: number;
}

export class PrefixCache {
  readonly #entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  account(
    system: unknown,
    messages: unknown[],
  ): { usage: Omit<AnthropicUsage, "output_tokens">; breakpoints: SeenBreakpoint[] } {
    const now = this.now();
    const breakpoints: SeenBreakpoint[] = [];
    const parts: unknown[] = [];
    let cumulative = 0;

    const walk = (where: "system" | "messages", blocks: unknown[]) => {
      blocks.forEach((block, index) => {
        parts.push(block);
        cumulative += estimateTokens(block);
        const cc = cacheControlOf(block);
        const inner =
          cc === undefined && where === "messages" ? innerCacheControl(block) : cc;
        if (inner === undefined) return;
        const hash = hashPrefix(parts);
        const live = this.#entries.get(hash);
        breakpoints.push({
          where,
          index,
          prefixTokens: cumulative,
          hit: live !== undefined && live.expiresAt > now,
          ttl: inner.ttl === "1h" ? "1h" : "5m",
        });
        this.#entries.set(hash, { tokens: cumulative, expiresAt: now + ttlMsOf(inner) });
      });
    };

    walk("system", Array.isArray(system) ? system : system ? [system] : []);
    walk("messages", messages);

    const total = cumulative;
    let read = 0;
    for (let i = breakpoints.length - 1; i >= 0; i--) {
      if (breakpoints[i]!.hit) {
        read = breakpoints[i]!.prefixTokens;
        break;
      }
    }
    const lastBreakpoint = breakpoints.at(-1)?.prefixTokens ?? 0;
    return {
      usage: {
        cache_read_input_tokens: read,
        cache_creation_input_tokens: Math.max(0, lastBreakpoint - read),
        input_tokens: Math.max(0, total - lastBreakpoint),
      },
      breakpoints,
    };
  }

  clear(): void {
    this.#entries.clear();
  }
}

function innerCacheControl(message: unknown): { ttl?: string } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const cc = cacheControlOf(block);
    if (cc !== undefined) return cc;
  }
  return undefined;
}

export async function startMockAnthropic(
  options: MockAnthropicOptions = {},
): Promise<MockAnthropic> {
  const requests: AnthropicRequestRecord[] = [];
  const script: AnthropicReply[] = [...(options.script ?? [])];
  const chunkChars = options.chunkChars ?? 8;
  const now = options.now ?? Date.now;
  const cache = new PrefixCache(now);
  const fallback = options.fallback === undefined ? echoLastUserMessage : options.fallback;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/messages")) return new Response("not found", { status: 404 });

      const body: any = await request.json().catch(() => undefined);
      const streaming = body?.stream === true;
      const { usage: inputUsage, breakpoints } = cache.account(body?.system, body?.messages ?? []);

      const record: AnthropicRequestRecord = {
        body,
        streaming,
        headers: Object.fromEntries(request.headers.entries()),
        breakpoints,
        usage: { ...inputUsage, output_tokens: 0 },
      };

      const reply = nextReply(script, fallback, record);
      if (reply === undefined) {
        requests.push(record);
        options.onRequest?.(record);
        return Response.json(
          { type: "error", error: { type: "mock_exhausted", message: "no scripted reply left" } },
          { status: 500 },
        );
      }
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      if (reply.status !== undefined && reply.status >= 400) {
        requests.push(record);
        options.onRequest?.(record);
        return Response.json(
          reply.errorBody ?? {
            type: "error",
            error: { type: "mock_error", message: `scripted ${reply.status}` },
          },
          { status: reply.status },
        );
      }

      const usage: AnthropicUsage = {
        ...record.usage,
        output_tokens: estimateTokens(reply.text ?? "") + estimateTokens(reply.thinking ?? ""),
        ...reply.usage,
      };
      record.usage = usage;
      requests.push(record);
      options.onRequest?.(record);

      const model = typeof body?.model === "string" ? body.model : "claude-mock";
      return streaming
        ? streamResponse(reply, model, usage, chunkChars)
        : Response.json(messageResponse(reply, model, usage));
    },
  });

  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    get lastUsage() {
      return requests.at(-1)?.usage ?? emptyUsage();
    },
    get lastBreakpoints() {
      return requests.at(-1)?.breakpoints ?? [];
    },
    push: (...replies) => script.push(...replies),
    evictCache: () => cache.clear(),
    reset: () => {
      requests.length = 0;
      script.length = 0;
      cache.clear();
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

function emptyUsage(): AnthropicUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function nextReply(
  script: AnthropicReply[],
  fallback: AnthropicReply | ((req: AnthropicRequestRecord) => AnthropicReply) | null,
  record: AnthropicRequestRecord,
): AnthropicReply | undefined {
  const scripted = script.shift();
  if (scripted !== undefined) return scripted;
  if (fallback === null) return undefined;
  return typeof fallback === "function" ? fallback(record) : fallback;
}

function echoLastUserMessage(record: AnthropicRequestRecord): AnthropicReply {
  const messages = Array.isArray(record.body?.messages) ? record.body.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
  const content = lastUser?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("")
        : "";
  return { text: `mock reply to: ${text || "(nothing)"}` };
}

function stopReasonOf(reply: AnthropicReply): string {
  return reply.stopReason ?? (reply.toolUses?.length ? "tool_use" : "end_turn");
}

function toolUseId(use: MockToolUse, index: number): string {
  return use.id ?? `toolu_${index}`;
}

function blocksOf(reply: AnthropicReply): any[] {
  const blocks: any[] = [];
  if (reply.thinking) {
    blocks.push({
      type: "thinking",
      thinking: reply.thinking,
      signature: reply.thinkingSignature ?? "mock-signature",
    });
  }
  if (reply.text) blocks.push({ type: "text", text: reply.text });
  for (const [i, use] of (reply.toolUses ?? []).entries()) {
    blocks.push({ type: "tool_use", id: toolUseId(use, i), name: use.name, input: use.input });
  }
  return blocks;
}

function messageResponse(reply: AnthropicReply, model: string, usage: AnthropicUsage): unknown {
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model,
    content: blocksOf(reply),
    stop_reason: stopReasonOf(reply),
    stop_sequence: null,
    usage,
  };
}

function streamResponse(
  reply: AnthropicReply,
  model: string,
  usage: AnthropicUsage,
  chunkChars: number,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (type: string, payload: Record<string, unknown>) =>
        controller.enqueue(
          encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`),
        );

      send("message_start", {
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 1 },
        },
      });

      let index = 0;
      if (reply.thinking) {
        send("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
        for (const piece of split(reply.thinking, chunkChars)) {
          send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: piece } });
        }
        send("content_block_delta", {
          index,
          delta: { type: "signature_delta", signature: reply.thinkingSignature ?? "mock-signature" },
        });
        send("content_block_stop", { index });
        index++;
      }

      if (reply.text) {
        send("content_block_start", { index, content_block: { type: "text", text: "" } });
        for (const piece of split(reply.text, chunkChars)) {
          send("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
        }
        send("content_block_stop", { index });
        index++;
      }

      for (const [i, use] of (reply.toolUses ?? []).entries()) {
        send("content_block_start", {
          index,
          content_block: { type: "tool_use", id: toolUseId(use, i), name: use.name, input: {} },
        });
        for (const piece of split(JSON.stringify(use.input), chunkChars)) {
          send("content_block_delta", {
            index,
            delta: { type: "input_json_delta", partial_json: piece },
          });
        }
        send("content_block_stop", { index });
        index++;
      }

      send("message_delta", {
        delta: { stop_reason: stopReasonOf(reply), stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      });
      send("message_stop", {});
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
  const scriptPath = flag("--script");
  const script: AnthropicReply[] = scriptPath === undefined ? [] : await Bun.file(scriptPath).json();

  const mock = await startMockAnthropic({
    port,
    script,
    onRequest: (req) => {
      const u = req.usage;
      const marks = req.breakpoints.map((b) => `${b.where}[${b.index}]${b.hit ? "✓" : "✗"}`);
      console.error(
        `messages · in:${u.input_tokens} read:${u.cache_read_input_tokens} ` +
          `write:${u.cache_creation_input_tokens} · breakpoints: ${marks.join(" ") || "none"}`,
      );
    },
  });

  console.error(`mock anthropic listening on ${mock.url}`);
  console.error(`  [providers.mock]\n  sdk = "anthropic"\n  base_url = "${mock.url}"\n`);

  const stop = () => void mock.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
