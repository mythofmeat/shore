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
import type { FallbackEvent } from "../llm/fallback.ts";
import type { CallRecorder } from "../llm/capture.ts";
import { describeError } from "../llm/errors.ts";
import { runGeneration as runModelGeneration } from "../llm/generate.ts";
import type { StreamResult } from "../llm/stream.ts";
import type {
  CallContext,
  ProviderOptions,
  SidecarProvider,
  SidecarRequest,
  WireMessage,
} from "../llm/types.ts";
import { usageConfigView } from "../ledger/budget.ts";
import { anyEnabled } from "../tools/registry.ts";
import { toolPhase } from "../tools/execute.ts";
import { toolLimitsFrom, type ToolLimitsView } from "../tools/dispatch.ts";
import { buildToolContext, type ToolContextDeps } from "./tool_context.ts";
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
import { threadModelOf, type ThreadRecord } from "../engine/threads.ts";
import { liveThread } from "./commands.ts";
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
import type { MemoryRecallRunner } from "../memory/recall.ts";
import type { MemoryRecallEntry } from "../diagnostics.ts";

export interface GenerationEngine extends TurnEngine, PersistEngine, SetupEngine {
  readonly thread: string;
}

export function generationEngine(engine: ConversationEngine): GenerationEngine {
  return {
    thread: engine.thread,
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
  getOrCreate(name: string, thread?: string): Promise<GenerationEngine>;
  effectiveConfig(name: string): LoadedConfig;
  listThreads(name: string): readonly ThreadRecord[];
}

export interface GenerationDiagnostics {
  key_fallbacks: { push: (entry: KeyFallbackEntry) => void };
  memory_recall?: { push: (entry: MemoryRecallEntry) => void };
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
  recall?: MemoryRecallRunner | undefined;
  newlyCrossedUsageBudgetWarnings: PersistContext["newlyCrossedUsageBudgetWarnings"];
  ledgerPath?: string;
  keepaliveMaxSecs?: () => number | undefined;
  tools?: (charName: string, turn: SubagentTurn) => ToolContextDeps;
  now?: () => string;
  newMessageId?: () => string;
  monotonicMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    warn?: (msg: string, fields?: Record<string, unknown>) => void;
    error?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

const defaultNow = (): string => new Date().toISOString();
const defaultMessageId = (): string => `m_${crypto.randomUUID()}`;

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

export class OrderedDelivery {
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;
  #failed = false;

  constructor(private readonly target: GenerationParams["send"]) {}

  readonly send: GenerationParams["send"] = (message) => {
    const dispatched = this.#tail.then(() => this.target(message));
    this.#tail = dispatched.catch((error: unknown) => {
      if (!this.#failed) this.#failure = error;
      this.#failed = true;
    });
    return this.#tail;
  };

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#failed) {
      throw new Error("failed to deliver one or more generation frames", {
        cause: this.#failure,
      });
    }
  }
}

export async function runGeneration(
  deps: GenerationDeps,
  params: GenerationParams,
): Promise<void> {
  const delivery = new OrderedDelivery(params.send);
  let generationFailure: unknown;
  let generationFailed = false;
  try {
    await runGenerationCore(deps, { ...params, send: delivery.send }, () => delivery.flush());
  } catch (error) {
    generationFailure = error;
    generationFailed = true;
  }

  try {
    await delivery.flush();
  } catch (error) {
    deps.log?.error?.("generation frame delivery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!generationFailed) throw error;
  }
  if (generationFailed) throw generationFailure;
}

async function runGenerationCore(
  deps: GenerationDeps,
  params: GenerationParams,
  flushFrames: () => Promise<void>,
): Promise<void> {
  const now = deps.now ?? defaultNow;
  const newMessageId = deps.newMessageId ?? defaultMessageId;
  const clock = deps.monotonicMs ?? Date.now;
  const startedAt = clock();
  const { charName, regen } = params;

  const config = deps.registry.effectiveConfig(charName);
  const engine = await deps.registry.getOrCreate(
    charName,
    liveThread(deps.registry, charName, params.meta.session.selectedThread),
  );

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
    threadModelOf(deps.registry.listThreads(charName), engine.thread),
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

  let recalledMemory: string | undefined;
  const recallMessages = regen
    ? engine.messagesThroughLastUserTurn()
    : engine.messages();
  if (
    regen ||
    body.text !== "" ||
    body.images.length > 0 ||
    body.image_data.length > 0
  ) {
    try {
      recalledMemory = await deps.recall?.run({
        config,
        character: charName,
        messages: recallMessages,
        signal: params.signal,
        ...(params.rid === null ? {} : { rid: params.rid }),
      });
    } catch (error) {
      deps.log?.warn?.("memory recall failed open", {
        character: charName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
    messages: withRegenGuidance(
      withRecalledMemory(
        droppedHistoryImages(built.request.messages, imageSupport, resolved),
        recalledMemory,
        config.app.memory.recall,
      ),
      regen ? params.body.guidance : undefined,
    ),
    context: callContext(deps, config, charName, engine.thread, params.rid, built.keepalive_max_secs, (built.request.provider_options === undefined
        ? {}
        : { options: built.request.provider_options })),
  };

  const subagentHistory: Message[] =
    config.app.subagents.size === 0
      ? []
      : [...engine.messages()].slice(-MAX_HISTORY_MESSAGES);

  let intermediatePersisted = false;
  const persistIntermediate = async (message: Message): Promise<void> => {
    const persisted = message.role === "assistant"
      ? {
          ...message,
          provider_key: resolved.providerKey,
          model: request.model,
        }
      : message;
    if (regen && !intermediatePersisted) {
      await engine.replaceAfterLastUserTurn([persisted]);
    } else {
      await engine.appendMessage(persisted);
    }
    intermediatePersisted = true;
  };

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
    persistIntermediate,
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
    replaceGeneratedTail: intermediatePersisted,
    wallClockMs: clock() - startedAt,
    ...(regenAlt === undefined ? {} : { regenAlt }),
  });

  emitPostPersistStreamEnd(turnCtx, engine, params.rid ?? undefined, result);
  await flushFrames();

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
  persistIntermediate: (message: Message) => Promise<void>;
}

async function streamTurn(
  deps: GenerationDeps,
  params: StreamTurnParams,
): Promise<{ result: StreamResult; intermediate: Message[] }> {
  const { config, charName, resolved, request } = params;
  const toolsOn = anyEnabled(config.app.tools) && (request.tools?.length ?? 0) > 0;
  let send: (message: ServerMessage) => void = params.send;
  const toolCtx = toolsOn
    ? await buildToolContext(
        config,
        deps.dataDir,
        charName,
        deps.tools?.(charName, {
          conversation: params.conversation,
          send: (message) => send(message),
          ...(params.rid === undefined ? {} : { rid: params.rid }),
          now: params.now,
          newMessageId: params.newMessageId,
          signal: params.signal,
        }) ?? {},
      )
    : undefined;

  let intermediate: Message[] = [];

  const { result } = await runModelGeneration(request, resolved, {
    providers: deps.providers,
    ...(deps.callStore === undefined ? {} : { callStore: deps.callStore }),
    config,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
  }, {
    signal: params.signal,
    regen: params.regen,
    ...(params.rid === undefined ? {} : { rid: params.rid }),
    sink: params.send,
    onFallback: (event) => recordKeyFallback(deps, params, event),
    onRetry: (error, attemptIndex, delayMs) => {
      deps.log?.warn?.("retrying provider stream", {
        attempt: attemptIndex + 1,
        delay_ms: delayMs,
        error: describeError(error),
      });
    },
    tools: (call, sink) => {
      send = sink;
      intermediate = [];
      if (toolCtx !== undefined && resolved.maxToolIterations !== undefined) {
        call.max_tool_iterations = resolved.maxToolIterations;
      }
      const phase = toolCtx === undefined ? undefined : toolPhase({
        sendDirect: sink,
        ctx: toolCtx,
        limits: toolLimits(config),
        ...(params.rid === undefined ? {} : { rid: params.rid }),
        now: params.now,
        newMessageId: params.newMessageId,
        schemas: schemasFrom(call.tools),
        onRecordTurn: params.persistIntermediate,
      }, intermediate);
      return phase;
    },
  });

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

export function withRecalledMemory(
  messages: readonly WireMessage[],
  recalled: string | undefined,
  framing: { preamble: string; wrap_before: string; wrap_after: string },
): WireMessage[] {
  if (recalled === undefined || recalled.trim() === "") return [...messages];
  return [...messages, {
    role: "system",
    content: [{ type: "text", text: recalledMemoryText(recalled, framing) }],
  }];
}

export function withRegenGuidance(
  messages: readonly WireMessage[],
  guidance: string | undefined,
): WireMessage[] {
  if (guidance === undefined || guidance.trim() === "") return [...messages];
  return [...messages, {
    role: "system",
    content: [{ type: "text", text: guidance }],
  }];
}

function recalledMemoryText(
  recalled: string,
  framing: { preamble: string; wrap_before: string; wrap_after: string },
): string {
  const body = framing.preamble === "" ? recalled : `${framing.preamble}\n\n${recalled}`;
  return `${framing.wrap_before}${body}${framing.wrap_after}`;
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
  thread: string,
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
    thread,
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
