import { required } from "../util/required.ts";

import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { configView, resolveActiveModelAndOverlay } from "../config/preferences.ts";
import { effectiveSupportsImages, type ResolvedModel } from "../config/models.ts";
import {
  countImageBlocks,
  imageSupportFor,
  isImageRejection,
  recordImageRejection,
  stripImageBlocks,
  textOnlyReason,
} from "../llm/image_support.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { Message } from "../engine/types.ts";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_RETRIES,
  streamWithCredentialFallback,
  streamWithRetry,
  type FallbackEvent,
} from "../llm/fallback.ts";
import {
  readCandidateEnv,
  resolveKeyCandidates,
  type KeyCandidate,
} from "../llm/credentials.ts";
import { anthropicToolLoopEvents } from "../llm/providers/anthropic_loop.ts";
import { capturedEvents, type CallRecorder } from "../llm/capture.ts";
import { genericToolLoopEvents } from "../llm/providers/generic_loop.ts";
import { BudgetBlocked } from "../llm/generate.ts";
import { consumeStream, type StreamResult } from "../llm/stream.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { beginCallAttempt, recordingStream } from "../ledger/record.ts";
import type {
  CallContext,
  ProviderOptions,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  WireMessage,
} from "../llm/types.ts";
import { usageConfigView } from "../ledger/budget.ts";
import { anyEnabled } from "../tools/registry.ts";
import { toolPhase, type ToolPhase } from "../tools/execute.ts";
import { toolLimitsFrom, type ToolLimitsView } from "../tools/dispatch.ts";
import { buildToolContext, credentialEntry, type ToolContextDeps } from "./tool_context.ts";
import {
  buildGenerationRequest,
  ImagesUnsupportedError,
  resolveGenerationModel,
  type SetupEngine,
} from "./setup.ts";
import {
  persistAndNotify,
  type PersistContext,
  type PersistEngine,
} from "./persistence.ts";
import type { GenerationParams, RunGeneration } from "./router.ts";
import {
  appendUserTurn,
  emitPostPersistStreamEnd,
  maybeCompact,
  notifyUserMessageIfFresh,
  ensureAndBackfillAutonomy,
  type CompactionRunner,
  type TurnAutonomy,
  type TurnContext,
  type TurnEngine,
} from "./turn.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { MAX_HISTORY_MESSAGES } from "../tools/subagent.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";
import { schemasFrom } from "../tools/validate.ts";

export interface GenerationEngine extends TurnEngine, PersistEngine, SetupEngine {}

export function generationEngine(engine: ConversationEngine): GenerationEngine {
  return {
    messages: () => engine.messages(),
    messagesThroughLastUserTurn: () => engine.messagesThroughLastUserTurn(),
    segmentCount: () => engine.segments().segmentCount(),
    segments: () => engine.segments(),
    appendMessage: (msg) => engine.appendMessage(msg),
    replaceAfterLastUserTurn: (msgs) => engine.replaceAfterLastUserTurn(msgs),
    currentRevision: () => engine.currentRevision(),
    turnCount: () => engine.turnCount(),
    pendingRegenAlt: () => engine.pendingRegenAlt(),
    reload: () => engine.reload(),
  };
}

export interface GenerationRegistry {
  getOrCreate(name: string): Promise<GenerationEngine>;
  effectiveConfig(name: string): LoadedConfig;
}

export interface GenerationDiagnostics {
  key_fallbacks: { push: (entry: KeyFallbackEntry) => void };
}

export interface KeyFallbackEntry {
  timestamp: string;
  rid?: string;
  provider: string;
  model: string;
  character: string;
  from_key: string;
  to_key?: string;
  kind: string;
  status?: number;
  reason: string;
}

export interface GenerationDeps {
  registry: GenerationRegistry;
  dataDir: string;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  callStore?: CallRecorder | undefined;
  autonomy: TurnAutonomy & PersistContext["autonomy"];
  notifier: PersistContext["notifier"];
  diagnostics: GenerationDiagnostics;
  emitEvent: (message: ServerMessage) => void;
  mcpRegistry: Pick<McpRegistry, "toolDefsFiltered" | "call">;
  compaction: CompactionRunner;
  newlyCrossedUsageBudgetWarnings: PersistContext["newlyCrossedUsageBudgetWarnings"];
  ledgerPath?: string;
  keepaliveMaxSecs?: () => number | undefined;
  tools?: (charName: string, turn: SubagentTurn) => ToolContextDeps;
  now?: () => string;
  newMessageId?: () => string;
  monotonicMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  loopEvents?: (
    provider: SidecarProvider,
    req: SidecarRequest,
    phase: ToolPhase,
    signal: AbortSignal,
  ) => AsyncIterable<StreamEvent>;
  env?: NodeJS.ProcessEnv;
  log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    error?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

const defaultNow = (): string => new Date().toISOString();
const defaultMessageId = (): string => `m_${crypto.randomUUID()}`;
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function makeRunGeneration(deps: GenerationDeps): RunGeneration {
  return (params: GenerationParams) => runGeneration(deps, params);
}

function droppedHistoryImages(
  messages: WireMessage[],
  support: boolean | undefined,
  resolved: ResolvedModel,
): WireMessage[] {
  if (support !== false || countImageBlocks(messages) === 0) return messages;

  const reason = textOnlyReason(resolved.providerKey, resolved.modelId);
  const { messages: stripped, stripped: count } = stripImageBlocks(messages, reason);
  shoreLog.warn(
    `shore: dropped ${String(count)} image(s) from history because ${reason}; ` +
      `the turn goes over the wire without them`,
  );
  return stripped;
}

export async function runGeneration(
  deps: GenerationDeps,
  params: GenerationParams,
): Promise<void> {
  const now = deps.now ?? defaultNow;
  const newMessageId = deps.newMessageId ?? defaultMessageId;
  const clock = deps.monotonicMs ?? Date.now;
  const startedAt = clock();
  const { charName, regen } = params;

  const config = deps.registry.effectiveConfig(charName);
  const engine = await deps.registry.getOrCreate(charName);

  const turnCtx: TurnContext = {
    emitEvent: deps.emitEvent,
    sendDirect: (message) => void params.send(message),
    autonomy: deps.autonomy,
    now,
    newMessageId,
  };

  const body = {
    text: params.body.text,
    images: params.body.images,
    image_data: params.body.image_data as never[],
  };

  const { model: activeModel, overlay } = resolveActiveModelAndOverlay(
    configView(config),
    charName,
    (view, cacheDir, name, includeHidden) =>
      findEffectiveModel(view, cacheDir, name, includeHidden),
  );
  const resolved = resolveGenerationModel(activeModel, config, overlay);

  const declaredImageSupport = effectiveSupportsImages(resolved);
  const imageSupport = imageSupportFor(
    {
      ...(declaredImageSupport === undefined ? {} : { declared: declaredImageSupport }),
      providerKey: resolved.providerKey,
      modelId: resolved.modelId,
    },
    config.dirs.cache,
  );

  const incomingImages = body.images.length + body.image_data.length;
  if (imageSupport === false && incomingImages > 0 && !regen) {
    throw new ImagesUnsupportedError(resolved.qualifiedName, incomingImages);
  }

  const regenAlt = await appendUserTurn(turnCtx, engine, deps.dataDir, charName, body, regen);

  await ensureAndBackfillAutonomy(turnCtx, engine, charName, config);
  notifyUserMessageIfFresh(turnCtx, engine, charName, body, regen);

  const built = await buildGenerationRequest({
    engine,
    dataDir: deps.dataDir,
    charName,
    config,
    resolved,
    regen,
    mcpRegistry: deps.mcpRegistry,
  });
  const request: SidecarRequest = {
    ...built.request,
    messages: droppedHistoryImages(built.request.messages, imageSupport, resolved),
    context: callContext(deps, config, charName, params.rid, built.keepalive_max_secs, (built.request.provider_options === undefined
        ? {}
        : { options: built.request.provider_options })),
  };

  const subagentHistory: Message[] =
    config.app.subagents.size === 0
      ? []
      : [...engine.messages()].slice(-MAX_HISTORY_MESSAGES);

  const { result, intermediate } = await streamTurn(deps, {
    config,
    charName,
    resolved,
    request,
    regen,
    conversation: subagentHistory,
    send: (message) => void params.send(message),
    ...(params.rid === null ? {} : { rid: params.rid }),
    signal: params.signal,
    now,
    newMessageId,
  }).catch((e: unknown) => {
    if (imageSupport !== false && isImageRejection(e)) {
      recordImageRejection(config.dirs.cache, resolved.providerKey, resolved.modelId);
      throw new ImagesUnsupportedError(resolved.qualifiedName, countImageBlocks(request.messages));
    }
    throw e;
  });

  applyIntermediateMessages(request, intermediate, result.model);

  const persistCtx: PersistContext = {
    emitEvent: deps.emitEvent,
    sendDirect: (message) => void params.send(message),
    autonomy: deps.autonomy,
    notifier: deps.notifier,
    newlyCrossedUsageBudgetWarnings: deps.newlyCrossedUsageBudgetWarnings,
    now,
    newMessageId,
  };
  const { context: _perCall, ...sentBody } = request;
  await persistAndNotify(persistCtx, engine, {
    charName,
    resolvedProviderKey: resolved.providerKey,
    result,
    request: {
      ...sentBody,
      ...(params.rid === null ? {} : { rid: params.rid }),
    },
    keepaliveIntervalMs: built.keepalive_interval_ms,
    keepaliveMaxSecs: built.keepalive_max_secs,
    toolIntermediateMessages: intermediate,
    wallClockMs: clock() - startedAt,
    ...(regenAlt === undefined ? {} : { regenAlt }),
  });

  emitPostPersistStreamEnd(turnCtx, engine, params.rid ?? undefined, result);

  await maybeCompact(
    turnCtx,
    engine,
    charName,
    config,
    deps.dataDir,
    result,
    params.rid ?? undefined,
    deps.compaction,
  );
}

export interface SubagentTurn {
  conversation: readonly Message[];
  send: (message: ServerMessage) => void;
  rid?: string;
  now: () => string;
  newMessageId: () => string;
  signal: AbortSignal;
}

interface StreamTurnParams {
  config: LoadedConfig;
  charName: string;
  resolved: ResolvedModel;
  request: SidecarRequest;
  regen: boolean;
  conversation: Message[];
  send: (message: ServerMessage) => void;
  rid?: string;
  signal: AbortSignal;
  now: () => string;
  newMessageId: () => string;
}

export function turnEvents(
  deps: Pick<GenerationDeps, "callStore" | "loopEvents">,
  provider: SidecarProvider,
  call: SidecarRequest,
  phase: ToolPhase | undefined,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  if (phase === undefined) return provider.stream(call, signal);
  if (deps.loopEvents !== undefined) return deps.loopEvents(provider, call, phase, signal);
  if (call.sdk === "anthropic") {
    return capturedEvents(deps.callStore, call, () =>
      anthropicToolLoopEvents(call, phase, signal),
    );
  }
  return genericToolLoopEvents(provider, call, phase, signal);
}

async function streamTurn(
  deps: GenerationDeps,
  params: StreamTurnParams,
): Promise<{ result: StreamResult; intermediate: Message[] }> {
  const { config, charName, resolved, request } = params;
  const provider = deps.providers[request.sdk];
  if (provider === undefined) {
    throw new Error(`unsupported sdk: ${request.sdk}`);
  }

  const toolsOn = anyEnabled(config.app.tools) && (request.tools?.length ?? 0) > 0;

  const toolCtx = toolsOn
    ? await buildToolContext(
        config,
        deps.dataDir,
        charName,
        deps.tools?.(charName, {
          conversation: params.conversation,
          send: params.send,
          ...(params.rid === undefined ? {} : { rid: params.rid }),
          now: params.now,
          newMessageId: params.newMessageId,
          signal: params.signal,
        }) ?? {},
      )
    : undefined;

  const retry = {
    maxRetries: config.app.advanced.max_retries ?? DEFAULT_MAX_RETRIES,
    backoffBaseMs: config.app.advanced.retry_backoff?.asMillis() ?? DEFAULT_BACKOFF_BASE_MS,
  };

  let intermediate: Message[] = [];

  const attempt = async (apiKey: string, candidate: KeyCandidate): Promise<StreamResult> => {
    const messages: Message[] = [];
    const call: SidecarRequest = {
      ...request,
      api_key: apiKey,
      messages: [...request.messages],
      ...(toolCtx === undefined || resolved.maxToolIterations === undefined
        ? {}
        : { max_tool_iterations: resolved.maxToolIterations }),
      ...(request.context === undefined
        ? {}
        : { context: { ...request.context, api_key_name: candidate.name } }),
    };

    const blocked = budgetBlockFor(call);
    if (blocked) throw BudgetBlocked.from(blocked);
    const initialAttempt = call.context?.ledger === undefined
      ? undefined
      : beginCallAttempt(call.context, call);

    const phase: ToolPhase | undefined =
      toolCtx === undefined
        ? undefined
        : toolPhase(
            {
              sendDirect: params.send,
              ctx: toolCtx,
              limits: toolLimits(config),
              ...(params.rid === undefined ? {} : { rid: params.rid }),
              now: params.now,
              newMessageId: params.newMessageId,
              schemas: schemasFrom(call.tools),
            },
            messages,
          );

    const events = turnEvents(deps, provider, call, phase, params.signal);

    const outcome = await consumeStream(recordingStream(
      call.context,
      call,
      events,
      initialAttempt,
      (nextRequest, callType) => {
        const continued = {
          ...nextRequest,
          context: { ...required(nextRequest.context), call_type: callType },
        };
        const nextBlock = budgetBlockFor(continued);
        if (nextBlock) {
          throw BudgetBlocked.from(nextBlock);
        }
        return beginCallAttempt(continued.context, continued);
      },
    ), {
      regen: params.regen,
      sink: params.send,
      ...(params.rid === undefined ? {} : { rid: params.rid }),
    });
    if ("err" in outcome) throw outcome.err;
    intermediate = messages;
    return outcome.ok;
  };

  const entry = config.providers.get(resolved.providerKey);
  const candidates = resolveKeyCandidates(
    resolved.providerKey,
    entry === undefined ? undefined : credentialEntry(entry),
    resolved.apiKeyEnv,
  );

  const result = await streamWithCredentialFallback(
    resolved.providerKey,
    candidates,
    (candidate) => readCandidateEnv(candidate, deps.env ?? process.env),
    (apiKey, candidate) =>
      streamWithRetry(
        () => attempt(apiKey, candidate),
        retry,
        undefined,
        deps.sleep ?? realSleep,
        { signal: params.signal },
      ),
    {
      record: (event) => recordKeyFallback(deps, params, event),
    },
  );

  return { result, intermediate };
}

function recordKeyFallback(
  deps: GenerationDeps,
  params: StreamTurnParams,
  event: FallbackEvent,
): void {
  deps.diagnostics.key_fallbacks.push({
    timestamp: new Date().toISOString(),
    ...(params.rid === undefined ? {} : { rid: params.rid }),
    provider: params.resolved.providerKey,
    model: params.resolved.qualifiedName,
    character: params.charName,
    from_key: event.from.name,
    ...(event.to === undefined ? {} : { to_key: event.to.name }),
    kind: event.kind,
    ...(event.status === undefined ? {} : { status: event.status }),
    reason: event.reason,
  });

  if (event.warning === undefined || event.to === undefined) return;
  params.send({
    type: "provider_fallback_warning",
    rid: params.rid ?? null,
    provider: params.resolved.providerKey,
    from_key: event.from.name,
    to_key: event.to.name,
    kind: event.kind,
    status: event.status ?? null,
    message: event.warning,
  });
}

export function applyIntermediateMessages(
  request: SidecarRequest,
  intermediate: readonly Message[],
  resultModel: string,
): void {
  const mintedModel = resultModel === "" ? undefined : resultModel;
  for (const message of intermediate) {
    const wire: WireMessage = {
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content_blocks,
      ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
      ...(mintedModel === undefined ? {} : { model: mintedModel }),
    };
    request.messages.push(wire);
  }
}

function callContext(
  deps: GenerationDeps,
  config: LoadedConfig,
  charName: string,
  rid: string | null,
  modelKeepaliveMaxSecs: number | undefined,
  call: { options?: ProviderOptions },
): CallContext {
  const ceiling = modelKeepaliveMaxSecs ?? deps.keepaliveMaxSecs?.();
  const usage = usageConfigView(config.app.usage);
  const forensics = config.app.cache.forensics ? config.dirs.cache : undefined;
  const effort = resolvedReasoningEffort(call.options);
  return {
    ...(deps.ledgerPath === undefined ? {} : { ledger: deps.ledgerPath }),
    character: charName,
    call_type: "message",
    thinking_enabled: thinkingEnabled(call.options),
    ...(call.options?.cache_ttl === undefined ? {} : { cache_ttl: call.options.cache_ttl }),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    ...(ceiling === undefined || ceiling === 0 ? {} : { keepalive_max_secs: ceiling }),
    ...(forensics === undefined ? {} : { forensics_dir: forensics }),
    ...(rid === null ? {} : { rid }),
    ...((usage.budgets ?? []).length === 0 ? {} : { usage }),
  };
}

function toolLimits(config: LoadedConfig): ToolLimitsView {
  return toolLimitsFrom(config.app.tools, config.app.subagents);
}

function thinkingEnabled(opts: ProviderOptions | undefined): boolean {
  if (opts === undefined) return false;
  if (opts.thinking_enabled === false) return false;
  return (opts.budget_tokens !== undefined && opts.budget_tokens > 0) ||
    opts.reasoning_effort !== undefined;
}

function resolvedReasoningEffort(opts: ProviderOptions | undefined): string | undefined {
  if (opts?.reasoning_effort !== undefined) return opts.reasoning_effort;
  return opts?.thinking_enabled === false ? "off" : undefined;
}
