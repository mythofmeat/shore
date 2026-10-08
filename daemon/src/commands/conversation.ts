import type { OperationResult } from "../operations/types.ts";
import { required } from "../util/required.ts";

import { shoreLog } from "../log.ts";
import { mergeToolLoopMessages, turnMsgIds } from "../engine/merge.ts";
import type {
  ConversationEngine,
  DisplayHistoryPage,
  HistoryPageLimit,
  HistoryScope,
} from "../engine/conversation.ts";
import { presentSegment, type SegmentRecord } from "../engine/segments.ts";
import { MAIN_THREAD } from "../config/dirs.ts";
import type { SegmentSummary } from "../protocol/SegmentSummary.ts";
import type { ImageRef, Message, Role } from "../engine/types.ts";
import { embedImageData, embedMessagesImageData } from "../engine/wire_images.ts";
import { localRfc3339 } from "../util/time.ts";
import { engineError, invalidRequest, notFound } from "./errors.ts";
import { versionOf } from "../engine/versions.ts";
import type { WorkspaceRewind } from "../protocol/WorkspaceRewind.ts";
import { aliasTurn, recordedTurns, redoTurns, undoTurns, type WorkspaceTurns } from "../tools/workspace_turns.ts";

const DEFAULT_LOG_TURNS = 64;

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
    return required(messages[Number(signed)]).msg_id;
  }

  return reference;
}

function resolveAssistantRef(messages: readonly Message[], reference: string | undefined): string {
  if (reference === undefined || reference === "last" || reference === "latest") {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = required(messages[i]);
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

function historyPageLimit(args: Args): HistoryPageLimit {
  const turns = asU64(args["turns"]);
  if (turns !== undefined) return { kind: "turns", value: turns };

  const count = asU64(args["count"]);
  if (count !== undefined) return { kind: "count", value: count };

  return { kind: "turns", value: DEFAULT_LOG_TURNS };
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

function resolveHistoryBefore(args: Args): number | undefined {
  const before = args["before"];
  if (before === undefined || before === null) return undefined;
  const index = asU64(before);
  if (index === undefined) throw invalidRequest("before must be a message cursor");
  return index;
}

function historyScope(args: Args): HistoryScope {
  const segment = args["segment"];
  if (segment === undefined || segment === null) return "current";
  const index = asU64(segment);
  if (index === undefined) throw invalidRequest("segment must be a non-negative integer");
  return index;
}

function readHistoryPage(
  engine: ConversationEngine,
  args: Args,
  before: number | undefined,
): OperationResult<"history_page"> {
  const scope = historyScope(args);
  const role = roleFilter(args);
  const history = engine.displayHistoryPage(scope, before, historyPageLimit(args));
  if (history === undefined) {
    const where = engine.thread === MAIN_THREAD ? engine.characterName : `${engine.characterName} thread ${engine.thread}`;
    throw notFound(`segment ${String(scope)} not found for ${where}`);
  }
  return historyPagePayload(history, role, engine.characterName);
}

function historyPagePayload(
  history: DisplayHistoryPage,
  role: Role | undefined,
  character: string,
): OperationResult<"history_page"> {
  const page = history.messages
    .filter((msg) => matchesRole(msg, role))
    .map((msg) => structuredClone(msg));

  if (history.segment === undefined) embedMessagesImageData(page);
  shoreLog.debug(
    `shore: history page for ${character} (durable; ` +
      `segments=${String(history.metrics.segments_read)}, rows=${String(history.metrics.rows_read)}, ` +
      `decoded_bytes=${String(history.metrics.decoded_body_bytes)}, ` +
      `page_bytes=${String(history.metrics.page_bytes)})`,
  );

  return {
    messages: page,
    cursor: history.cursor,
    next_before: history.cursor,
    has_more_before: history.hasMoreBefore,
    total_turns: history.totalTurns,
    segment: presentOptionalSegment(history.segment),
    previous_segment: presentOptionalSegment(history.previousSegment),
    next_segment: presentOptionalSegment(history.nextSegment),
  };
}

function presentOptionalSegment(record: SegmentRecord | undefined): SegmentSummary | null {
  return record === undefined ? null : presentSegment(record);
}

export function get(engine: ConversationEngine, args: Args): OperationResult<"get"> {
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

export function log(engine: ConversationEngine, args: Args): OperationResult<"log"> {
  return readHistoryPage(engine, args, undefined);
}

export function historyPage(engine: ConversationEngine, args: Args): OperationResult<"history_page"> {
  return readHistoryPage(engine, args, resolveHistoryBefore(args));
}

export async function edit(engine: ConversationEngine, args: Args, turns?: WorkspaceTurns): Promise<OperationResult<"edit">> {
  const rawRef = asStr(args["ref"]);
  if (rawRef === undefined) throw invalidRequest("Missing required argument: ref");
  const content = asStr(args["content"]);
  if (content === undefined) throw invalidRequest("Missing required argument: content");

  const merged = mergeToolLoopMessages([...engine.messages()]);
  const msgId = resolveRef(merged, rawRef);
  const previous = replyVersion(engine.messages(), msgId);
  try {
    await engine.editMessage(msgId, content);
  } catch (e) {
    throw engineError(e);
  }
  const next = replyVersion(engine.messages(), msgId);
  if (turns !== undefined && previous !== undefined && next !== undefined && previous !== next) {
    await aliasTurn(turns, engine.thread, previous, next);
  }

  return { ref: msgId, edited: true };
}

export async function deleteMessages(engine: ConversationEngine, args: Args, workspaceTurns?: WorkspaceTurns): Promise<OperationResult<"delete">> {
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

  const known = new Set(raw.map((m) => m.msg_id));
  for (const turn of turns) {
    for (const msgId of turn) {
      if (!known.has(msgId)) throw notFound(`message not found: ${msgId}`);
    }
  }

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

  const workspace = workspaceTurns === undefined ? undefined : await rewindDeleted(engine, workspaceTurns, raw, gone);
  return workspace === undefined ? { deleted } : { deleted, workspace };
}

async function rewindDeleted(
  engine: ConversationEngine,
  turns: WorkspaceTurns,
  before: readonly Message[],
  gone: ReadonlySet<string>,
): Promise<WorkspaceRewind | undefined> {
  const replies = mergeToolLoopMessages([...before]).filter((m) => m.role === "assistant");
  const first = replies.findIndex((m) => gone.has(m.msg_id));
  if (first === -1) return undefined;
  const doomed = replies.filter((m) => gone.has(m.msg_id));
  const versions = doomed.flatMap((m) => versionOf(m) ?? []);
  if (!replies.slice(first).every((m) => gone.has(m.msg_id))) {
    const recorded = await recordedTurns(turns, engine.thread, versions);
    return recorded.length === 0 ? undefined : { restored: [], skipped: [], kept: "later_turns" };
  }
  return reported(await undoTurns(turns, engine.thread, [...versions].reverse()));
}

function reported(rewind: WorkspaceRewind): WorkspaceRewind | undefined {
  return rewind.restored.length === 0 && rewind.skipped.length === 0 ? undefined : rewind;
}

function replyVersion(messages: readonly Message[], msgId: string): string | undefined {
  const reply = mergeToolLoopMessages([...messages]).find((m) => m.msg_id === msgId);
  return reply?.role === "assistant" ? versionOf(reply) : undefined;
}

export function listAlternatives(engine: ConversationEngine, args: Args): OperationResult<"list_alternatives"> {
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

export async function alt(engine: ConversationEngine, args: Args, turns?: WorkspaceTurns): Promise<OperationResult<"alt">> {
  const merged = mergeToolLoopMessages([...engine.messages()]);
  const msgId = resolveAssistantRef(merged, asStr(args["ref"]));
  const msg = merged.find((m) => m.msg_id === msgId);
  if (msg === undefined) throw notFound(`Message not found: ${msgId}`);

  const altCount = (msg.alternatives ?? []).length;
  if (altCount === 0) throw invalidRequest(`message ${msgId} has no alternate responses`);
  const current = Math.min(msg.alt_index ?? 0, altCount - 1);
  const target = resolveAltTarget(args, current, altCount);
  const newest = merged.filter((m) => m.role === "assistant").at(-1)?.msg_id === msgId;
  const previous = versionOf(msg);

  let selection;
  try {
    selection = await engine.selectAlt(msgId, target);
  } catch (e) {
    throw engineError(e);
  }

  let workspace: WorkspaceRewind | undefined;
  if (turns !== undefined && newest) {
    const next = replyVersion(engine.messages(), selection.msg_id);
    if (next !== previous) {
      const undone = previous === undefined ? { restored: [], skipped: [] } : await undoTurns(turns, engine.thread, [previous]);
      const redone = next === undefined ? { restored: [], skipped: [] } : await redoTurns(turns, engine.thread, [next]);
      const skipped = new Set([...undone.skipped, ...redone.skipped]);
      workspace = reported({
        restored: [...new Set([...undone.restored, ...redone.restored])].filter((path) => !skipped.has(path)),
        skipped: [...skipped],
      });
    }
  }

  return {
    ref: selection.msg_id,
    alt_index: selection.alt_index,
    position: selection.alt_index + 1,
    alt_count: selection.alt_count,
    content: selection.content,
    ...(workspace === undefined ? {} : { workspace }),
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
): Promise<OperationResult<"inject_system">> {
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
