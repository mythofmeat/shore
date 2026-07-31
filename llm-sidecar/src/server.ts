import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";

import {
  KeepaliveService,
  startKeepaliveTimer,
  type KeepalivePrefix,
  type KeepaliveRestore,
} from "./autonomy/keepalive.ts";
import type { BudgetBlock } from "./ledger/budget.ts";
import { budgetBlockFor } from "./ledger/gate.ts";
import {
  recordGenerate,
  recordGenerateError,
  recordingStream,
  setCallObserver,
} from "./ledger/record.ts";
import {
  budgetWarnings,
  modelHistory,
  usageReport,
  type BudgetWarningsRequest,
  type ModelHistoryRequest,
  type UsageRequest,
} from "./ledger/usage.ts";
import { generateImage } from "./llm/image_generate.ts";
import { GeminiProvider } from "./llm/providers/gemini.ts";
import { AnthropicProvider } from "./llm/providers/anthropic.ts";
import { anthropicToolLoopEvents } from "./llm/providers/anthropic_loop.ts";
import { OpenAIProvider } from "./llm/providers/openai.ts";
import { OpenRouterProvider } from "./llm/providers/openrouter.ts";
import { VercelProvider } from "./llm/providers/vercel.ts";
import { ZaiProvider } from "./llm/providers/zai.ts";
import type {
  ImageRequest,
  ImageResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
} from "./llm/types.ts";

export interface SidecarDeps {
  providers?: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  imageGenerate?: (req: ImageRequest, signal?: AbortSignal) => Promise<ImageResponse>;
  /** Override the streaming keepalive cadence (ms). Defaults to {@link HEARTBEAT_MS}; tests set it small. */
  heartbeatMs?: number;
  /**
   * The prompt-cache keepalive scheduler. Distinct from `heartbeatMs` above,
   * which is the socket-level `ping` that stops Bun culling a quiet stream:
   * this one keeps a *provider's* prompt cache warm and costs money.
   */
  keepalive?: KeepaliveService;
}

interface HttpishError {
  status?: number;
  statusCode?: number;
  body?: unknown;
  error?: unknown;
  response?: { status?: number; data?: unknown; body?: unknown };
  message?: string;
}

// One adapter per dialect; the daemon's per-provider config chooses which.
// `openrouter` is the normalized path for non-Anthropic providers (DeepSeek,
// Kimi, GLM, MiniMax, GPT via OpenRouter). `openai`/`zai` are kept for DIRECT
// vendor access — native OpenAI, and Z.ai's coding-subscription base URLs —
// which OpenRouter can't serve. `deepseek`/`moonshot` are DIRECT native access
// via the Vercel AI SDK providers (issue #164), which expose vendor reasoning
// controls (thinking on/off + effort/budget). Anthropic + Gemini keep their
// native SDKs.
const vercel = new VercelProvider();
const DEFAULT_PROVIDERS: Partial<Record<SidecarRequest["sdk"], SidecarProvider>> = {
  anthropic: new AnthropicProvider(),
  gemini: new GeminiProvider(),
  openrouter: new OpenRouterProvider(),
  openai: new OpenAIProvider(),
  zai: new ZaiProvider(),
  deepseek: vercel,
  moonshot: vercel,
};

const NDJSON_HEADERS = {
  "content-type": "application/x-ndjson",
  "cache-control": "no-cache",
};

/**
 * How often the streaming pump writes a `ping` keepalive when the upstream
 * provider has gone quiet. Must stay well under Bun's 10s default idle timeout
 * so a thinking model never lets the daemon↔sidecar socket sit idle long enough
 * to be culled.
 */
const HEARTBEAT_MS = 5_000;

/**
 * Status for a call refused by a usage budget.
 *
 * Distinct from anything a provider returns, so the daemon can tell a policy
 * refusal apart from an upstream failure and surface the budget's own message
 * rather than an HTTP error.
 */
export const BUDGET_BLOCKED_STATUS = 402;

/** The slice of Bun's `Server` we use: per-request idle-timeout override. */
interface RequestTimeoutServer {
  timeout(request: Request, seconds: number): void;
}

export function createSidecarHandler(
  deps: SidecarDeps = {},
): (request: Request, server?: RequestTimeoutServer) => Promise<Response> {
  const providers = { ...DEFAULT_PROVIDERS, ...deps.providers };
  const imageGenerate = deps.imageGenerate ?? generateImage;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  // Owned per handler rather than per module so a test gets an empty schedule.
  // `serveSidecar` builds the live one, because that is also where the ledger
  // observer is registered and the clock is started — effects a test should opt
  // into, not inherit.
  const keepalive =
    deps.keepalive ??
    new KeepaliveService((req, signal) => {
      const provider = providers[req.sdk];
      if (!provider) throw new Error(`unsupported sdk: ${req.sdk}`);
      return provider.generate(req, signal);
    });

  return async (request: Request, server?: RequestTimeoutServer): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain" } });
    }

    if (request.method !== "POST") {
      return textError(404, "not found");
    }

    // A /v1 POST can run long with no bytes on the wire: a max-effort reasoning
    // turn (or a long `generate` for compaction/dreaming) makes the model think
    // for minutes while the provider emits only `ping`s, which we do not forward.
    // Bun's default 10s idleTimeout would then close the connection mid-flight —
    // the daemon sees "unexpected EOF during chunk size line" → IncompleteStream.
    //
    // Two cases, because Bun's per-request override behaves differently:
    //   - Non-streaming (`/v1/generate`, `/v1/image`): the handler awaits a
    //     single JSON response, and `server.timeout(req, 0)` DOES disable the
    //     idle timeout for that wait (verified on Bun 1.3.x). So we call it here.
    //   - Streaming (`/v1/stream`): the same call is a NO-OP for a `ReadableStream`
    //     body (verified: the idle timer still fires at 10s). That path instead
    //     keeps the socket warm with periodic `ping` keepalives — see
    //     streamResponse. The call below is harmless there, just ineffective.
    server?.timeout(request, 0);

    if (url.pathname === "/v1/stream") {
      const parsed = await readJson<SidecarRequest>(request);
      if (!parsed.ok) return parsed.response;
      const req = parsed.value;
      const provider = providers[req.sdk];
      if (!provider) return textError(501, `unsupported sdk: ${req.sdk}`);
      const blocked = budgetBlockFor(req);
      if (blocked) return budgetRefusal(blocked);
      // `tool_rpc` is the switch: with it, this side drives the tool loop and
      // calls back to run each tool. Anthropic only — the SDK tool runner this
      // is built on has no equivalent elsewhere, so every other dialect keeps
      // the daemon's loop, which still serves compaction and dreaming anyway.
      const source =
        req.tool_rpc !== undefined && req.sdk === "anthropic"
          ? (signal: AbortSignal) => anthropicToolLoopEvents(req, signal)
          : (signal: AbortSignal) => provider.stream(req, signal);
      // Every provider call in the stream becomes a ledger row here, including
      // a loop's individual calls, which reach the daemon only as one summed
      // `done`. See `ledger/record.ts`.
      return streamResponse(
        (signal) => recordingStream(req.context, req, source(signal)),
        request.signal,
        heartbeatMs,
      );
    }

    if (url.pathname === "/v1/generate") {
      const parsed = await readJson<SidecarRequest>(request);
      if (!parsed.ok) return parsed.response;
      const req = parsed.value;
      const provider = providers[req.sdk];
      if (!provider) return textError(501, `unsupported sdk: ${req.sdk}`);
      const blocked = budgetBlockFor(req);
      if (blocked) return budgetRefusal(blocked);
      const startedAt = Date.now();
      try {
        const result = await provider.generate(req, request.signal);
        recordGenerate(req.context, req, result);
        return jsonResponse(result);
      } catch (e) {
        recordGenerateError(req.context, req, startedAt);
        return errorResponse(e);
      }
    }

    // The `shore usage` read side. Not a provider call: no budget gate, no
    // ledger row, and a plain JSON reply. See `ledger/usage.ts`.
    if (url.pathname === "/v1/usage") {
      const parsed = await readJson<UsageRequest>(request);
      if (!parsed.ok) return parsed.response;
      try {
        return jsonResponse(await usageReport(parsed.value));
      } catch (e) {
        return errorResponse(e);
      }
    }

    if (url.pathname === "/v1/usage/warnings") {
      const parsed = await readJson<BudgetWarningsRequest>(request);
      if (!parsed.ok) return parsed.response;
      try {
        return jsonResponse(budgetWarnings(parsed.value));
      } catch (e) {
        return errorResponse(e);
      }
    }

    if (url.pathname === "/v1/usage/models") {
      const parsed = await readJson<ModelHistoryRequest>(request);
      if (!parsed.ok) return parsed.response;
      try {
        return jsonResponse(modelHistory(parsed.value));
      } catch (e) {
        return errorResponse(e);
      }
    }

    // The prompt-cache keepalive. Not provider calls in themselves — they arm,
    // disarm, and report on a schedule this side runs on its own clock. The
    // pings it fires are ordinary calls, budget-gated and recorded like any
    // other. See `autonomy/keepalive.ts`.
    if (url.pathname === "/v1/keepalive/prefix") {
      const parsed = await readJson<KeepalivePrefix>(request);
      if (!parsed.ok) return parsed.response;
      keepalive.arm(parsed.value);
      return jsonResponse({ ok: true });
    }

    // Re-arm from the daemon's persisted copy at character startup. The
    // provider's cache does not cool when shore restarts, so a schedule that is
    // still provably warm is worth taking up; `restore` decides whether it is.
    if (url.pathname === "/v1/keepalive/restore") {
      const parsed = await readJson<KeepaliveRestore>(request);
      if (!parsed.ok) return parsed.response;
      const { character, max_idle_secs, ...snapshot } = parsed.value;
      return jsonResponse({ rearmed: keepalive.restore(character, snapshot, max_idle_secs) });
    }

    if (url.pathname === "/v1/keepalive/disarm") {
      const parsed = await readJson<{ character: string }>(request);
      if (!parsed.ok) return parsed.response;
      keepalive.disarm(parsed.value.character);
      return jsonResponse({ ok: true });
    }

    // Drained by the daemon's autonomy tick: it still owns the heartbeat log
    // and the persisted state, so what happened here has to reach it. Scoped to
    // the draining character, because that tick can only reach its own state.
    // The `keepalive_ping_now` diagnostic. Fires a real, billed, recorded call
    // but deliberately leaves the schedule alone — see `pingNow`.
    if (url.pathname === "/v1/keepalive/ping-now") {
      const parsed = await readJson<{ character: string }>(request);
      if (!parsed.ok) return parsed.response;
      return jsonResponse(await keepalive.pingNow(parsed.value.character));
    }

    if (url.pathname === "/v1/keepalive/drain") {
      const parsed = await readJson<{ character?: string }>(request);
      if (!parsed.ok) return parsed.response;
      return jsonResponse(keepalive.drain(parsed.value.character));
    }

    if (url.pathname === "/v1/image") {
      const parsed = await readJson<ImageRequest>(request);
      if (!parsed.ok) return parsed.response;
      try {
        const result = await imageGenerate(parsed.value, request.signal);
        return jsonResponse(result);
      } catch (e) {
        return errorResponse(e);
      }
    }

    return textError(404, "not found");
  };
}

export function serveSidecar(socketPath: string): ReturnType<typeof Bun.serve> {
  if (existsSync(socketPath)) {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) {
      throw new Error(`refusing to replace non-socket path: ${socketPath}`);
    }
    unlinkSync(socketPath);
  }
  // The live keepalive: built here so its two effects — observing every
  // recorded call, and running a clock — belong to a real server rather than to
  // anything that merely builds a handler.
  const keepalive = new KeepaliveService((req, signal) => {
    const provider = DEFAULT_PROVIDERS[req.sdk];
    if (!provider) throw new Error(`unsupported sdk: ${req.sdk}`);
    return provider.generate(req, signal);
  });
  setCallObserver((ctx, model, callType) => {
    keepalive.observe(ctx.character, model, callType, ctx.keepalive_max_secs);
  });
  startKeepaliveTimer(keepalive);

  const server = Bun.serve({
    unix: socketPath,
    fetch: createSidecarHandler({ keepalive }),
  });
  chmodSync(socketPath, 0o600);
  return server;
}

async function streamResponse(
  source: (signal: AbortSignal) => AsyncIterable<StreamEvent>,
  requestSignal: AbortSignal,
  heartbeatMs: number,
): Promise<Response> {
  const abort = new AbortController();
  const abortUpstream = () => abort.abort();
  if (requestSignal.aborted) abortUpstream();
  requestSignal.addEventListener("abort", abortUpstream, { once: true });

  const iterator = source(abort.signal)[Symbol.asyncIterator]();
  let first: IteratorResult<StreamEvent>;
  try {
    first = await iterator.next();
  } catch (e) {
    requestSignal.removeEventListener("abort", abortUpstream);
    return errorResponse(e);
  }
  if (first.done) {
    requestSignal.removeEventListener("abort", abortUpstream);
    return textError(502, "provider stream ended before start");
  }

  const encoder = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        requestSignal.removeEventListener("abort", abortUpstream);
        controller.close();
      };

      write(first.value);
      void (async () => {
        try {
          for (;;) {
            if (abort.signal.aborted) break;
            // Race the next provider event against a heartbeat timer. If the
            // provider stays quiet (a thinking model emitting only un-forwarded
            // `ping`s), write our own `ping` to keep the daemon↔sidecar socket
            // from going idle — Bun's per-request timeout override does not
            // cover a streaming body, so this keepalive is what actually holds
            // the connection open. Re-race the SAME pending `next` promise each
            // tick so we never drop an event.
            const next = iterator.next();
            let settled: IteratorResult<StreamEvent> | undefined;
            while (settled === undefined) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const beat = new Promise<"ping">((resolve) => {
                timer = setTimeout(() => resolve("ping"), heartbeatMs);
              });
              const raced = await Promise.race([next, beat]);
              clearTimeout(timer);
              if (raced === "ping") {
                if (abort.signal.aborted) break;
                write({ type: "ping" });
              } else {
                settled = raced;
              }
            }
            if (settled === undefined || settled.done) break;
            write(settled.value);
          }
        } catch {
          // The iterator itself threw (rather than yielding a terminal `error`
          // event, which providers normally do via streamErrorEvent). Close
          // without `done` so the Rust StreamConsumer reports IncompleteStream.
        } finally {
          close();
        }
      })();
    },
    cancel() {
      closed = true;
      abort.abort();
      requestSignal.removeEventListener("abort", abortUpstream);
      void iterator.return?.();
    },
  });

  return new Response(body, { status: 200, headers: NDJSON_HEADERS });
}

async function readJson<T>(request: Request): Promise<
  | { ok: true; value: T }
  | { ok: false; response: Response }
> {
  try {
    return { ok: true, value: (await request.json()) as T };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, response: textError(400, `invalid json: ${message}`) };
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(e: unknown): Response {
  const status = errorStatus(e);
  return textError(status, errorBody(e));
}

function textError(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/**
 * A call refused by a usage budget.
 *
 * `402 Payment Required` rather than a 4xx the provider might also return: the
 * daemon maps this one status back to the same error it used to raise itself,
 * so the text the user reads is unchanged by the move. Nothing is recorded —
 * no call was made, and a ledger row here would be a call that never happened.
 */
function budgetRefusal(block: BudgetBlock): Response {
  console.warn(
    `shore: LLM call blocked by usage budget "${block.budget_name}" ` +
      `(${block.scope}, $${block.current_cost}/$${block.cost_limit}, action ${block.action})`,
  );
  return textError(BUDGET_BLOCKED_STATUS, block.message);
}

function errorStatus(e: unknown): number {
  const err = e as HttpishError;
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (typeof status === "number" && status >= 400 && status <= 599) return status;
  return 502;
}

function errorBody(e: unknown): string {
  const err = e as HttpishError;
  const body = err.body ?? err.error ?? err.response?.data ?? err.response?.body;
  if (typeof body === "string") return body;
  if (body !== undefined) {
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  return e instanceof Error ? e.message : String(e);
}

function socketPathFromArgs(args: string[]): string | undefined {
  const idx = args.indexOf("--socket");
  if (idx >= 0) return args[idx + 1];
  return process.env["SHORE_LLM_SOCKET"];
}

if (import.meta.main) {
  const socketPath = socketPathFromArgs(process.argv.slice(2));
  if (!socketPath) {
    console.error("usage: bun run src/server.ts --socket <path>");
    process.exit(2);
  }
  const server = serveSidecar(socketPath);
  console.error(`shore llm sidecar listening on ${socketPath}`);
}
