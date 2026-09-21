import { withToolImages } from "./tool_images.ts";
import { imageSupportFor, recordImageRejection } from "./image_support.ts";
import { withCallCapture, type CallRecorder } from "./capture.ts";
import { toolLoopEvents } from "./tool_loop.ts";
import type { ToolPhase } from "../tools/execute.ts";
import type { ToolLoopOptions } from "./types.ts";
import { required } from "../util/required.ts";
import { AbortError } from "./abort.ts";
import type { ModelCallRetryOptions } from "./providers/generic_loop.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import {
  beginCallAttempt,
  prepareCallAccounting,
  recordingStream,
} from "../ledger/record.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { ResolvedModel } from "../config/models.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { isKeylessSdk, KEYLESS_CANDIDATE, readCandidateEnv, resolveKeyCandidates } from "./credentials.ts";
import { MissingApiKey } from "./request.ts";
import {
  streamWithCredentialFallback,
  streamWithRetry,
  DEFAULT_RETRY,
  type FallbackEvent,
  type RetrySettings,
  type Sleep,
} from "./fallback.ts";
import { consumeStream, type FrameSink, type StreamResult } from "./stream.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "./types.ts";
import { characterWorkspaceDir, rustJoin } from "../config/dirs.ts";
import { usageConfigView, type BudgetBlock } from "../ledger/budget.ts";
import { shouldRetryError } from "./retry.ts";

export class BudgetBlocked extends Error {
  readonly kind = "budget_blocked" as const;
  readonly scope: string | undefined;
  readonly resetAt: string | undefined;
  readonly summary: string | undefined;

  constructor(message: string, scope?: string, resetAt?: string, summary?: string) {
    super(message);
    this.name = "BudgetBlocked";
    this.scope = scope;
    this.resetAt = resetAt;
    this.summary = summary;
  }

  static from(block: BudgetBlock): BudgetBlocked {
    return new BudgetBlocked(block.message, block.scope, block.reset_at, block.summary);
  }
}

export interface GenerateDeps {
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  config: LoadedConfig;
  callStore?: CallRecorder;
  env?: NodeJS.ProcessEnv;
  sleep?: Sleep;
  retry?: RetrySettings;
  now?: () => number;
}

export interface KeySource {
  providerKey: string;
  apiKeyEnv?: string | undefined;
}

export interface GenerateOutcome {
  response: GenerateResponse;
  fallbacks: FallbackEvent[];
}

export function withResolvedCredential(
  request: SidecarRequest,
  config: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): SidecarRequest {
  if (isKeylessSdk(request.sdk)) return { ...request, api_key: "" };
  const providerKey = request.provider_key ?? request.sdk;
  const entry = config.providers.get(providerKey);
  const candidates = resolveKeyCandidates(
    providerKey,
    entry === undefined ? undefined : credentialEntry(entry),
  );
  for (const candidate of candidates) {
    const apiKey = readCandidateEnv(candidate, env);
    if (apiKey !== undefined) return { ...request, api_key: apiKey };
  }
  if (request.api_key !== "") return request;
  throw new MissingApiKey(candidates[0]?.env ?? providerKey);
}

export function resolveModelForRequest(
  config: LoadedConfig,
  request: SidecarRequest,
): ResolvedModel | undefined {
  for (const model of config.models.chat.values()) {
    if (model.modelId !== request.model) continue;
    if (model.sdk !== request.sdk) continue;
    if (request.provider_key !== undefined && request.provider_key !== model.providerKey) continue;
    return model;
  }
  return undefined;
}

function ensureCallContext(request: SidecarRequest, deps: GenerateDeps): void {
  const character = request.context?.character;
  request.context ??= {
    ledger: rustJoin(deps.config.dirs.data, "shore.db"),
    character: "unknown",
    call_type: "message",
    thinking_enabled: request.provider_options?.thinking_enabled === true,
    usage: usageConfigView(deps.config.app.usage),
  };
  request.context.ledger ??= rustJoin(deps.config.dirs.data, "shore.db");
  request.context.usage ??= usageConfigView(deps.config.app.usage);
  if (request.sdk === "claude_agent" && character !== undefined) {
    request.context.workspace_dir ??= characterWorkspaceDir(deps.config.dirs.config, character, deps.config.dirs.workspace);
  }
}

function providerFor(request: SidecarRequest, deps: GenerateDeps): SidecarProvider {
  const provider = deps.providers[request.sdk];
  if (provider === undefined) throw new Error(`unsupported sdk: ${request.sdk}`);
  return withCallCapture(provider, deps.callStore);
}

export interface StreamedGenerateOptions {
  sink?: FrameSink;
  signal?: AbortSignal;
}

export interface GenerationOptions extends StreamedGenerateOptions {
  tools?: ToolPhase | ((request: SidecarRequest, sink: FrameSink) => ToolPhase | undefined);
  toolLoop?: ToolLoopOptions;
  regen?: boolean;
  rid?: string;
  onFallback?: (event: FallbackEvent) => void;
  onRetry?: import("./fallback.ts").RetryContext["onRetry"];
  useRequestKey?: boolean;
}

export async function runGeneration(
  request: SidecarRequest,
  resolved: KeySource,
  deps: GenerateDeps,
  options: GenerationOptions = {},
): Promise<{ result: StreamResult; fallbacks: FallbackEvent[] }> {
  if ((request.tools?.length ?? 0) > 0 && options.tools === undefined) {
    throw new Error("Tool-capable generation requires a tool executor");
  }
  if (options.signal?.aborted) throw new AbortError();
  ensureCallContext(request, deps);
  const retry = deps.retry ?? {
    ...DEFAULT_RETRY,
    maxRetries: deps.config.app.advanced.max_retries ?? DEFAULT_RETRY.maxRetries,
    backoffBaseMs: deps.config.app.advanced.retry_backoff?.asMillis() ?? DEFAULT_RETRY.backoffBaseMs,
  };
  const callRetry: ModelCallRetryOptions = {
    settings: retry,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })),
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
  };
  const entry = deps.config.providers.get(resolved.providerKey);
  const candidates = isKeylessSdk(request.sdk)
    ? [KEYLESS_CANDIDATE]
    : options.useRequestKey
      ? [{ name: "request", env: "", warn_on_fallback: false }]
      : resolveKeyCandidates(
          resolved.providerKey,
          entry === undefined ? undefined : credentialEntry(entry),
          resolved.apiKeyEnv,
        );

  let replaySafe = true;
  let toolLoopUsed = false;
  const sink: FrameSink = (message) => {
    if (message.type === "stream_chunk" || message.type === "tool_call" ||
        message.type === "tool_result" || message.type === "send_image") replaySafe = false;
    options.sink?.(message);
  };
  const model = resolveModelForRequest(deps.config, request);
  const declaredImages = request.supports_images ?? model?.supportsImages;
  const provider = withToolImages(providerFor(request, deps), {
    support: (call) => imageSupportFor({
      ...(declaredImages === undefined ? {} : { declared: declaredImages }),
      ...(model?.discoveredSupportsImages === undefined ? {} : { discovered: model.discoveredSupportsImages }),
      providerKey: call.provider_key ?? call.sdk, modelId: call.model,
    }, deps.config.dirs.cache),
    rejected: (call) => recordImageRejection(deps.config.dirs.cache, call.provider_key ?? call.sdk, call.model),
    warn: (message) => sink({ type: "provider_warning", rid: options.rid ?? null, message }),
  });
  const fallbacks: FallbackEvent[] = [];
  const attempt = async (apiKey: string, name: string): Promise<StreamResult> => {
    if (options.signal?.aborted) throw new AbortError();
    request.api_key = apiKey;
    const call = {
      ...request,
      messages: [...request.messages],
      context: { ...required(request.context), api_key_name: name },
    };
    await prepareCallAccounting(call);
    const blocked = budgetBlockFor(call);
    if (blocked) throw BudgetBlocked.from(blocked);
    const started = beginCallAttempt(call.context, call);
    const events = (async function* () {
      const tools = typeof options.tools === "function" ? options.tools(call, sink) : options.tools;
      if ((call.tools?.length ?? 0) > 0 && tools === undefined) {
        throw new Error("Tool-capable generation requires a tool executor");
      }
      toolLoopUsed = tools !== undefined;
      const source = tools === undefined
        ? provider.stream(call, options.signal)
        : toolLoopEvents(provider, call, tools, options.signal, callRetry, options.toolLoop);
      for await (const event of source) {
        if (event.type === "tool_use") replaySafe = false;
        yield event;
      }
    })();
    const outcome = await consumeStream(
      recordingStream(call.context, call, events, started, (nextRequest, callType) => {
        const continued = {
          ...nextRequest,
          context: { ...required(nextRequest.context), call_type: callType },
        };
        const block = budgetBlockFor(continued);
        if (block) throw BudgetBlocked.from(block);
        return beginCallAttempt(continued.context, continued);
      }),
      { regen: options.regen ?? false, sink, ...(options.rid === undefined ? {} : { rid: options.rid }) },
    );
    if ("err" in outcome) throw outcome.err.kind === "stream_errored" ? outcome.err.cause ?? outcome.err : outcome.err;
    return outcome.ok;
  };
  const result = await streamWithCredentialFallback(
    resolved.providerKey,
    candidates,
    (candidate) => candidate.env === ""
      ? (isKeylessSdk(request.sdk) ? "" : request.api_key)
      : readCandidateEnv(candidate, deps.env ?? process.env),
    (apiKey, candidate) => {
      return streamWithRetry(
        () => attempt(apiKey, candidate.name),
        retry,
        (error, attemptIndex, maxRetries) => !toolLoopUsed && replaySafe &&
          shouldRetryError(error, attemptIndex, { max_retries: maxRetries }).decision === "retry",
        deps.sleep,
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
        },
      );
    },
    {
      record: (event) => { fallbacks.push(event); options.onFallback?.(event); },
      canFallback: () => replaySafe,
    },
  );
  return { result, fallbacks };
}

export async function generateViaStream(
  request: SidecarRequest,
  resolved: KeySource,
  deps: GenerateDeps,
  options: GenerationOptions = {},
): Promise<GenerateOutcome> {
  const { result, fallbacks } = await runGeneration(request, resolved, deps, options);
  return {
    response: {
      content: result.content,
      content_blocks: result.content_blocks,
      finish_reason: result.finish_reason,
      usage: result.usage,
      timing: result.timing,
      model: result.model === "" ? request.model : result.model,
    },
    fallbacks,
  };
}

export async function generateWithCredentialFallback(
  request: SidecarRequest,
  resolved: KeySource,
  deps: GenerateDeps,
  signal?: AbortSignal,
): Promise<GenerateOutcome> {
  return generateViaStream(request, resolved, deps, signal === undefined ? {} : { signal });
}

export async function generate(
  request: SidecarRequest,
  deps: GenerateDeps,
  signal?: AbortSignal,
  options: GenerationOptions = {},
): Promise<GenerateOutcome> {
  const resolved = resolveModelForRequest(deps.config, request);
  return generateViaStream(
    request,
    resolved ?? { providerKey: request.provider_key ?? request.sdk },
    deps,
    {
      ...options,
      ...(signal === undefined ? {} : { signal }),
      useRequestKey: resolved === undefined && request.api_key !== "",
    },
  );
}
