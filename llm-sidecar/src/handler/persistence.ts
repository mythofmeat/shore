/**
 * Persistence and notification for a completed generation.
 *
 * Port of `crates/daemon/src/handler/persistence.rs` — the last phase of the
 * chat pipeline. It writes the assistant turn to the conversation engine,
 * records diagnostics and session token totals, extends the cached
 * `last_request` so the heartbeat sees a conversation ending on an assistant
 * turn, and fires the completion notification.
 *
 * Everything the phase touches beyond the engine is reached through
 * {@link PersistContext} rather than the daemon's `GenContext`, which carries a
 * dozen fields this phase never reads. Same technique as `LoadedConfigView` in
 * `config/preferences.ts`: name the slice, not the struct.
 */

import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { ContentBlock, Message, MessageOrigin, Role } from "../engine/types.ts";
import { deriveContentFromBlocks, MessageStore } from "../engine/message_store.ts";
import type { PendingAlt } from "../engine/message_store.ts";
import { embedImageData } from "../engine/wire_images.ts";
import { rustTrim } from "../memory/lines.ts";
import type { ApiCallEntry } from "../diagnostics.ts";
import type { UsageBudgetWarningEvent } from "../ledger/budget.ts";
import type { StreamResult } from "../llm/stream.ts";
import type { WireMessage } from "../llm/types.ts";
import type { NotificationService } from "../notifications.ts";

/** A response turn as this phase assembles it, before it becomes a
 *  {@link Message} with an id and a timestamp. */
export interface CompletedResponseMessage {
  role: Role;
  content_blocks: ContentBlock[];
}

/** Running per-session token totals, mirroring the daemon's `SessionTokens`. */
export interface SessionTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * One row of the API-call diagnostics ring.
 *
 * The ring's own type, not a second declaration of it. There were two, agreeing
 * on ten fields and disagreeing on how `error` spells "none", which is exactly
 * the drift a duplicate exists to cause.
 */
export type { ApiCallEntry };

/**
 * The engine surface this phase drives. `ConversationEngine` implements it;
 * naming it separately keeps the persistence logic testable without a
 * conversation on disk.
 */
export interface PersistEngine {
  appendMessage(msg: Message): Promise<void>;
  replaceAfterLastUserTurn(newMessages: Message[]): Promise<number>;
  currentRevision(): number;
  turnCount(): number;
}

/** The autonomy surface this phase notifies. */
export interface PersistAutonomy {
  notifyLastRequest(character: string, request: WireRequest): void;
  notifyAssistantMessage(character: string, turnCount: number): void;
}

/**
 * The request shape this phase clones and extends. Only the fields it reads or
 * writes; the full `LlmRequest`/`SidecarRequest` is much wider.
 */
export interface WireRequest {
  model: string;
  provider_key?: string;
  messages: WireMessage[];
  rid?: string;
}

/** The slice of the daemon's `GenContext` this phase uses. */
export interface PersistContext {
  /** Broadcast fan-out for `new_message`. */
  emitEvent: (message: ServerMessage) => void;
  /** The requesting session's direct channel, for `usage_warning`. The Rust
   *  uses `try_send` and logs a drop; a full channel must not stall the
   *  generation that already finished. */
  sendDirect: (message: ServerMessage) => void;
  autonomy: PersistAutonomy;
  notifier: NotificationService;
  sessionTokens: SessionTokens;
  /** Narrow, like the rings beside it in {@link Diagnostics}: this only pushes,
   *  and saying so is what lets the real ring buffer be passed straight in. */
  diagnostics: { api_calls: { push: (entry: ApiCallEntry) => void } };
  /** Budget thresholds newly crossed by this call, in the order they should be
   *  reported. Rejections are logged and swallowed, as in the Rust. */
  newlyCrossedUsageBudgetWarnings: () => Promise<UsageBudgetWarningEvent[]>;
  /** Wall-clock timestamp for a persisted message, RFC 3339 with offset —
   *  `chrono::Local::now().to_rfc3339()`. Injected so a fixture can pin it. */
  now: () => string;
  /** Fresh message id. `format!("m_{}", Uuid::new_v4())` in the Rust. */
  newMessageId: () => string;
}

/** What a completed generation needs persisting. */
export interface PersistParams {
  charName: string;
  /** The model this generation resolved to, for the provider-key fallback. */
  resolvedProviderKey: string;
  result: StreamResult;
  request: WireRequest;
  /** Tool-loop turns already assembled by the caller; they precede the
   *  response messages in the appended run. */
  toolIntermediateMessages: Message[];
  /** Elapsed wall-clock milliseconds for the whole generation. */
  wallClockMs: number;
  regenAlt?: PendingAlt;
}

/**
 * Phase 12: persist messages, record diagnostics, and notify.
 *
 * The engine lock is held across message assembly and append, and released
 * before the notification and budget-warning calls — those touch the network
 * and must not hold a conversation hostage.
 */
export async function persistAndNotify(
  ctx: PersistContext,
  engine: PersistEngine,
  params: PersistParams,
): Promise<void> {
  const { charName, result, request, resolvedProviderKey } = params;

  recordCompletionDiagnostics(ctx, result, request, resolvedProviderKey);

  const completedMessages = completedResponseMessages(result);

  // Include the assistant response in `last_request` so the heartbeat system
  // sees a complete conversation ending on an assistant turn — not the user
  // turn that triggered this call.
  ctx.autonomy.notifyLastRequest(charName, lastRequestWithResponse(request, completedMessages));
  const notifyContent = notifyContentFromResponseMessages(completedMessages);

  // The provider that actually minted this turn (matching the diagnostics entry
  // above) so opaque thinking data carries its provenance to disk.
  const mintingProvider = request.provider_key ?? resolvedProviderKey;
  // Prefer the model the provider reported for this call (matching the
  // ledger/diagnostics entries); fall back to the model we requested.
  const mintingModel = result.model === "" ? request.model : result.model;

  const responseMessages = completedMessages.map((m) =>
    messageFromResponse(ctx, m, mintingProvider, mintingModel),
  );
  // Dead as written — `completedResponseMessages` only ever mints assistant
  // turns — and dead in the Rust for the same reason. Kept because it states
  // which messages are meant to raise a client event, and the day a non-
  // assistant turn joins the response is the day it starts mattering.
  const responseEventIds = responseMessages
    .filter((msg) => msg.role === "assistant")
    .map((msg) => msg.msg_id);

  const generatedMessages = [...params.toolIntermediateMessages, ...responseMessages];
  await applyGeneratedMessagesToEngine(engine, generatedMessages, {
    regenAlt: params.regenAlt,
    responseEventIds,
    emitEvent: ctx.emitEvent,
    charName,
  });
  ctx.autonomy.notifyAssistantMessage(charName, engine.turnCount());

  ctx.notifier.notifyMessageComplete(
    `Shore — ${charName}`,
    notifyContent,
    params.wallClockMs,
  );
  await emitUsageBudgetWarnings(ctx, request.rid);
}

/**
 * The request-as-sent plus this turn's response messages — the body every
 * `last_request` reuse path (keepalive ping, heartbeat, compaction) clones and
 * extends.
 *
 * Nothing is filtered here. This used to apply the prior-thinking replay policy
 * to the appended messages only, with a careful index clamp so it could never
 * rewrite bytes that had already gone out under a live cache entry — rewriting
 * those is what made every keepalive ping miss. The policy is applied at send
 * time now, so the same history always produces the same wire bytes and there
 * is nothing left to clamp.
 */
export function lastRequestWithResponse(
  request: WireRequest,
  completedMessages: CompletedResponseMessage[],
): WireRequest {
  // A shallow clone with a fresh message array: the appended turns must not
  // reach back into the request the caller still holds, and the already-sent
  // messages must survive identical, so they are shared rather than copied.
  const full: WireRequest = { ...request, messages: [...request.messages] };
  appendResponseMessagesToRequest(full, completedMessages);
  return full;
}

/**
 * Apply generated messages to the engine, handling regeneration alternatives
 * versus a plain append.
 *
 * The two branches emit `new_message` at different points for a reason: a
 * regeneration replaces the tail in one operation and so has one revision to
 * report for every message, while an append advances the revision per message
 * and each event must carry the revision its own message landed in.
 */
export async function applyGeneratedMessagesToEngine(
  engine: PersistEngine,
  generatedMessages: Message[],
  options: {
    regenAlt: PendingAlt | undefined;
    responseEventIds: string[];
    emitEvent: (message: ServerMessage) => void;
    charName: string;
  },
): Promise<void> {
  const { regenAlt, responseEventIds, emitEvent, charName } = options;

  if (regenAlt !== undefined) {
    MessageStore.attachGeneratedAlt(generatedMessages, regenAlt.alternatives);
    // Deep copies, because `emitNewMessageEvent` inlines image bytes into the
    // message it is handed. Rust's `.cloned()` here is deep by construction; a
    // spread would share the `images` array with the message the engine just
    // persisted and write base64 into the conversation file.
    const eventMessages = generatedMessages
      .filter((msg) => responseEventIds.includes(msg.msg_id))
      .map((msg) => structuredClone(msg));
    await engine.replaceAfterLastUserTurn(generatedMessages);
    const revision = engine.currentRevision();
    for (const msg of eventMessages) {
      emitNewMessageEvent(emitEvent, charName, "assistant_reply", revision, msg);
    }
    return;
  }

  for (const msg of generatedMessages) {
    // Cloned *before* the append, as in the Rust: the event carries the message
    // as generated, and deeply, for the same image-inlining reason as above.
    const shouldEmit = responseEventIds.includes(msg.msg_id);
    const emitted = shouldEmit ? structuredClone(msg) : undefined;
    await engine.appendMessage(msg);
    if (emitted !== undefined) {
      emitNewMessageEvent(emitEvent, charName, "assistant_reply", engine.currentRevision(), emitted);
    }
  }
}

function recordCompletionDiagnostics(
  ctx: PersistContext,
  result: StreamResult,
  request: WireRequest,
  resolvedProviderKey: string,
): void {
  const tokens = ctx.sessionTokens;
  tokens.input = saturatingAdd(tokens.input, result.usage.input_tokens);
  tokens.output = saturatingAdd(tokens.output, result.usage.output_tokens);
  tokens.cache_read = saturatingAdd(tokens.cache_read, result.usage.cache_read_tokens);
  tokens.cache_write = saturatingAdd(tokens.cache_write, result.usage.cache_creation_tokens);

  const entry: ApiCallEntry = {
    timestamp: ctx.now(),
    model: result.model,
    provider: request.provider_key ?? resolvedProviderKey,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_read_tokens: result.usage.cache_read_tokens,
    cache_write_tokens: result.usage.cache_creation_tokens,
    ttft_ms: result.timing.time_to_first_token_ms,
    total_ms: result.timing.total_ms,
    finish_reason: result.finish_reason,
    error: null,
  };
  if (result.usage.total_cost_usd !== undefined) entry.total_cost_usd = result.usage.total_cost_usd;
  ctx.diagnostics.api_calls.push(entry);
}

/**
 * Rust's `u64::saturating_add`. The totals are `u64` there and `number` here,
 * so the ceiling that actually applies is the safe-integer one — a session
 * would need 9×10^15 tokens to reach it, but clamping is still what the
 * reference does and silently going imprecise is not.
 */
function saturatingAdd(a: number, b: number): number {
  const sum = a + b;
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum;
}

async function emitUsageBudgetWarnings(ctx: PersistContext, rid: string | undefined): Promise<void> {
  let warnings: UsageBudgetWarningEvent[];
  try {
    warnings = await ctx.newlyCrossedUsageBudgetWarnings();
  } catch (e) {
    console.warn(`shore: usage budget warning check failed: ${String(e)}`);
    return;
  }

  for (const warning of warnings) {
    ctx.sendDirect({
      type: "usage_warning",
      rid: rid ?? null,
      budget: warning.budget,
      message: warning.message,
      current_cost: warning.current_cost,
      cost_limit: warning.cost_limit,
      percent_used: warning.percent_used,
      crossed_warn_at: warning.crossed_warn_at,
      period: warning.period,
      period_start: warning.period_start,
      reset_at: warning.reset_at,
      reset_at_display: warning.reset_at_display,
      // Omitted for budget-cap warnings so the frame stays byte-identical to
      // what pre-pace clients already parse.
      scope: warning.scope === "budget" ? null : warning.scope,
    });
    ctx.notifier.notify("usage_warning", "Shore usage warning", warning.message);
  }
}

/**
 * Emit one `new_message`, with the origin the wire copy carries and the stored
 * copy does not. Shared with the turn driver, which announces the *user* turn
 * the same way this announces the assistant's.
 */
export function emitNewMessageEvent(
  emitEvent: (message: ServerMessage) => void,
  character: string,
  origin: MessageOrigin,
  revision: number,
  msg: Message,
): void {
  const wireMsg: Message = { ...msg, origin };
  // The caller hands over a copy it does not keep, so inlining in place is safe
  // here — see the clones in `applyGeneratedMessagesToEngine`.
  embedImageData(wireMsg.images);
  // `NewMessage` flattens the message, so the frame is the message's own fields
  // beside `revision` and `character` — not a nested `message` object. The cast
  // is the same one `swp/connection.ts` makes for `history`: the stored shape
  // omits keys where the generated one spells them `null`, and widens two
  // unions the daemon never puts on this path.
  emitEvent({
    type: "new_message",
    revision,
    character,
    ...wireMsg,
  } as unknown as ServerMessage);
}

/** Stamp a response turn with an id, a timestamp, and the provenance of the
 *  model that minted it. */
export function messageFromResponse(
  ctx: Pick<PersistContext, "now" | "newMessageId">,
  responseMsg: CompletedResponseMessage,
  providerKey: string,
  model: string,
): Message {
  // The Rust writes `None` into `origin`, `alt_index` and `alt_count`; all
  // three are `skip_serializing_if = "Option::is_none"`, so an absent key is
  // the same bytes and is how the stored shape spells it on this side.
  return {
    msg_id: ctx.newMessageId(),
    role: responseMsg.role,
    content: deriveContentFromBlocks(responseMsg.content_blocks, true),
    images: [],
    content_blocks: responseMsg.content_blocks,
    alternatives: [],
    timestamp: ctx.now(),
    provider_key: providerKey,
    // A provider that reports no model id must not stamp the empty string —
    // downstream consumers read `Some("")` as a real, garbage model.
    ...(model === "" ? {} : { model }),
  };
}

/**
 * The response turns worth persisting — at most one.
 *
 * A degenerate empty assistant turn is dropped. A tool loop that ends without
 * the model emitting any final text yields a result with no content blocks;
 * persisting that as an empty assistant message poisons the conversation,
 * because the next request would ship a turn with empty content and Anthropic
 * rejects the whole thing ("text content blocks must be non-empty").
 */
export function completedResponseMessages(result: StreamResult): CompletedResponseMessage[] {
  const contentBlocks = contentBlocksForResult(result);
  if (contentBlocks.length === 0) return [];
  return [{ role: "assistant", content_blocks: contentBlocks }];
}

/**
 * The blocks a result should persist: its own, or a single text block
 * synthesized from `content` when a provider reported text without blocks.
 *
 * Note the guard is `blocks.length === 0 && content !== ""` — a result with no
 * blocks and no content yields nothing at all, which is what makes
 * {@link completedResponseMessages} drop the turn.
 */
export function contentBlocksForResult(result: StreamResult): ContentBlock[] {
  if (result.content_blocks.length === 0 && result.content !== "") {
    return [{ type: "text", text: result.content }];
  }
  return result.content_blocks;
}

/**
 * Append the response turns to a request.
 *
 * The Rust projects each stored `ContentBlock` onto a wire `WireBlock` here,
 * decoding a thinking block's prefixed signature into the field its provider
 * reads. There is nothing to project on this side — `ContentBlock` is the one
 * type both halves use and the carrier already sits in the right field, the
 * same reason `pushAssistantTurn` in `llm/request.ts` does not project either.
 */
export function appendResponseMessagesToRequest(
  request: WireRequest,
  responseMessages: CompletedResponseMessage[],
): void {
  for (const message of responseMessages) {
    // Skip turns that carry nothing (an empty-text-only response): an empty
    // content array is rejected by the API and would poison the cached
    // last-request the heartbeat replays.
    if (message.content_blocks.length === 0) continue;
    const turn: WireMessage = {
      role: message.role,
      content: message.content_blocks,
      model: request.model,
    };
    if (request.provider_key !== undefined) turn.provider_key = request.provider_key;
    request.messages.push(turn);
  }
}

/**
 * The text a completion notification shows.
 *
 * Assistant turns first; if they yield nothing printable, *every* turn is
 * tried. The fallback exists because a response can be entirely tool results —
 * showing the tool output beats showing an empty notification.
 */
export function notifyContentFromResponseMessages(
  messages: CompletedResponseMessage[],
): string {
  const assistantText = joinPrintable(messages.filter((m) => m.role === "assistant"));
  return assistantText === "" ? joinPrintable(messages) : assistantText;
}

function joinPrintable(messages: CompletedResponseMessage[]): string {
  return messages
    .map((m) => deriveContentFromBlocks(m.content_blocks, true))
    .filter((content) => rustTrim(content) !== "")
    .join("\n");
}
