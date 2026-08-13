import { Ledger, type RecordCall, type Timing, type Usage } from "./store.ts";
import { toolSurfaceFingerprint } from "./tool_surface.ts";
import { estimateTokens } from "../engine/tokens.ts";
import type { CallContext, GenerateResponse, SidecarRequest, StreamEvent } from "../llm/types.ts";

const ledgers = new Map<string, Ledger | null>();

export function ledgerFor(path: string): Ledger | null {
  const existing = ledgers.get(path);
  if (existing !== undefined) return existing;
  let opened: Ledger | null = null;
  try {
    opened = Ledger.open(path);
  } catch (e) {
    try {
      opened = Ledger.create(path);
    } catch (createError) {
      console.error(
        `shore: cannot open or create ledger at ${path}: ${String(e)}; ${String(createError)}`,
      );
    }
  }
  ledgers.set(path, opened);
  return opened;
}

export function closeLedgers(): void {
  for (const ledger of ledgers.values()) ledger?.close();
  ledgers.clear();
}

export function continuationOf(callType: string): string {
  switch (callType) {
    case "message":
    case "tool_loop":
    case "subagent":
      return "tool_loop";
    case "heartbeat":
    case "heartbeat_tool_loop":
      return "heartbeat_tool_loop";
    default:
      return callType;
  }
}

export function cacheTtlSeconds(ttl: string | undefined): number | undefined {
  switch (ttl) {
    case "5m":
      return 300;
    case "1h":
      return 3600;
    default:
      return undefined;
  }
}

const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
} as const;

interface Recorded {
  usage: Usage;
  timing: Timing;
  finish_reason: string;
  call_type?: string;
  output_tokens_estimated?: boolean;
}

export interface CallAttempt {
  ledger: Ledger;
  id: string;
}

type CallObserver = (
  ctx: CallContext,
  model: string,
  callType: string,
  req: SidecarRequest,
) => void;

let observer: CallObserver | undefined;

export function setCallObserver(fn: CallObserver | undefined): void {
  observer = fn;
}

function callLanded(finishReason: string): boolean {
  return finishReason !== "error" && finishReason !== "cancelled";
}

function record(
  ctx: CallContext,
  req: SidecarRequest,
  call: Recorded,
  attempt?: CallAttempt,
): void {
  if (ctx.ledger === undefined) return;
  const ledger = attempt?.ledger ?? ledgerFor(ctx.ledger);
  if (ledger === null) return;
  if (ctx.keepalive_max_secs !== undefined) ledger.setMaxIdleSecs(ctx.keepalive_max_secs);
  const ttl = cacheTtlSeconds(ctx.cache_ttl);
  if (ttl !== undefined) ledger.setCacheTtlSecs(ttl);

  const entry: RecordCall = {
    provider: req.provider_key ?? req.sdk,
    api_key_name: ctx.api_key_name,
    model: req.model,
    call_type: call.call_type ?? ctx.call_type,
    character: ctx.character,
    usage: call.usage,
    timing: call.timing,
    finish_reason: call.finish_reason,
    thinking_enabled: ctx.thinking_enabled,
    cache_ttl: ctx.cache_ttl,
    reasoning_effort: ctx.reasoning_effort,
    tool_surface: toolSurfaceFingerprint(req.tools),
    ...(call.output_tokens_estimated === true ? { output_tokens_estimated: true } : {}),
    ...(ctx.thinking_dropped === undefined ? {} : { thinking_dropped: ctx.thinking_dropped }),
  };
  const row = ledger.record(entry, () => new Date(), attempt?.id);
  if (row.cache_anomaly !== null) {
    notifyAnomaly(ctx, entry, row.cache_anomaly);
  }
}

function tryRecord(
  ctx: CallContext,
  req: SidecarRequest,
  call: Recorded,
  attempt?: CallAttempt,
): void {
  try {
    record(ctx, req, call, attempt);
  } catch (e) {
    console.error(`shore: failed to record ledger row: ${String(e)}`);
  }
  const finishReason = call.finish_reason;
  if (observer === undefined || !callLanded(finishReason)) return;
  try {
    observer(ctx, req.model, call.call_type ?? ctx.call_type, req);
  } catch (e) {
    console.error(`shore: call observer failed: ${String(e)}`);
  }
}

export function beginCallAttempt(
  ctx: CallContext | undefined,
  req: SidecarRequest,
  callType?: string,
): CallAttempt {
  if (ctx?.ledger === undefined) {
    throw new Error(
      `refusing unaccounted LLM call for ${req.provider_key ?? req.sdk}/${req.model}: ` +
        "request context has no ledger",
    );
  }
  const ledger = ledgerFor(ctx.ledger);
  if (ledger === null) {
    throw new Error(`refusing LLM call because the usage ledger is unavailable: ${ctx.ledger}`);
  }
  const provider = req.provider_key ?? req.sdk;
  const effectiveCallType = callType ?? ctx.call_type;
  const estimate = recentAttemptEstimate(ledger, provider, req.model, effectiveCallType);
  return {
    ledger,
    id: ledger.beginAttempt(
      {
        provider,
        api_key_name: ctx.api_key_name,
        model: req.model,
        call_type: effectiveCallType,
        character: ctx.character,
      },
      estimate,
    ),
  };
}

function recentAttemptEstimate(
  ledger: Ledger,
  provider: string,
  model: string,
  callType: string,
): number | undefined {
  const row = ledger.database.query(
    `SELECT AVG(total_cost) AS estimate FROM (
       SELECT total_cost FROM calls
        WHERE provider = $provider AND model = $model AND call_type = $call_type
          AND total_cost IS NOT NULL AND total_cost > 0
        ORDER BY id DESC LIMIT 20
     )`,
  ).get({ $provider: provider, $model: model, $call_type: callType }) as
    | { estimate?: unknown }
    | null;
  return typeof row?.estimate === "number" && Number.isFinite(row.estimate)
    ? row.estimate
    : recentModelEstimate(ledger, provider, model);
}

function recentModelEstimate(
  ledger: Ledger,
  provider: string,
  model: string,
): number | undefined {
  const row = ledger.database.query(
    `SELECT AVG(total_cost) AS estimate FROM (
       SELECT total_cost FROM calls
        WHERE provider = $provider AND model = $model
          AND total_cost IS NOT NULL AND total_cost > 0
        ORDER BY id DESC LIMIT 20
     )`,
  ).get({ $provider: provider, $model: model }) as { estimate?: unknown } | null;
  return typeof row?.estimate === "number" && Number.isFinite(row.estimate)
    ? row.estimate
    : undefined;
}

function notifyAnomaly(ctx: CallContext, call: RecordCall, anomaly: string): void {
  if (ctx.forensics_dir === undefined) return;
  const body =
    `${call.character} (${call.call_type})\n` +
    `read=${call.usage.cache_read_tokens} write=${call.usage.cache_creation_tokens}`;
  try {
    Bun.spawn(["notify-send", "--urgency=normal", "--app-name=shore", `shore: cache ${anomaly}`, body], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
  }
}

export async function* recordingStream(
  ctx: CallContext | undefined,
  req: SidecarRequest,
  source: AsyncIterable<StreamEvent>,
  initialAttempt?: CallAttempt,
  beforeContinuation: (request: SidecarRequest, callType: string) => CallAttempt =
    (request, callType) => beginCallAttempt(request.context, request, callType),
): AsyncIterable<StreamEvent> {
  if (ctx === undefined) {
    yield* source;
    return;
  }
  let recorded = 0;
  let attempt = initialAttempt;
  const trackAttempts = initialAttempt !== undefined;
  let streamedText = "";
  const partialUsage = (): { usage: Usage; estimated: boolean } => {
    if (streamedText === "") return { usage: NO_USAGE, estimated: false };
    return {
      usage: { ...NO_USAGE, output_tokens: estimateTokens(streamedText) },
      estimated: true,
    };
  };
  try {
    for await (const event of source) {
      if (event.type === "text" || event.type === "thinking") streamedText += event.text;
      if (event.type === "call_complete") {
        tryRecord(ctx, req, {
          usage: event.usage,
          timing: event.timing,
          finish_reason: event.finish_reason,
          call_type: event.continuation ? continuationOf(ctx.call_type) : ctx.call_type,
        }, attempt);
        attempt = undefined;
        recorded += 1;
        if (trackAttempts && event.finish_reason === "tool_use") {
          attempt = beforeContinuation(req, continuationOf(ctx.call_type));
        }
      } else if (event.type === "done") {
        if (recorded === 0) {
          tryRecord(ctx, req, {
            usage: event.usage,
            timing: event.timing,
            finish_reason: event.finish_reason,
          }, attempt);
          attempt = undefined;
          recorded += 1;
        }
      } else if (event.type === "error") {
        const partial = partialUsage();
        const seen = recorded === 0 ? event.usage : NO_USAGE;
        const useEstimate = seen.output_tokens === 0 && partial.estimated;
        tryRecord(ctx, req, {
          usage: useEstimate ? { ...seen, output_tokens: partial.usage.output_tokens } : seen,
          timing: event.timing,
          finish_reason: "error",
          ...(useEstimate ? { output_tokens_estimated: true } : {}),
        }, attempt);
        attempt = undefined;
        recorded += 1;
      }
      yield event;
    }
  } finally {
    if (recorded === 0) {
      const partial = partialUsage();
      tryRecord(ctx, req, {
        usage: partial.usage,
        timing: { total_ms: 0, time_to_first_token_ms: 0 },
        finish_reason: "cancelled",
        ...(partial.estimated ? { output_tokens_estimated: true } : {}),
      }, attempt);
    }
  }
}

export function recordGenerate(
  ctx: CallContext | undefined,
  req: SidecarRequest,
  resp: GenerateResponse,
  attempt?: CallAttempt,
): void {
  if (ctx === undefined) return;
  tryRecord(ctx, req, {
    usage: resp.usage,
    timing: resp.timing,
    finish_reason: resp.finish_reason,
  }, attempt);
}

export function recordGenerateError(
  ctx: CallContext | undefined,
  req: SidecarRequest,
  startedAt: number,
  now: () => number = () => Date.now(),
  attempt?: CallAttempt,
): void {
  if (ctx === undefined) return;
  tryRecord(ctx, req, {
    usage: NO_USAGE,
    timing: { total_ms: now() - startedAt, time_to_first_token_ms: 0 },
    finish_reason: "error",
  }, attempt);
}
