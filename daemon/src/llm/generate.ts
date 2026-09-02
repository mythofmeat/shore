import { shoreLog } from "../log.ts";

import { budgetBlockFor } from "../ledger/gate.ts";
import { beginCallAttempt, recordGenerate, recordGenerateError, recordingStream } from "../ledger/record.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { ResolvedModel } from "../config/models.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { readCandidateEnv, resolveKeyCandidates, type KeyCandidate } from "./credentials.ts";
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
import { rustJoin } from "../config/dirs.ts";
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
  request.context ??= {
    ledger: rustJoin(deps.config.dirs.data, "ledger.db"),
    character: "unknown",
    call_type: "message",
    thinking_enabled: request.provider_options?.thinking_enabled === true,
    usage: usageConfigView(deps.config.app.usage),
  };
  request.context.ledger ??= rustJoin(deps.config.dirs.data, "ledger.db");
  request.context.usage ??= usageConfigView(deps.config.app.usage);
}

function providerFor(request: SidecarRequest, deps: GenerateDeps): SidecarProvider {
  const provider = deps.providers[request.sdk];
  if (provider === undefined) throw new Error(`unsupported sdk: ${request.sdk}`);
  return provider;
}

async function callProvider(
  request: SidecarRequest,
  deps: GenerateDeps,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  const provider = providerFor(request, deps);
  ensureCallContext(request, deps);

  const blocked = budgetBlockFor(request);
  if (blocked) throw BudgetBlocked.from(blocked);
  const attempt = beginCallAttempt(request.context, request);

  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  try {
    const response = await provider.generate(request, signal);
    await attempt.pricingReady;
    recordGenerate(request.context, request, response, attempt);
    return response;
  } catch (e) {
    await attempt.pricingReady;
    recordGenerateError(request.context, request, startedAt, clock, attempt, e);
    throw e;
  }
}

export async function generateWithCredentialFallback(
  request: SidecarRequest,
  resolved: KeySource,
  deps: GenerateDeps,
  signal?: AbortSignal,
): Promise<GenerateOutcome> {
  const entry = deps.config.providers.get(resolved.providerKey);
  const candidates = resolveKeyCandidates(
    resolved.providerKey,
    entry === undefined ? undefined : credentialEntry(entry),
    resolved.apiKeyEnv,
  );

  const fallbacks: FallbackEvent[] = [];
  const response = await streamWithCredentialFallback(
    resolved.providerKey,
    candidates,
    (candidate) => readCandidateEnv(candidate, deps.env ?? process.env),
    (apiKey, candidate) =>
      streamWithRetry(
        () => {
          request.api_key = apiKey;
          if (request.context !== undefined) request.context.api_key_name = candidate.name;
          return callProvider(request, deps, signal);
        },
        deps.retry ?? DEFAULT_RETRY,
        undefined,
        deps.sleep,
        signal === undefined ? {} : { signal },
      ),
    { record: (event) => fallbacks.push(event) },
  );

  return { response, fallbacks };
}

export async function generate(
  request: SidecarRequest,
  deps: GenerateDeps,
  signal?: AbortSignal,
): Promise<GenerateOutcome> {
  const resolved = resolveModelForRequest(deps.config, request);
  if (resolved !== undefined) {
    return await generateWithCredentialFallback(request, resolved, deps, signal);
  }
  if (request.api_key === "") {
    return await generateWithCredentialFallback(
      request,
      { providerKey: request.provider_key ?? request.sdk },
      deps,
      signal,
    );
  }
  shoreLog.debug(
    `shore: ${request.provider_key ?? request.sdk}/${request.model} is not in the static catalog; ` +
      `calling with the request's own key`,
  );
  return { response: await callProvider(request, deps, signal), fallbacks: [] };
}

export interface StreamedGenerateOptions {
  sink?: FrameSink;
  signal?: AbortSignal;
}

function responseFromStream(result: StreamResult, fallbackModel: string): GenerateResponse {
  return {
    content: result.content,
    content_blocks: result.content_blocks,
    finish_reason: result.finish_reason,
    usage: result.usage,
    timing: result.timing,
    model: result.model === "" ? fallbackModel : result.model,
  };
}

export async function generateViaStream(
  request: SidecarRequest,
  resolved: KeySource,
  deps: GenerateDeps,
  options: StreamedGenerateOptions = {},
): Promise<GenerateOutcome> {
  const provider = providerFor(request, deps);
  ensureCallContext(request, deps);

  const entry = deps.config.providers.get(resolved.providerKey);
  const candidates = resolveKeyCandidates(
    resolved.providerKey,
    entry === undefined ? undefined : credentialEntry(entry),
    resolved.apiKeyEnv,
  );

  let retrySafe = true;
  const downstream: FrameSink = options.sink ?? (() => {});
  const sink: FrameSink = (message) => {
    if (message.type === "stream_chunk" || message.type === "tool_call") retrySafe = false;
    downstream(message);
  };
  const fallbacks: FallbackEvent[] = [];

  const attempt = async (apiKey: string, candidate: KeyCandidate): Promise<GenerateResponse> => {
    request.api_key = apiKey;
    if (request.context !== undefined) request.context.api_key_name = candidate.name;

    const blocked = budgetBlockFor(request);
    if (blocked) throw BudgetBlocked.from(blocked);
    const started = beginCallAttempt(request.context, request);

    const outcome = await consumeStream(
      recordingStream(
        request.context,
        request,
        provider.stream(request, options.signal),
        started,
      ),
      { regen: false, sink },
    );
    if ("err" in outcome) throw outcome.err;
    return responseFromStream(outcome.ok, request.model);
  };

  const response = await streamWithCredentialFallback(
    resolved.providerKey,
    candidates,
    (candidate) => readCandidateEnv(candidate, deps.env ?? process.env),
    (apiKey, candidate) =>
      streamWithRetry(
        () => attempt(apiKey, candidate),
        deps.retry ?? DEFAULT_RETRY,
        (error, attemptIndex, maxRetries) =>
          retrySafe &&
          shouldRetryError(error, attemptIndex, { max_retries: maxRetries }).decision === "retry",
        deps.sleep,
        options.signal === undefined ? {} : { signal: options.signal },
      ),
    {
      record: (event) => fallbacks.push(event),
      canFallback: () => retrySafe,
    },
  );

  return { response, fallbacks };
}
