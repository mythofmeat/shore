/**
 * The conversation half of the SWP command surface: reading history, editing
 * it, and choosing between stored alternate responses.
 *
 * Ported from `crates/daemon/src/commands/conversation.rs`, pinned by
 * `tests/commands_fixtures/conversation_parity.json`.
 *
 * # Everything resolves against the *merged* list
 *
 * Every command here that takes a `ref` resolves it against
 * `mergeToolLoopMessages(...)`, not against the raw store, so an index means
 * what the user counted on their screen. Two consequences the fixture pins:
 *
 * - A tool loop folds into one assistant turn that carries the **closing**
 *   message's `msg_id`. Editing "the last assistant turn" writes to the message
 *   that ended the loop; the message that opened it cannot be named by a
 *   relative ref at all.
 * - A tool-result-only user turn is consumed by the merge, including one left
 *   orphaned at the head of a trimmed history. It is not in the list, so every
 *   index after it shifts and its own id resolves to nothing.
 *
 * # No `CommandContext`
 *
 * The Rust threaded a `&CommandContext` through all eight commands and every
 * one of them ignored it (`_ctx`). It is dropped here rather than carried as a
 * parameter nothing reads.
 */

import { mergeToolLoopMessages } from "../engine/merge.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { ImageRef, Message, Role } from "../engine/types.ts";
import { embedImageData, embedMessagesImageData } from "../engine/wire_images.ts";
import { localRfc3339 } from "../time.ts";
import { engineError, invalidRequest, notFound } from "./errors.ts";

/** How many user turns `log` returns when the caller bounds nothing. */
const DEFAULT_LOG_TURNS = 64;

/** Anything a command hands back to the dispatcher, which serializes it. */
export type Json = unknown;

/** Args arrive as a decoded JSON object; every field is optional and untyped. */
export type Args = Record<string, unknown>;

// ── argument readers ──────────────────────────────────────────────────────

/** `Value::as_str`: a string, or nothing. A number is not a string. */
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * `Value::as_u64`: a non-negative integer. `-1` and `1.5` are both `None` in
 * serde, which is why callers fall through to their default rather than
 * erroring on them.
 *
 * Integers above 2^53 lose precision here where serde held them exactly. Every
 * caller is a message count or a cursor into one conversation, so the range
 * that differs is unreachable.
 */
function asU64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * `str::parse::<i64>()`, exactly: an optional sign, then ASCII digits, and
 * nothing else. No decimal point, no exponent, no surrounding space, and no
 * value outside `i64` — all of which Rust rejects and JavaScript's `Number`
 * would happily accept, sending `"1.5"` down the index path instead of the
 * literal-id path where it belongs.
 */
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function parseI64(text: string): bigint | undefined {
  if (!/^[+-]?[0-9]+$/.test(text)) return undefined;
  const n = BigInt(text);
  return n >= I64_MIN && n <= I64_MAX ? n : undefined;
}

// ── reference resolution ──────────────────────────────────────────────────

/**
 * Resolve a message reference to a concrete `msg_id`.
 *
 * `"last"` / `"latest"`, a negative index (`-1` is the last), a positive
 * 1-based index (`3` is the third), or a literal `msg_id`.
 *
 * A literal is a **passthrough**: this does not check that the id exists. Every
 * caller looks it up afterwards and reports the miss itself, which is why a
 * bad id and a bad index come back with different messages.
 */
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

/**
 * Resolve a ref that must name an assistant message.
 *
 * An absent ref and `"last"` are not the same path: absent means "the newest
 * *assistant* message", found by scanning backwards, while `"last"` here also
 * means that — but a ref that names a user message is a hard error rather than
 * a search. So `alt` with no argument works on a conversation whose newest
 * message is the user's, and `alt --ref last` on that same conversation is
 * also fine, while `alt --ref 1` pointing at a user turn is rejected.
 */
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

// ── paging ────────────────────────────────────────────────────────────────

/**
 * The index `turns` user turns back from `endBound`.
 *
 * Counts by `role === "user"` alone. On the display list that is the same as
 * counting real turns, because the merge has already consumed every
 * tool-result-only user message before this sees them.
 */
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

/**
 * How many user turns the conversation holds, for the client's scrollbar.
 *
 * The `tool_result` exclusion cannot fire on the only path that reaches this:
 * the caller always passes a merged list, and the merge has already dropped
 * those messages. Kept because it is one clause and it states what the count
 * means; the fixture would not notice either way.
 */
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

/** `turns` wins over `count`; neither means the last 64 turns. */
function pageStartByArgs(messages: readonly Message[], end: number, args: Args): number {
  const turns = asU64(args["turns"]);
  if (turns !== undefined) return pageStartByTurns(messages, end, turns);

  const count = asU64(args["count"]);
  if (count !== undefined) return Math.max(0, end - count);

  return pageStartByTurns(messages, end, DEFAULT_LOG_TURNS);
}

/** An explicit `role` arg, validated against the three the protocol has. */
function roleFilter(args: Args): Role | undefined {
  if (!("role" in args)) return undefined;
  const role = args["role"];
  if (role === "user" || role === "assistant" || role === "system") return role;
  throw invalidRequest("role must be one of user, assistant, or system");
}

function matchesRole(message: Message, role: Role | undefined): boolean {
  return role === undefined || message.role === role;
}

/** `before`: `"active"`, a numeric cursor from a prior page, or absent. */
function resolveHistoryBefore(args: Args, activeStart: number, total: number): number {
  if (!("before" in args)) return total;
  const before = args["before"];
  if (before === "active") return activeStart;

  const index = asU64(before);
  if (index === undefined) throw invalidRequest('before must be "active" or a message cursor');
  return Math.min(index, total);
}

/**
 * The page body both `log` and `history_page` return.
 *
 * `activeStart` in the payload is a *page-local* index — how many of the page's
 * messages are archived scrollback — while `globalActiveStart` is the boundary
 * in the full list. Role filtering shrinks the page, so the local index is
 * recounted after filtering rather than derived from the global one.
 *
 * Only the active tail gets image bytes embedded. Archived scrollback keeps its
 * refs as labels, which is what stops a long backscroll from carrying every
 * image the conversation ever had.
 */
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

// ── commands ──────────────────────────────────────────────────────────────

/** One message, by index or reference, from the merged and filtered list. */
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

/**
 * Conversation history, bounded by messages (`count`) or turns (`turns`).
 *
 * Spans archived segments and the active tail: `count: 3` on a conversation
 * with two archived and two active messages reaches back into the archive.
 */
export async function log(engine: ConversationEngine, args: Args): Promise<Json> {
  const { messages, activeStart } = await engine.displayHistory();
  const end = messages.length;
  const start = pageStartByArgs(messages, end, args);
  const role = roleFilter(args);

  return historyPagePayload(messages, activeStart, start, end, role);
}

/** A bounded page of older display history, for lazy clients. */
export async function historyPage(engine: ConversationEngine, args: Args): Promise<Json> {
  const { messages, activeStart } = await engine.displayHistory();
  const end = resolveHistoryBefore(args, activeStart, messages.length);
  const start = pageStartByArgs(messages, end, args);
  const role = roleFilter(args);

  return historyPagePayload(messages, activeStart, start, end, role);
}

/** Rewrite a message's text. The ref resolves on the merged list, the write lands by id. */
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

/**
 * Delete one or more messages. `refs` is an array of strings or a single string.
 *
 * Every ref is resolved *before* any message is deleted, so relative refs in
 * one call all mean what they meant on the list the user was looking at rather
 * than shifting under each other. The deletions themselves then run in order
 * and stop at the first failure — which leaves the earlier ones applied. That
 * is the Rust's behaviour and the fixture pins it: a half-deleted list and an
 * error is a reachable outcome, not a rollback.
 */
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

  const merged = mergeToolLoopMessages([...engine.messages()]);
  const resolved = rawRefs.map((r) => resolveRef(merged, r));

  const deleted: string[] = [];
  for (const msgId of resolved) {
    try {
      await engine.deleteMessage(msgId);
    } catch (e) {
      throw engineError(e);
    }
    deleted.push(msgId);
  }

  return { deleted };
}

/** The stored alternate responses for an assistant message. */
export function listAlternatives(engine: ConversationEngine, args: Args): Json {
  const merged = mergeToolLoopMessages([...engine.messages()]);
  const msgId = resolveAssistantRef(merged, asStr(args["ref"]));
  const msg = merged.find((m) => m.msg_id === msgId);
  if (msg === undefined) throw notFound(`Message not found: ${msgId}`);

  const alts = msg.alternatives ?? [];
  const altCount = alts.length;
  const current = Math.min(msg.alt_index ?? 0, Math.max(0, altCount - 1));
  const alternatives = alts.map((alt, index) => {
    const images: ImageRef[] = structuredClone(alt.images);
    embedImageData(images);
    return {
      index,
      position: index + 1,
      active: index === current,
      content: alt.content,
      images,
      timestamp: alt.timestamp,
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

/**
 * Select a stored alternate response.
 *
 * `index` beats `position` beats `direction`, and a stored `alt_index` past the
 * end is clamped to the last alternative before `prev`/`next` step from it.
 */
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

/**
 * Append a system-role instruction mid-conversation.
 *
 * Lets the user correct behaviour ("stop using roleplay actions") without
 * editing the system prompt or putting a meta-instruction in a user turn.
 *
 * `newId` and `now` are injected the way `handler/persistence.ts` injects them,
 * so a test can pin the message this writes; both default to the real thing.
 */
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
