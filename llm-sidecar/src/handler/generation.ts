/**
 * One turn, start to finish: the `runGeneration` `handler/router.ts` injects.
 *
 * Ported from `handle_generation` and `run_generation_stream` in
 * `crates/daemon/src/handler/task.rs`, and from `stream_with_sidecar_tool_loop`
 * in `crates/daemon/src/handler/generation.rs`, pinned by
 * `tests/handler_fixtures/generation_parity.json`.
 *
 * The pieces this orders were ported before it — `setup.ts` resolves the model
 * and assembles the request, `context.ts` builds the prompt, `wire_messages.ts`
 * projects it, `llm/stream.ts` folds the stream, `persistence.ts` writes the
 * turn, `turn.ts` owns the conversation writes. What was missing is the
 * sequence, and the sequence is behaviour: **`stream_end` goes out after
 * persistence**, because a client that fires a follow-up command on seeing it
 * (the MCP bridge does) would otherwise read engine state that does not yet
 * have the turn in it.
 *
 * # The seam is gone, and with it the fork
 *
 * The Rust asked `can_delegate_tool_loop` whether the sidecar could drive the
 * whole turn. If it could, `stream_with_sidecar_tool_loop` handed the turn over
 * and the tools ran back over a socket; if it could not — a non-Anthropic
 * dialect at `9023b46d`, or a daemon whose tool socket was not serving — the
 * turn streamed here and a separate tool phase ran the loop daemon-side. Two
 * paths, both of which were about which side of a process boundary the tools
 * were on.
 *
 * There is one process now, so there is one path: when tools are enabled the
 * provider's loop runs the turn and calls {@link ToolPhase} in-process;
 * otherwise the provider streams once. The socket, the rid-addressed loop
 * registry, the `tool_rpc` field on the request and the "graceful degradation
 * to the daemon's own loop" all go with the hop. #12: *"In one process a tool
 * call is a function call."*
 *
 * # Three deliberate divergences
 *
 * 1. **A retry starts the turn's tool record over.** The Rust served tool calls
 *    into a single `Vec` for the whole call *including its retries*, so a turn
 *    whose first attempt ran two tools before failing persisted those two turns
 *    twice. Each attempt gets its own list here, and the one that succeeded is
 *    the one that persists.
 * 2. **The request the loop mutates is a copy.** The generic loop appends each
 *    round to `messages` so its next call carries them, which is the same list
 *    the Rust appended to *after* the fact from what the sidecar reported. Both
 *    at once would double every tool exchange in `last_request` — and that body
 *    is what the keepalive ping clones, where one divergent byte turns a 0.1×
 *    cache read into a 2.0× write. So the loop works on a copy and
 *    {@link applyIntermediateMessages} does the appending, once.
 * 3. **The compaction check is awaited.** The Rust spawned it detached and
 *    returned. Nothing here is blocking a thread, and awaiting is what lets a
 *    caller know the turn is actually over.
 *
 * # Not wired
 *
 * `runSubagent`, because `crates/daemon/src/tools/subagent.rs` has not ported.
 * A turn with `[subagents.*]` configured and no runner passed offers no `ask_*`
 * — see {@link ToolContextDeps}.
 */

import type { LoadedConfig } from "../config/loader.ts";
import { characterDataDir } from "../config/dirs.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { configView, resolveActiveModelAndOverlay } from "../config/preferences.ts";
import type { ResolvedModel } from "../config/models.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { ContentBlock, Message } from "../engine/types.ts";
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
import { genericToolLoopEvents } from "../llm/providers/generic_loop.ts";
import { consumeStream, type StreamResult } from "../llm/stream.ts";
import { recordingStream } from "../ledger/record.ts";
import type {
  CallContext,
  ProviderOptions,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  WireMessage,
} from "../llm/types.ts";
import type { UsageConfig } from "../ledger/budget.ts";
import { anyEnabled } from "../tools/registry.ts";
import { toolPhase, type ToolPhase } from "../tools/execute.ts";
import type { ToolLimitsView } from "../tools/dispatch.ts";
import type { ToolCallEntry } from "../diagnostics.ts";
import { buildToolContext, credentialEntry, type ToolContextDeps } from "./tool_context.ts";
import { buildGenerationRequest, resolveGenerationModel, type SetupEngine } from "./setup.ts";
import {
  persistAndNotify,
  type ApiCallEntry,
  type PersistContext,
  type PersistEngine,
  type SessionTokens,
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

/** Everything a turn asks of the conversation, across its three phases. */
export interface GenerationEngine extends TurnEngine, PersistEngine, SetupEngine {}

/**
 * A {@link ConversationEngine} as the driver's three phases read it.
 *
 * One method's worth of difference: `setup.ts` asks for `segmentCount()` and
 * the engine exposes the reader that has it. Adapting once here beats every
 * wiring site doing it.
 */
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

/** The character registry, as the driver reads it. */
export interface GenerationRegistry {
  getOrCreate(name: string): Promise<GenerationEngine>;
  /** The global config merged with the character's own overlay. */
  effectiveConfig(name: string): LoadedConfig;
}

/** The diagnostics rings this path appends to. Narrow: it only ever pushes. */
export interface GenerationDiagnostics {
  api_calls: { push: (entry: ApiCallEntry) => void };
  tool_calls: { push: (entry: ToolCallEntry) => void };
  key_fallbacks: { push: (entry: KeyFallbackEntry) => void };
}

/** One credential rotation, as `shore status --diagnostics` shows it. */
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

/**
 * The daemon-lifetime half of the Rust's `GenContext`.
 *
 * The per-turn half — who to stream to, which signal aborts — arrives on
 * {@link GenerationParams}, because it is per-turn.
 */
export interface GenerationDeps {
  registry: GenerationRegistry;
  /** `ShoreDirs::data`. The conversation and image roots hang off it. */
  dataDir: string;
  /** One adapter per dialect, as `server.ts` builds them. */
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  autonomy: TurnAutonomy & PersistContext["autonomy"];
  notifier: PersistContext["notifier"];
  sessionTokens: SessionTokens;
  diagnostics: GenerationDiagnostics;
  /** Broadcast fan-out — every session sees these. */
  emitEvent: (message: ServerMessage) => void;
  mcpRegistry: Pick<McpRegistry, "toolDefsFiltered" | "call">;
  /** What an inline compaction runs. */
  compaction: CompactionRunner;
  /** Budget thresholds newly crossed by this call. */
  newlyCrossedUsageBudgetWarnings: PersistContext["newlyCrossedUsageBudgetWarnings"];
  /** `ledger.db`. Absent records nothing. */
  ledgerPath?: string;
  /** `[usage]`, read per call rather than cached — see {@link CallContext}. */
  usageConfig?: () => UsageConfig | undefined;
  /** `[behavior.autonomy].cache_keepalive_max`, in seconds. */
  keepaliveMaxSecs?: () => number | undefined;
  /**
   * What the tool context needs that the config does not carry.
   *
   * Per character rather than one shared object, because two of its fields are:
   * `deferEdit` writes into *this* character's queue and `activityStats` reads
   * *this* character's tracker. A process-wide table could only leave both out,
   * which is a heartbeat's tool context — see `runtime.ts` — and not a chat
   * turn's.
   *
   * Per *turn* as well as per character, because `runSubagent` is: the nested
   * loop's frames go to the session that asked, and its history macro reads
   * this turn's conversation tail.
   */
  tools?: (charName: string, turn: SubagentTurn) => ToolContextDeps;
  /** RFC 3339 with offset. Injected so a replay can pin it. */
  now?: () => string;
  /** `format!("m_{}", Uuid::new_v4())` in the Rust. */
  newMessageId?: () => string;
  /** Monotonic milliseconds, for the turn's wall-clock total. */
  monotonicMs?: () => number;
  /** Injected by the replay so a turn never sleeps between retries. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Overrides which loop runs a tool-using turn.
   *
   * Production picks between the two real ones by dialect, below. The parity
   * replay substitutes a loop that plays a recorded script against the
   * {@link ToolPhase} — the same thing the fixture's fake sidecar did — because
   * the Anthropic loop is the SDK's tool runner and cannot be fed canned
   * events. Each real loop is pinned by its own tests.
   */
  loopEvents?: (
    provider: SidecarProvider,
    req: SidecarRequest,
    phase: ToolPhase,
    signal: AbortSignal,
  ) => AsyncIterable<StreamEvent>;
  /** Injected by the replay; production reads the real environment. */
  env?: NodeJS.ProcessEnv;
  log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    error?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

const defaultNow = (): string => new Date().toISOString();
const defaultMessageId = (): string => `m_${crypto.randomUUID()}`;
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bind the daemon's context into the callback `MessageHandler` launches.
 *
 * A factory rather than a class: the handler holds one of these for the process
 * and calls it per turn, and nothing survives between turns except what is on
 * {@link GenerationDeps}.
 */
export function makeRunGeneration(deps: GenerationDeps): RunGeneration {
  return (params: GenerationParams) => runGeneration(deps, params);
}

/** One turn. See the module doc for the order and why it is the order. */
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
    sendDirect: params.send,
    autonomy: deps.autonomy,
    now,
    newMessageId,
  };

  // ── setup: record the turn, decide the model, seed autonomy ────────────
  const body = {
    text: params.body.text,
    images: params.body.images,
    image_data: params.body.image_data as never[],
  };
  const regenAlt = await appendUserTurn(turnCtx, engine, deps.dataDir, charName, body, regen);

  const { model: activeModel, overlay } = resolveActiveModelAndOverlay(
    configView(config),
    charName,
    (view, cacheDir, name, includeHidden) =>
      findEffectiveModel(view, cacheDir, name, includeHidden),
  );
  const resolved = resolveGenerationModel(activeModel, config, overlay);

  await ensureAndBackfillAutonomy(turnCtx, engine, charName, config);
  notifyUserMessageIfFresh(turnCtx, engine, charName, body, regen);

  // ── the request ────────────────────────────────────────────────────────
  const built = await buildGenerationRequest({
    engine,
    dataDir: deps.dataDir,
    charName,
    config,
    resolved,
    regen,
    mcpRegistry: deps.mcpRegistry,
    ...(params.body.overrides === undefined
      ? {}
      : { overrides: params.body.overrides as never }),
  });
  const request: SidecarRequest = {
    ...built.request,
    // No `api_key_name`: the credential is resolved per attempt, and the
    // attempt stamps the name of the key it actually used. Setting it here from
    // the assembly-time key would be a label the rotation then has to correct.
    context: callContext(deps, config, charName, params.rid, {
      ...(built.request.provider_options === undefined
        ? {}
        : { options: built.request.provider_options }),
    }),
  };

  // The tail any `{{active_history:}}` macro in a sub-agent prompt reads. Only
  // when sub-agents are configured, so a turn without them pays no clone.
  const subagentHistory: Message[] =
    config.app.subagents.size === 0
      ? []
      : [...engine.messages()].slice(-MAX_HISTORY_MESSAGES);

  // ── the stream, and the tool loop inside it ────────────────────────────
  const { result, intermediate } = await streamTurn(deps, {
    config,
    charName,
    resolved,
    request,
    regen,
    conversation: subagentHistory,
    send: params.send,
    ...(params.rid === null ? {} : { rid: params.rid }),
    signal: params.signal,
    now,
    newMessageId,
  });

  applyIntermediateMessages(request, intermediate, result.model);

  // ── persistence, then the frame that says it is durable ────────────────
  const persistCtx: PersistContext = {
    emitEvent: deps.emitEvent,
    sendDirect: params.send,
    autonomy: deps.autonomy,
    notifier: deps.notifier,
    sessionTokens: deps.sessionTokens,
    diagnostics: deps.diagnostics,
    newlyCrossedUsageBudgetWarnings: deps.newlyCrossedUsageBudgetWarnings,
    now,
    newMessageId,
  };
  // The whole request, not a projection of it: what persistence hands to
  // `notifyLastRequest` is the body every reuse path clones, and a keepalive
  // ping rebuilt from `model` and `messages` alone would drop the system blocks
  // and the tool surface — the two things the provider's cache prefix is keyed
  // on.
  //
  // Minus `context`, which is per-*call* rather than part of the body. The
  // labels say this was a `message`, and a ping that reused them would file
  // every keepalive as a chat turn in the ledger. The Rust could not make this
  // mistake because its context was an argument rather than a field; here it
  // has to be dropped on the way past. `rid` stays, as it did in the Rust's own
  // `LlmRequest` — it is `#[serde(skip)]`, so it lived in memory and never on
  // the wire.
  const { context: _perCall, ...sentBody } = request;
  await persistAndNotify(persistCtx, engine, {
    charName,
    resolvedProviderKey: resolved.providerKey,
    result,
    request: {
      ...sentBody,
      ...(params.rid === null ? {} : { rid: params.rid }),
    },
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

// ── the stream ──────────────────────────────────────────────────────────

/**
 * The turn a sub-agent's runtime is built against.
 *
 * Everything here is per turn rather than per character: the nested loop
 * streams into the session that asked, correlates with that request's rid, and
 * reads that turn's conversation tail for `{{active_history: n}}`.
 */
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
  /** The tail a sub-agent's history macro reads. Empty without sub-agents. */
  conversation: Message[];
  send: (message: ServerMessage) => void;
  rid?: string;
  signal: AbortSignal;
  now: () => string;
  newMessageId: () => string;
}

/**
 * Stream the turn, running its tools as the model asks for them.
 *
 * Retries and credential rotation wrap the *whole* turn, loop included, which
 * is what the Rust's sidecar-driven path did and is the only arrangement that
 * makes sense: a turn that failed on its third tool round has to start over,
 * because the provider has no way to resume one.
 */
async function streamTurn(
  deps: GenerationDeps,
  params: StreamTurnParams,
): Promise<{ result: StreamResult; intermediate: Message[] }> {
  const { config, charName, resolved, request } = params;
  const provider = deps.providers[request.sdk];
  if (provider === undefined) {
    throw new Error(`unsupported sdk: ${request.sdk}`);
  }

  // Tools run when the config enables any *and* the surface is non-empty. The
  // second half is not redundant: a character whose `enabled_tools` names only
  // tools this build does not have offers nothing, and a loop with no tools is
  // a plain stream with extra steps.
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

  // The attempt that succeeded owns the turns it produced. A retry starts the
  // record over rather than appending to the failed attempt's — see the module
  // doc's first divergence.
  let intermediate: Message[] = [];

  const attempt = async (apiKey: string, candidate: KeyCandidate): Promise<StreamResult> => {
    const messages: Message[] = [];
    // A copy per attempt: the generic loop appends each round to `messages` so
    // its next call carries them, and the request the caller holds must stay
    // the one that was sent.
    const call: SidecarRequest = {
      ...request,
      api_key: apiKey,
      messages: [...request.messages],
      // The loop's dispatch cap, set only when there is a loop — the Rust set
      // it on the request it handed the sidecar and nowhere else. Absent means
      // unlimited, so the model ending cleanly is the only exit.
      ...(toolCtx === undefined || resolved.maxToolIterations === undefined
        ? {}
        : { max_tool_iterations: resolved.maxToolIterations }),
      ...(request.context === undefined
        ? {}
        : { context: { ...request.context, api_key_name: candidate.name } }),
    };

    const phase: ToolPhase | undefined =
      toolCtx === undefined
        ? undefined
        : toolPhase(
            {
              sendDirect: params.send,
              ctx: toolCtx,
              limits: toolLimits(config),
              diagnostics: deps.diagnostics.tool_calls,
              ...(params.rid === undefined ? {} : { rid: params.rid }),
              now: params.now,
              newMessageId: params.newMessageId,
            },
            messages,
          );

    const events: AsyncIterable<StreamEvent> =
      phase === undefined
        ? provider.stream(call, params.signal)
        : deps.loopEvents !== undefined
          ? deps.loopEvents(provider, call, phase, params.signal)
          : call.sdk === "anthropic"
            ? anthropicToolLoopEvents(call, phase, params.signal)
            : genericToolLoopEvents(provider, call, phase, params.signal);

    const outcome = await consumeStream(recordingStream(call.context, call, events), {
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
      ),
    {
      record: (event) => recordKeyFallback(deps, params, event),
    },
  );

  return { result, intermediate };
}

/**
 * Record one credential rotation: diagnostics always, a client warning only
 * when the key being abandoned opted in.
 *
 * The reason string is sanitized before it reaches either — it may quote a
 * provider's response body, and those have carried partial credentials.
 */
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

  // Only when there was somewhere to rotate *to*: the final failure surfaces
  // as the thrown error rather than as a warning about a key that follows.
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

// ── after the loop ──────────────────────────────────────────────────────

/**
 * Append the loop's own turns to the request that produced them.
 *
 * Every `last_request` reuse path — the keepalive ping, the heartbeat's cold
 * rebuild, compaction — clones this body and has to stay byte-identical to what
 * went out. Left as sent, it would replay a conversation missing every tool
 * exchange, so the ping's cache anchors miss and it rewrites the whole thing at
 * 2.0× instead of reading it at 0.1×.
 *
 * Provenance is split on purpose: the provider comes off the *request*, and the
 * model off the *result*, because a provider reports which model actually
 * served the call and that is what the thinking blocks were minted by. An empty
 * reported model leaves the field unset rather than empty — a replay reads those
 * differently.
 */
export function applyIntermediateMessages(
  request: SidecarRequest,
  intermediate: readonly Message[],
  resultModel: string,
): void {
  const mintedModel = resultModel === "" ? undefined : resultModel;
  for (const message of intermediate) {
    const wire: WireMessage = {
      // No dialect takes a mid-conversation system turn, so it folds into user.
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content_blocks as ContentBlock[],
      ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
      ...(mintedModel === undefined ? {} : { model: mintedModel }),
    };
    request.messages.push(wire);
  }
}

// ── ledger labels ───────────────────────────────────────────────────────

/**
 * The per-call labels a ledger row is written from.
 *
 * Ported from `LedgerClient::call_context` in
 * `crates/daemon/src/ledger/client.rs`, which is the only part of that file
 * this path needs — the rest belongs to callers that have not moved.
 *
 * `cache_ttl` and `reasoning_effort` are resolved here rather than re-derived
 * where the row is written, so a row's shape does not depend on two
 * implementations of the same resolution agreeing.
 */
function callContext(
  deps: GenerationDeps,
  config: LoadedConfig,
  charName: string,
  rid: string | null,
  call: { options?: ProviderOptions },
): CallContext {
  const ceiling = deps.keepaliveMaxSecs?.();
  const usage = deps.usageConfig?.();
  // The Rust kept this in a process-global set at startup from the cache dir
  // when `[advanced].cache_forensics` was on. The flag and the dir are both on
  // the config here, so the global is a level of indirection with nothing in it.
  const forensics = config.app.advanced.cache_forensics ? config.dirs.cache : undefined;
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
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * `[tools]` as {@link toolPhase} reads it.
 *
 * A rename and a unit: the config keeps durations as `ConfigDuration` because
 * TOML spells them `"30s"`, and the dispatcher wants milliseconds.
 */
function toolLimits(config: LoadedConfig): ToolLimitsView {
  const cfg = config.app.tools;
  const overrides: Record<string, { max_result_chars?: number; timeout_ms?: number }> = {};
  for (const [name, o] of cfg.config) {
    overrides[name] = {
      ...(o.max_result_chars === undefined ? {} : { max_result_chars: o.max_result_chars }),
      ...(o.timeout === undefined ? {} : { timeout_ms: o.timeout.asMillis() }),
    };
  }
  return {
    max_result_chars: cfg.max_result_chars,
    timeout_ms: cfg.timeout.asMillis(),
    config: overrides,
  };
}

/** True when either provider knob asks for extended thinking. */
export function thinkingEnabled(opts: ProviderOptions | undefined): boolean {
  if (opts === undefined) return false;
  if (opts.thinking_enabled === false) return false;
  return (opts.budget_tokens !== undefined && opts.budget_tokens > 0) ||
    opts.reasoning_effort !== undefined;
}

/**
 * The effort a ledger row records.
 *
 * `reasoning_effort = "off"` is rewritten to `thinking_enabled: false` before
 * the request is built, so the `"off"` label is reconstructed here rather than
 * leaving the column empty for a model whose thinking is explicitly disabled.
 */
export function resolvedReasoningEffort(opts: ProviderOptions | undefined): string | undefined {
  if (opts?.reasoning_effort !== undefined) return opts.reasoning_effort;
  return opts?.thinking_enabled === false ? "off" : undefined;
}
