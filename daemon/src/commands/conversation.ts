import { mergeToolLoopMessages, turnMsgIds } from "../engine/merge.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { ImageRef, Message, Role } from "../engine/types.ts";
import { embedImageData, embedMessagesImageData } from "../engine/wire_images.ts";
import { localRfc3339 } from "../util/time.ts";
import { engineError, invalidRequest, notFound } from "./errors.ts";

const DEFAULT_LOG_TURNS = 64;

export type Json = unknown;

export type Args = Record<string, unknown>;

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asU64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function parseI64(text: string): bigint | undefined {
  if (!/^[+-]?[0-9]+$/.test(text)) return undefined;
  const n = BigInt(text);
  return n >= I64_MIN && n <= I64_MAX ? n : undefined;
}

export function resolveRef(messages: readonly Message[], reference: string): string {
  if (reference === "last" || reference === "latest") {
    const last = messages[messages.length - 1];
    if (last === undefined) throw notFound("No messages in conversation");
    return last.msg_id;
  }

  const parsed = parseI64(reference);
  if (parsed !== undefined) {
    if (parsed === 0n) {
      throw invalidRequest("Message index must be non-zero (use 1 for first, -1 for last)");
    }
    const outOfRange = () =>
      notFound(
        `Message index ${reference} out of range (conversation has ${messages.length} messages)`,
      );

    const signed = parsed < 0n ? BigInt(messages.length) + parsed : parsed - 1n;
    if (signed < 0n || signed >= BigInt(messages.length)) throw outOfRange();
    return messages[Number(signed)]!.msg_id;
  }

  return reference;
}

function resolveAssistantRef(messages: readonly Message[], reference: string | undefined): string {
  if (reference === undefined || reference === "last" || reference === "latest") {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]!;
      if (msg.role === "assistant") return msg.msg_id;
    }
    throw notFound("No assistant messages in conversation");
  }

  const msgId = resolveRef(messages, reference);
  const msg = messages.find((m) => m.msg_id === msgId);
  if (msg === undefined) throw notFound(`Message not found: ${msgId}`);
  if (msg.role !== "assistant") {
    throw invalidRequest("Alternate response selection only applies to assistant messages");
  }
  return msgId;
}

function pageStartByTurns(messages: readonly Message[], endBound: number, turns: number): number {
  const end = Math.min(endBound, messages.length);
  if (turns === 0) return end;

  let seen = 0;
  for (let idx = end - 1; idx >= 0; idx -= 1) {
    if (messages[idx]!.role === "user") {
      seen += 1;
      if (seen >= turns) return idx;
    }
  }
  return 0;
}

function countUserTurns(messages: readonly Message[]): number {
  return messages.filter((m) => m.role === "user" && !isToolResultOnly(m)).length;
}

function isToolResultOnly(msg: Message): boolean {
  return (
    msg.role === "user" &&
    msg.content_blocks.length > 0 &&
    msg.content_blocks.every((b) => b.type === "tool_result")
  );
}

function pageStartByArgs(messages: readonly Message[], end: number, args: Args): number {
  const turns = asU64(args["turns"]);
  if (turns !== undefined) return pageStartByTurns(messages, end, turns);

  const count = asU64(args["count"]);
  if (count !== undefined) return Math.max(0, end - count);

  return pageStartByTurns(messages, end, DEFAULT_LOG_TURNS);
}

function roleFilter(args: Args): Role | undefined {
  if (!("role" in args)) return undefined;
  const role = args["role"];
  if (role === "user" || role === "assistant" || role === "system") return role;
  throw invalidRequest("role must be one of user, assistant, or system");
}

function matchesRole(message: Message, role: Role | undefined): boolean {
  return role === undefined || message.role === role;
}

function resolveHistoryBefore(args: Args, activeStart: number, total: number): number {
  if (!("before" in args)) return total;
  const before = args["before"];
  if (before === "active") return activeStart;

  const index = asU64(before);
  if (index === undefined) throw invalidRequest('before must be "active" or a message cursor');
  return Math.min(index, total);
}

function historyPagePayload(
  messages: readonly Message[],
  globalActiveStart: number,
  startIdx: number,
  endIdx: number,
  role: Role | undefined,
): Json {
  const start = Math.min(startIdx, messages.length);
  const end = Math.max(Math.min(endIdx, messages.length), start);
  const page = messages
    .slice(start, end)
    .filter((msg) => matchesRole(msg, role))
    .map((msg) => structuredClone(msg));
  const archivedEnd = Math.max(Math.min(globalActiveStart, end), start);
  const activePageStart = messages
    .slice(start, archivedEnd)
    .filter((msg) => matchesRole(msg, role)).length;
  const totalTurns = countUserTurns(messages);

  embedMessagesImageData(page.slice(activePageStart));

  return {
    messages: page,
    active_start: activePageStart,
    cursor: start,
    next_before: start,
    has_more_before: start > 0,
    global_active_start: globalActiveStart,
    total_messages: totalTurns,
    total_turns: totalTurns,
  };
}

export function get(engine: ConversationEngine, args: Args): Json {
  const rawRef = asStr(args["ref"]);
  if (rawRef === undefined) throw invalidRequest("Missing required argument: ref");

  const role = roleFilter(args);
  const merged = mergeToolLoopMessages([...engine.messages()]).filter((msg) =>
    matchesRole(msg, role),
  );
  const msgId = resolveRef(merged, rawRef);
  const msg = merged.find((m) => m.msg_id === msgId);
  if (msg === undefined) throw notFound(`Message not found: ${msgId}`);
  return msg;
}

export async function log(engine: ConversationEngine, args: Args): Promise<Json> {
  const { messages, activeStart } = await engine.displayHistory();
  const end = messages.length;
  const start = pageStartByArgs(messages, end, args);
  const role = roleFilter(args);

  return historyPagePayload(messages, activeStart, start, end, role);
}

export async function historyPage(engine: ConversationEngine, args: Args): Promise<Json> {
  const { messages, activeStart } = await engine.displayHistory();
  const end = resolveHistoryBefore(args, activeStart, messages.length);
  const start = pageStartByArgs(messages, end, args);
  const role = roleFilter(args);

  return historyPagePayload(messages, activeStart, start, end, role);
}

export async function edit(engine: ConversationEngine, args: Args): Promise<Json> {
  const rawRef = asStr(args["ref"]);
  if (rawRef === undefined) throw invalidRequest("Missing required argument: ref");
  const content = asStr(args["content"]);
  if (content === undefined) throw invalidRequest("Missing required argument: content");

  const merged = mergeToolLoopMessages([...engine.messages()]);
  const msgId = resolveRef(merged, rawRef);
  try {
    await engine.editMessage(msgId, content);
  } catch (e) {
    throw engineError(e);
  }

  return { ref: msgId, edited: true };
}

export async function deleteMessages(engine: ConversationEngine, args: Args): Promise<Json> {
  const refs = args["refs"];
  let rawRefs: string[];
  if (Array.isArray(refs)) {
    rawRefs = refs.map((v) => {
      const s = asStr(v);
      if (s === undefined) throw invalidRequest("refs must be an array of strings");
      return s;
    });
  } else if (typeof refs === "string") {
    rawRefs = [refs];
  } else {
    throw invalidRequest("Missing required argument: refs");
  }

  const raw = [...engine.messages()];
  const merged = mergeToolLoopMessages(raw);
  const turns = rawRefs.map((r) => turnMsgIds(raw, resolveRef(merged, r)));

  const deleted: string[] = [];
  const gone = new Set<string>();
  for (const turn of turns) {
    const pending = turn.filter((msgId) => !gone.has(msgId));
    if (pending.length === 0) continue;
    try {
      await engine.deleteMessages(pending);
    } catch (e) {
      throw engineError(e);
    }
    for (const msgId of pending) gone.add(msgId);
    deleted.push(...pending);
  }

  return { deleted };
}

export function listAlternatives(engine: ConversationEngine, args: Args): Json {
  const merged = mergeToolLoopMessages([...engine.messages()]);
  const msgId = resolveAssistantRef(merged, asStr(args["ref"]));
  const msg = merged.find((m) => m.msg_id === msgId);
  if (msg === undefined) throw notFound(`Message not found: ${msgId}`);

  const alts = msg.alternatives ?? [];
  const altCount = alts.length;
  const current = Math.min(msg.alt_index ?? 0, Math.max(0, altCount - 1));
  const alternatives = alts.map((alternative, index) => {
    const images: ImageRef[] = structuredClone(alternative.images);
    embedImageData(images);
    return {
      index,
      position: index + 1,
      active: index === current,
      content: alternative.content,
      images,
      timestamp: alternative.timestamp,
    };
  });

  return {
    ref: msgId,
    alt_index: msg.alt_index ?? null,
    position: msg.alt_index === undefined ? null : msg.alt_index + 1,
    alt_count: altCount,
    alternatives,
  };
}

export async function alt(engine: ConversationEngine, args: Args): Promise<Json> {
  const merged = mergeToolLoopMessages([...engine.messages()]);
  const msgId = resolveAssistantRef(merged, asStr(args["ref"]));
  const msg = merged.find((m) => m.msg_id === msgId);
  if (msg === undefined) throw notFound(`Message not found: ${msgId}`);

  const altCount = (msg.alternatives ?? []).length;
  if (altCount === 0) throw invalidRequest(`message ${msgId} has no alternate responses`);
  const current = Math.min(msg.alt_index ?? 0, altCount - 1);
  const target = resolveAltTarget(args, current, altCount);

  let selection;
  try {
    selection = await engine.selectAlt(msgId, target);
  } catch (e) {
    throw engineError(e);
  }

  return {
    ref: selection.msg_id,
    alt_index: selection.alt_index,
    position: selection.alt_index + 1,
    alt_count: selection.alt_count,
    content: selection.content,
  };
}

function resolveAltTarget(args: Args, current: number, count: number): number {
  const index = asU64(args["index"]);
  if (index !== undefined) {
    if (index >= count) {
      throw invalidRequest(
        `alternate index ${index + 1} out of range (message has ${count} alternate response(s))`,
      );
    }
    return index;
  }

  const position = asU64(args["position"]);
  if (position !== undefined) {
    if (position === 0 || position > count) {
      throw invalidRequest(
        `alternate position ${position} out of range (message has ${count} alternate response(s))`,
      );
    }
    return position - 1;
  }

  switch (asStr(args["direction"]) ?? "next") {
    case "prev":
    case "previous":
      return Math.max(0, current - 1);
    case "next":
      return Math.min(current + 1, count - 1);
    case "first":
      return 0;
    case "last":
      return count - 1;
    default:
      throw invalidRequest(`unknown alt direction: ${asStr(args["direction"])}`);
  }
}

export async function injectSystem(
  engine: ConversationEngine,
  args: Args,
  newId: () => string = () => `m_${crypto.randomUUID()}`,
  now: () => string = () => localRfc3339(new Date()),
): Promise<Json> {
  const text = asStr(args["text"]);
  if (text === undefined) throw invalidRequest("Missing required argument: text");

  const msg: Message = {
    msg_id: newId(),
    role: "system",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp: now(),
  };

  try {
    await engine.appendMessage(msg);
  } catch (e) {
    throw engineError(e);
  }
  return { injected: true };
}
