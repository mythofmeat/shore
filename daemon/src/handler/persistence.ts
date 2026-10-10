import { shoreLog } from "../log.ts";

import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { ContentBlock, Message, MessageOrigin, Role } from "../engine/types.ts";
import { pictureText } from "../engine/embeds.ts";
import { deriveContentFromBlocks, MessageStore } from "../engine/message_store.ts";
import type { PendingAlt } from "../engine/message_store.ts";
import { embedImageData } from "../engine/wire_images.ts";
import { rustTrim } from "../memory/lines.ts";
import { mergeToolLoopMessages } from "../engine/merge.ts";
import type { UsageBudgetWarningEvent } from "../ledger/budget.ts";
import type { PlanLimitWarningEvent } from "../ledger/plan_limits.ts";
import type { StreamResult } from "../llm/stream.ts";
import type { WireMessage } from "../llm/types.ts";
import type { KeepaliveArming } from "../cache/last_request.ts";
import { cachedPrefixTokens } from "../cache/keepalive.ts";
import type { NotificationService } from "../notifications.ts";
import { firstSentPicture, sendPictures, textsOf, type PictureSender } from "./pictures.ts";

export interface CompletedResponseMessage {
  role: Role;
  content_blocks: ContentBlock[];
}

export interface PersistEngine {
  readonly thread?: string;
  appendMessage(msg: Message): Promise<void>;
  replaceAfterLastUserTurn(newMessages: Message[]): Promise<number>;
  currentRevision(): number;
  turnCount(): number;
}

interface PersistAutonomy {
  notifyLastRequest(character: string, request: WireRequest, keepalive: KeepaliveArming, thread?: string): void;
  notifyAssistantMessage(character: string, turnCount: number): void;
}

export interface WireRequest {
  model: string;
  provider_key?: string;
  messages: WireMessage[];
  rid?: string;
}

export interface PersistContext {
  emitEvent: (message: ServerMessage) => void;
  sendDirect: (message: ServerMessage) => void;
  autonomy: PersistAutonomy;
  notifier: NotificationService;
  newlyCrossedUsageBudgetWarnings: (character: string) => Promise<UsageBudgetWarningEvent[]>;
  newlyCrossedPlanLimitWarnings: (character: string) => Promise<PlanLimitWarningEvent[]>;
  now: () => string;
  newMessageId: () => string;
}

export interface PersistParams {
  charName: string;
  resolvedProviderKey: string;
  onClaudePlan?: boolean;
  result: StreamResult;
  request: WireRequest;
  keepaliveIntervalMs: number | undefined;
  keepalivePings?: number | undefined;
  toolIntermediateMessages: Message[];
  replaceGeneratedTail?: boolean;
  wallClockMs: number;
  regenAlt?: PendingAlt;
  pictures?: PictureSender;
}

export async function persistAndNotify(
  ctx: PersistContext,
  engine: PersistEngine,
  params: PersistParams,
): Promise<void> {
  const { charName, result, request, resolvedProviderKey } = params;

  const completedMessages = completedResponseMessages(result);

  ctx.autonomy.notifyLastRequest(charName, lastRequestWithResponse(request, completedMessages), {
    intervalMs: params.keepaliveIntervalMs,
    pings: params.keepalivePings,
    cachedTokens: cachedPrefixTokens(result.context_usage ?? result.usage),
  }, engine.thread);
  const mintingProvider = request.provider_key ?? resolvedProviderKey;
  const mintingModel = result.model === "" ? request.model : result.model;

  const responseMessages = completedMessages.map((m) =>
    messageFromResponse(ctx, m, mintingProvider, mintingModel),
  );
  const responseEventIds = responseMessages
    .filter((msg) => msg.role === "assistant")
    .map((msg) => msg.msg_id);

  const generatedMessages = [
    ...params.toolIntermediateMessages.map((m) =>
      stampProvenance(m, mintingProvider, mintingModel),
    ),
    ...responseMessages,
  ];
  if (params.pictures !== undefined) await attachSentPictures(generatedMessages, params.pictures);
  const sentImages = generatedMessages.flatMap((message) => message.images);
  const notifyContent = pictureText(notifyContentFromResponseMessages(completedMessages), sentImages);
  const displayMessages = new Map(mergeToolLoopMessages(generatedMessages).map((message) => [message.msg_id, message]));
  for (const message of responseMessages) {
    message.images = displayMessages.get(message.msg_id)?.images ?? message.images;
  }
  await applyGeneratedMessagesToEngine(engine, generatedMessages, {
    regenAlt: params.regenAlt,
    responseEventIds,
    emitEvent: ctx.emitEvent,
    charName,
    replaceGeneratedTail: params.replaceGeneratedTail === true,
  });
  ctx.autonomy.notifyAssistantMessage(charName, engine.turnCount());

  ctx.notifier.notifyMessageComplete(
    `Shore - ${charName}`,
    notifyContent,
    params.wallClockMs,
    firstSentPicture(sentImages),
  );
  await emitUsageBudgetWarnings(ctx, charName, request.rid);
  if (params.onClaudePlan === true) await emitPlanLimitWarnings(ctx, charName, request.rid);
}

async function attachSentPictures(messages: Message[], sender: PictureSender): Promise<void> {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const sent = await sendPictures(textsOf(message.content_blocks), sender);
    if (sent.length > 0) message.images = [...message.images, ...sent];
  }
}

export function lastRequestWithResponse(
  request: WireRequest,
  completedMessages: CompletedResponseMessage[],
): WireRequest {
  const full: WireRequest = { ...request, messages: [...request.messages] };
  appendResponseMessagesToRequest(full, completedMessages);
  return full;
}

export async function applyGeneratedMessagesToEngine(
  engine: PersistEngine,
  generatedMessages: Message[],
  options: {
    regenAlt: PendingAlt | undefined;
    responseEventIds: string[];
    emitEvent: (message: ServerMessage) => void;
    charName: string;
    replaceGeneratedTail?: boolean;
  },
): Promise<void> {
  const { regenAlt, responseEventIds, emitEvent, charName, replaceGeneratedTail } = options;

  if (regenAlt !== undefined || replaceGeneratedTail === true) {
    if (regenAlt !== undefined) {
      MessageStore.attachGeneratedAlt(generatedMessages, regenAlt.alternatives);
    }
    const eventMessages = generatedMessages
      .filter((msg) => responseEventIds.includes(msg.msg_id))
      .map((msg) => structuredClone(msg));
    await engine.replaceAfterLastUserTurn(generatedMessages);
    const revision = engine.currentRevision();
    for (const msg of eventMessages) {
      emitNewMessageEvent(emitEvent, charName, "assistant_reply", revision, msg, engine.thread);
    }
    return;
  }

  for (const msg of generatedMessages) {
    const shouldEmit = responseEventIds.includes(msg.msg_id);
    const emitted = shouldEmit ? structuredClone(msg) : undefined;
    await engine.appendMessage(msg);
    if (emitted !== undefined) {
      emitNewMessageEvent(emitEvent, charName, "assistant_reply", engine.currentRevision(), emitted, engine.thread);
    }
  }
}

async function emitUsageBudgetWarnings(
  ctx: PersistContext,
  charName: string,
  rid: string | undefined,
): Promise<void> {
  let warnings: UsageBudgetWarningEvent[];
  try {
    warnings = await ctx.newlyCrossedUsageBudgetWarnings(charName);
  } catch (e) {
    shoreLog.warn(`shore: usage budget warning check failed: ${String(e)}`);
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
      scope: warning.scope === "budget" ? null : warning.scope,
    });
    ctx.notifier.notify("usage_warning", "Shore usage warning", warning.message);
  }
}

async function emitPlanLimitWarnings(
  ctx: PersistContext,
  charName: string,
  rid: string | undefined,
): Promise<void> {
  let warnings: PlanLimitWarningEvent[];
  try {
    warnings = await ctx.newlyCrossedPlanLimitWarnings(charName);
  } catch (e) {
    shoreLog.warn(`shore: plan limit warning check failed: ${String(e)}`);
    return;
  }

  for (const warning of warnings) {
    ctx.sendDirect({ type: "plan_limit_warning", rid: rid ?? null, ...warning });
    ctx.notifier.notify("usage_warning", "Shore usage warning", warning.message);
  }
}

export function emitNewMessageEvent(
  emitEvent: (message: ServerMessage) => void,
  character: string,
  origin: MessageOrigin,
  revision: number,
  msg: Message,
  thread = "main",
  rid: string | null = null,
): void {
  const wireMsg: Message = { ...msg, origin };
  embedImageData(wireMsg.images);
  emitEvent({
    type: "new_message",
    revision,
    character,
    thread,
    ...(rid === null ? {} : { rid }),
    ...wireMsg,
  });
}

function stampProvenance(message: Message, providerKey: string, model: string): Message {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    provider_key: providerKey,
    ...(model === "" ? {} : { model }),
  };
}

export function messageFromResponse(
  ctx: Pick<PersistContext, "now" | "newMessageId">,
  responseMsg: CompletedResponseMessage,
  providerKey: string,
  model: string,
): Message {
  return {
    msg_id: ctx.newMessageId(),
    role: responseMsg.role,
    content: deriveContentFromBlocks(responseMsg.content_blocks, true),
    images: [],
    content_blocks: responseMsg.content_blocks,
    alternatives: [],
    timestamp: ctx.now(),
    provider_key: providerKey,
    ...(model === "" ? {} : { model }),
  };
}

export function completedResponseMessages(result: StreamResult): CompletedResponseMessage[] {
  const contentBlocks = contentBlocksForResult(result);
  if (contentBlocks.length === 0) return [];
  return [{ role: "assistant", content_blocks: contentBlocks }];
}

export function contentBlocksForResult(result: StreamResult): ContentBlock[] {
  if (result.content_blocks.length === 0 && result.content !== "") {
    return [{ type: "text", text: result.content }];
  }
  return result.content_blocks;
}

export function appendResponseMessagesToRequest(
  request: WireRequest,
  responseMessages: CompletedResponseMessage[],
): void {
  for (const message of responseMessages) {
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
