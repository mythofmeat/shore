#!/usr/bin/env python3
"""Mutation pass over the conversation commands: argument decoding, message
references, history paging and the engine arithmetic behind it, and edit,
delete, alternatives and inject.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/conversation.ts"

ENGINE = ROOT / "src/engine/conversation.ts"

MUTANTS = [
    # --- argument readers --------------------------------------------------
    ("asStr: a number counts as a string",
     '  return typeof v === "string" ? v : undefined;',
     '  return typeof v === "string" ? v : v === undefined || v === null ? undefined : String(v);'),
    ("asU64: a negative number is accepted",
     '  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;',
     '  return typeof v === "number" && Number.isInteger(v) ? v : undefined;'),
    ("asU64: a non-integer is accepted",
     '  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;',
     '  return typeof v === "number" && v >= 0 ? v : undefined;'),
    ("parseI64: the loose JavaScript number parse",
     '  if (!/^[+-]?[0-9]+$/.test(text)) return undefined;\n'
     '  const n = BigInt(text);\n'
     '  return n >= I64_MIN && n <= I64_MAX ? n : undefined;',
     '  const n = Number(text);\n'
     '  return text.trim() !== "" && Number.isFinite(n) ? BigInt(Math.trunc(n)) : undefined;'),
    ("parseI64: a leading + is rejected",
     '  if (!/^[+-]?[0-9]+$/.test(text)) return undefined;',
     '  if (!/^-?[0-9]+$/.test(text)) return undefined;'),
    ("parseI64: out-of-range saturates instead of falling through to a literal",
     '  return n >= I64_MIN && n <= I64_MAX ? n : undefined;',
     '  return n < I64_MIN ? I64_MIN : n > I64_MAX ? I64_MAX : n;'),

    # --- resolveRef --------------------------------------------------------
    ('resolveRef: "latest" is not an alias for "last"',
     '  if (reference === "last" || reference === "latest") {',
     '  if (reference === "last") {'),
    ("resolveRef: an empty conversation reports the index error instead",
     '    if (last === undefined) throw notFound("No messages in conversation");',
     '    if (last === undefined) throw notFound("Message index out of range");'),
    ("resolveRef: zero is treated as an index rather than rejected",
     "    if (parsed === 0n) {\n"
     '      throw invalidRequest("Message index must be non-zero (use 1 for first, -1 for last)");\n'
     "    }",
     "    if (false as boolean) {\n"
     '      throw invalidRequest("Message index must be non-zero (use 1 for first, -1 for last)");\n'
     "    }"),
    ("resolveRef: positive indices are 0-based",
     "    const signed = parsed < 0n ? BigInt(messages.length) + parsed : parsed - 1n;",
     "    const signed = parsed < 0n ? BigInt(messages.length) + parsed : parsed;"),
    ("resolveRef: negative indices are off by one",
     "    const signed = parsed < 0n ? BigInt(messages.length) + parsed : parsed - 1n;",
     "    const signed = parsed < 0n ? BigInt(messages.length) + parsed - 1n : parsed - 1n;"),
    ("resolveRef: negative indices count from the front",
     "    const signed = parsed < 0n ? BigInt(messages.length) + parsed : parsed - 1n;",
     "    const signed = parsed < 0n ? -parsed - 1n : parsed - 1n;"),
    ("resolveRef: the upper bound is inclusive",
     "    if (signed < 0n || signed >= BigInt(messages.length)) throw outOfRange();",
     "    if (signed < 0n || signed > BigInt(messages.length)) throw outOfRange();"),
    ("resolveRef: a negative resolved index is clamped instead of rejected",
     "    if (signed < 0n || signed >= BigInt(messages.length)) throw outOfRange();",
     "    if (signed >= BigInt(messages.length)) throw outOfRange();\n"
     "    if (signed < 0n) return messages[0]!.msg_id;"),
    ("resolveRef: an unknown literal is rejected rather than passed through",
     "  return reference;",
     "  if (messages.some((m) => m.msg_id === reference)) return reference;\n"
     "  throw notFound(`Message not found: ${reference}`);"),

    # --- resolveAssistantRef -----------------------------------------------
    ("assistant ref: an absent ref means the last message, not the last assistant",
     '  if (reference === undefined || reference === "last" || reference === "latest") {\n'
     "    for (let i = messages.length - 1; i >= 0; i -= 1) {\n"
     "      const msg = required(messages[i]);\n"
     '      if (msg.role === "assistant") return msg.msg_id;\n'
     "    }\n"
     '    throw notFound("No assistant messages in conversation");\n'
     "  }",
     '  if (reference === undefined || reference === "last" || reference === "latest") {\n'
     "    const last = messages[messages.length - 1];\n"
     '    if (last === undefined) throw notFound("No assistant messages in conversation");\n'
     "    return last.msg_id;\n"
     "  }"),
    ('assistant ref: an explicit "last" takes the strict path',
     '  if (reference === undefined || reference === "last" || reference === "latest") {',
     "  if (reference === undefined) {"),
    ("assistant ref: a user message is accepted",
     '  if (msg.role !== "assistant") {\n'
     '    throw invalidRequest("Alternate response selection only applies to assistant messages");\n'
     "  }",
     "  if (false as boolean) {\n"
     '    throw invalidRequest("Alternate response selection only applies to assistant messages");\n'
     "  }"),
    ("assistant ref: the scan runs forwards",
     "    for (let i = messages.length - 1; i >= 0; i -= 1) {",
     "    for (let i = 0; i < messages.length; i += 1) {"),

    # --- paging arithmetic -------------------------------------------------
    ("activeStartForTurns: zero turns returns the whole page",
     ENGINE,
     "  if (turns === 0) return end;",
     "  if (turns === 0) return 0;"),
    ("activeStartForTurns: the boundary is exclusive of the turn's own message",
     ENGINE,
     "    if (remaining === 0) return index;",
     "    if (remaining === 0) return index + 1;"),
    ("activeStartForTurns: off by one on the turn count",
     ENGINE,
     "    remaining -= 1;\n"
     "    if (remaining === 0) return index;",
     "    if (remaining === 0) return index;\n"
     "    remaining -= 1;"),
    ("activeStartForTurns: the scan starts at the end bound itself",
     ENGINE,
     "  for (let index = end - 1; index >= 0; index -= 1) {",
     "  for (let index = end; index >= 0; index -= 1) {"),
    ("activeStartForTurns: assistant turns are counted too",
     ENGINE,
     '    if (requiredMessage(active, index).role !== "user") continue;\n',
     ""),
    ("activeStartForTurns: a short context starts at its end instead of its start",
     ENGINE,
     "    if (remaining === 0) return index;\n  }\n  return 0;",
     "    if (remaining === 0) return index;\n  }\n  return end;"),

    # --- the current context -----------------------------------------------
    ("currentPage: an absent cursor means the start, not the end",
     ENGINE,
     "    const end = Math.min(before ?? active.length, active.length);",
     "    const end = Math.min(before ?? 0, active.length);"),
    ("currentPage: an out-of-range cursor is not clamped",
     ENGINE,
     "    const end = Math.min(before ?? active.length, active.length);",
     "    const end = before ?? active.length;"),
    ("currentPage: a message count reaches past the start",
     ENGINE,
     "        ? Math.max(0, end - limit.value)",
     "        ? end - limit.value"),
    ("currentPage: has_more_before is inclusive of the first page",
     ENGINE,
     "      hasMoreBefore: start > 0,",
     "      hasMoreBefore: start >= 0,"),
    ("currentPage: the segment before the context is not named",
     ENGINE,
     "      previousSegment: this.#segments.latestEntry(),",
     "      previousSegment: undefined,"),

    # --- an archived segment -----------------------------------------------
    ("segmentPage: a missing segment falls back to the current context",
     ENGINE,
     "    if (segment === undefined) return undefined;",
     "    if (segment === undefined) return this.#currentPage(before, limit);"),
    ("segmentPage: an absent cursor means the segment's start",
     ENGINE,
     "    const end = Math.min(Math.max(before ?? bounds.end, bounds.start), bounds.end);",
     "    const end = Math.min(Math.max(before ?? bounds.start, bounds.start), bounds.end);"),
    ("segmentPage: a cursor past the segment is not clamped to its end",
     ENGINE,
     "    const end = Math.min(Math.max(before ?? bounds.end, bounds.start), bounds.end);",
     "    const end = Math.max(before ?? bounds.end, bounds.start);"),
    ("segmentPage: a page reaches back past the segment's start",
     ENGINE,
     "    const start = Math.max(\n      bounds.start,",
     "    const start = Math.max(\n      0,"),
    ("segmentPage: a message count is read as a turn budget",
     ENGINE,
     'limit.kind === "count" ? end - limit.value : this.#segments.startForTurns(index, end, limit.value),',
     "this.#segments.startForTurns(index, end, limit.value),"),
    ("segmentPage: has_more_before compares with zero, not the segment's start",
     ENGINE,
     "      hasMoreBefore: start > bounds.start,",
     "      hasMoreBefore: start > 0,"),
    ("segmentPage: the total counts the page, not the segment",
     ENGINE,
     "      totalTurns: this.#segments.turnCount(index),",
     "      totalTurns: countUserTurns(messages),"),
    ("segmentPage: the page does not say which segment it is",
     ENGINE,
     "      segment,\n      previousSegment: this.#segments.entryBefore(index),",
     "      segment: undefined,\n      previousSegment: this.#segments.entryBefore(index),"),
    ("segmentPage: the neighbours are swapped",
     ENGINE,
     "      previousSegment: this.#segments.entryBefore(index),\n"
     "      nextSegment: this.#segments.entryAfter(index),",
     "      previousSegment: this.#segments.entryAfter(index),\n"
     "      nextSegment: this.#segments.entryBefore(index),"),
    ("segmentPage: tool loops are not merged",
     ENGINE,
     "    const messages = mergeToolLoopMessages(slice.messages);",
     "    const messages = slice.messages;"),

    # --- turn totals -------------------------------------------------------
    ("countUserTurns: counts every message",
     ENGINE,
     '  return messages.filter((message) => message.role === "user").length;',
     "  return messages.length;"),
    ("countUserTurns: counts assistant turns as well",
     ENGINE,
     '  return messages.filter((message) => message.role === "user").length;',
     '  return messages.filter((message) => message.role !== "system").length;'),

    # --- the page limit ----------------------------------------------------
    ("historyPageLimit: count wins over turns",
     '  const turns = asU64(args["turns"]);\n'
     '  if (turns !== undefined) return { kind: "turns", value: turns };\n'
     "\n"
     '  const count = asU64(args["count"]);\n'
     '  if (count !== undefined) return { kind: "count", value: count };',
     '  const count = asU64(args["count"]);\n'
     '  if (count !== undefined) return { kind: "count", value: count };\n'
     "\n"
     '  const turns = asU64(args["turns"]);\n'
     '  if (turns !== undefined) return { kind: "turns", value: turns };'),
    ("historyPageLimit: count is read as a turn bound",
     '  if (count !== undefined) return { kind: "count", value: count };',
     '  if (count !== undefined) return { kind: "turns", value: count };'),
    ("historyPageLimit: the default is unbounded",
     '  return { kind: "turns", value: DEFAULT_LOG_TURNS };',
     '  return { kind: "count", value: Number.MAX_SAFE_INTEGER };'),
    ("pageStartByArgs: the default turn budget is smaller",
     "const DEFAULT_LOG_TURNS = 64;",
     "const DEFAULT_LOG_TURNS = 1;"),

    # --- role filtering ----------------------------------------------------
    ("roleFilter: an absent role is not distinguished from a bad one (EQUIVALENT — decoded JSON never carries a present-but-undefined key)",
     '  if (!("role" in args)) return undefined;',
     "  if (args[\"role\"] === undefined) return undefined;"),
    ("roleFilter: any string is accepted",
     '  if (role === "user" || role === "assistant" || role === "system") return role;',
     '  if (typeof role === "string") return role as Role;'),
    ("roleFilter: system is not a valid filter",
     '  if (role === "user" || role === "assistant" || role === "system") return role;',
     '  if (role === "user" || role === "assistant") return role;'),
    ("matchesRole: an absent filter matches nothing",
     "  return role === undefined || message.role === role;",
     "  return role !== undefined && message.role === role;"),

    # --- segment and cursor arguments ---------------------------------------
    ("historyScope: null is read as a segment number",
     '  if (segment === undefined || segment === null) return "current";',
     '  if (segment === undefined) return "current";'),
    ("historyScope: a bad segment falls back to the current context",
     '  if (index === undefined) throw invalidRequest("segment must be a non-negative integer");',
     '  if (index === undefined) return "current";'),
    ("before: null is read as a cursor",
     "  if (before === undefined || before === null) return undefined;",
     "  if (before === undefined) return undefined;"),
    ("before: a bad cursor falls back instead of erroring",
     '  if (index === undefined) throw invalidRequest("before must be a message cursor");',
     "  if (index === undefined) return undefined;"),
    ("readHistoryPage: a missing segment answers with the current context",
     "  if (history === undefined) {\n",
     "  if (history === undefined) {\n"
     '    return historyPagePayload(required(engine.displayHistoryPage("current", before, historyPageLimit(args))), role, engine.characterName);\n'),
    ("readHistoryPage: a side thread's missing segment is reported against the character alone",
     "    const where = engine.thread === MAIN_THREAD ? engine.characterName : `${engine.characterName} thread ${engine.thread}`;",
     "    const where = engine.characterName;"),

    # --- the page payload --------------------------------------------------
    ("payload: has_more_before is worked out from the cursor alone",
     "    has_more_before: history.hasMoreBefore,",
     "    has_more_before: history.cursor > 0,"),
    ("payload: the cursor points past the page it names",
     "    cursor: history.cursor,\n    next_before: history.cursor,",
     "    cursor: history.cursor,\n    next_before: history.cursor + page.length,"),
    ("payload: image bytes are embedded into archived pages too",
     "  if (history.segment === undefined) embedMessagesImageData(page);",
     "  embedMessagesImageData(page);"),
    ("payload: image bytes are never embedded",
     "  if (history.segment === undefined) embedMessagesImageData(page);",
     "  void page;"),
    ("payload: the segment before is dropped",
     "    previous_segment: presentOptionalSegment(history.previousSegment),",
     "    previous_segment: null,"),
    ("payload: the segment after is dropped",
     "    next_segment: presentOptionalSegment(history.nextSegment),",
     "    next_segment: null,"),
    ("payload: the page shares objects with the store",
     "    .map((msg) => structuredClone(msg));",
     "    .map((msg) => msg);"),

    # --- get ----------------------------------------------------------------
    ("get: a missing ref defaults to the last message",
     'export function get(engine: ConversationEngine, args: Args): OperationResult<"get"> {\n'
     '  const rawRef = asStr(args["ref"]);\n'
     '  if (rawRef === undefined) throw invalidRequest("Missing required argument: ref");',
     'export function get(engine: ConversationEngine, args: Args): OperationResult<"get"> {\n'
     '  const rawRef = asStr(args["ref"]) ?? "last";'),
    ("get: the ref resolves before the role filter",
     "  const merged = mergeToolLoopMessages([...engine.messages()]).filter((msg) =>\n"
     "    matchesRole(msg, role),\n"
     "  );\n"
     "  const msgId = resolveRef(merged, rawRef);",
     "  const all = mergeToolLoopMessages([...engine.messages()]);\n"
     "  const msgId = resolveRef(all, rawRef);\n"
     "  const merged = all.filter((msg) => matchesRole(msg, role));"),
    ("get: the tool loop is not merged",
     "  const merged = mergeToolLoopMessages([...engine.messages()]).filter((msg) =>\n"
     "    matchesRole(msg, role),\n"
     "  );",
     "  const merged = [...engine.messages()].filter((msg) => matchesRole(msg, role));"),

    # --- edit ---------------------------------------------------------------
    ("edit: missing content is not required",
     '  const content = asStr(args["content"]);\n'
     '  if (content === undefined) throw invalidRequest("Missing required argument: content");',
     '  const content = asStr(args["content"]) ?? "";'),
    ("edit: ref and content errors are swapped",
     '  const rawRef = asStr(args["ref"]);\n'
     '  if (rawRef === undefined) throw invalidRequest("Missing required argument: ref");\n'
     '  const content = asStr(args["content"]);\n'
     '  if (content === undefined) throw invalidRequest("Missing required argument: content");',
     '  const content = asStr(args["content"]);\n'
     '  if (content === undefined) throw invalidRequest("Missing required argument: content");\n'
     '  const rawRef = asStr(args["ref"]);\n'
     '  if (rawRef === undefined) throw invalidRequest("Missing required argument: ref");'),
    ("edit: resolves against the raw store rather than the merged list",
     "  const merged = mergeToolLoopMessages([...engine.messages()]);\n"
     "  const msgId = resolveRef(merged, rawRef);\n"
     "  const previous = replyVersion(engine.messages(), msgId);\n"
     "  try {\n"
     "    await engine.editMessage(msgId, content);",
     "  const msgId = resolveRef([...engine.messages()], rawRef);\n"
     "  const previous = replyVersion(engine.messages(), msgId);\n"
     "  try {\n"
     "    await engine.editMessage(msgId, content);"),

    # --- delete -------------------------------------------------------------
    ("delete: a non-string element is coerced",
     "      const s = asStr(v);\n"
     '      if (s === undefined) throw invalidRequest("refs must be an array of strings");\n'
     "      return s;",
     "      return String(v);"),
    ("delete: a missing refs argument deletes nothing quietly",
     '    throw invalidRequest("Missing required argument: refs");',
     "    rawRefs = [];"),
    ("delete: refs are resolved lazily, one at a time",
     "  const turns = rawRefs.map((r) => turnMsgIds(raw, resolveRef(merged, r)));\n\n"
     "  const known = new Set(raw.map((m) => m.msg_id));\n"
     "  for (const turn of turns) {\n"
     "    for (const msgId of turn) {\n"
     "      if (!known.has(msgId)) throw notFound(`message not found: ${msgId}`);\n"
     "    }\n"
     "  }\n\n"
     "  const deleted: string[] = [];\n"
     "  const gone = new Set<string>();\n"
     "  for (const turn of turns) {",
     "  const deleted: string[] = [];\n"
     "  const gone = new Set<string>();\n"
     "  for (const rawRef of rawRefs) {\n"
     "    const turn = turnMsgIds(\n"
     "      [...engine.messages()],\n"
     "      resolveRef(mergeToolLoopMessages([...engine.messages()]), rawRef),\n"
     "    );\n"
     "    void raw;\n"
     "    void merged;"),
    ("delete: an unknown ref is not noticed until earlier refs are already gone",
     "  const known = new Set(raw.map((m) => m.msg_id));\n"
     "  for (const turn of turns) {\n"
     "    for (const msgId of turn) {\n"
     "      if (!known.has(msgId)) throw notFound(`message not found: ${msgId}`);\n"
     "    }\n"
     "  }\n\n",
     ""),
    ("delete: a ref names one message rather than the whole turn it sits in",
     "  const turns = rawRefs.map((r) => turnMsgIds(raw, resolveRef(merged, r)));",
     "  const turns = rawRefs.map((r) => [resolveRef(merged, r)]);"),
    ("delete: a message already deleted by an earlier ref is deleted again",
     "    const pending = turn.filter((msgId) => !gone.has(msgId));\n"
     "    if (pending.length === 0) continue;",
     "    const pending = turn;"),
    ("delete: a failure is swallowed and the rest of the refs go ahead",
     "      await engine.deleteMessages(pending);\n    } catch (e) {\n      throw engineError(e);\n    }",
     "      await engine.deleteMessages(pending);\n    } catch (e) {\n      void e;\n      continue;\n    }"),

    # --- alternatives -------------------------------------------------------
    ("alternatives: the stored index is not clamped (EQUIVALENT — Message.normalize clamps alt_index on load, so no stored value is out of range)",
     "  const current = Math.min(msg.alt_index ?? 0, Math.max(0, altCount - 1));",
     "  const current = msg.alt_index ?? 0;"),
    ("alternatives: position is 0-based",
     "      position: index + 1,",
     "      position: index,"),
    ("alternatives: the active marker is off by one",
     "      active: index === current,",
     "      active: index === current + 1,"),
    ("alternatives: alt_index is reported as 0 rather than null",
     "    alt_index: msg.alt_index ?? null,",
     "    alt_index: msg.alt_index ?? 0,"),
    ("alternatives: the top-level position is derived from the clamped index",
     "    position: msg.alt_index === undefined ? null : msg.alt_index + 1,",
     "    position: current + 1,"),
    ("alternatives: image bytes are not embedded",
     "    const images: ImageRef[] = structuredClone(alternative.images);\n"
     "    embedImageData(images);",
     "    const images: ImageRef[] = structuredClone(alternative.images);"),
    ("alt: an empty alternative list is not rejected",
     "  if (altCount === 0) throw invalidRequest(`message ${msgId} has no alternate responses`);",
     "  if (false as boolean) throw invalidRequest(`message ${msgId} has no alternate responses`);"),
    ("alt: the stored index is not clamped before stepping (EQUIVALENT — Message.normalize clamps alt_index on load)",
     "  const current = Math.min(msg.alt_index ?? 0, altCount - 1);",
     "  const current = msg.alt_index ?? 0;"),
    ("alt target: position wins over index",
     '  const index = asU64(args["index"]);\n'
     "  if (index !== undefined) {\n"
     "    if (index >= count) {\n"
     "      throw invalidRequest(\n"
     "        `alternate index ${index + 1} out of range (message has ${count} alternate response(s))`,\n"
     "      );\n"
     "    }\n"
     "    return index;\n"
     "  }\n"
     "\n"
     '  const position = asU64(args["position"]);',
     '  const position = asU64(args["position"]);\n'
     "  if (position === undefined) {\n"
     '    const index = asU64(args["index"]);\n'
     "    if (index !== undefined) {\n"
     "      if (index >= count) {\n"
     "        throw invalidRequest(\n"
     "          `alternate index ${index + 1} out of range (message has ${count} alternate response(s))`,\n"
     "        );\n"
     "      }\n"
     "      return index;\n"
     "    }\n"
     "  }\n"),
    ("alt target: direction wins over index",
     '  const index = asU64(args["index"]);\n'
     "  if (index !== undefined) {",
     '  const index = args["direction"] === undefined ? asU64(args["index"]) : undefined;\n'
     "  if (index !== undefined) {"),
    ("alt target: the index bound is inclusive (EQUIVALENT — MessageStore.selectAlt re-checks and raises the identical message)",
     "    if (index >= count) {",
     "    if (index > count) {"),
    ("alt target: the index error reports the raw index",
     "        `alternate index ${index + 1} out of range (message has ${count} alternate response(s))`,",
     "        `alternate index ${index} out of range (message has ${count} alternate response(s))`,"),
    ("alt target: position 0 is accepted",
     "    if (position === 0 || position > count) {",
     "    if (position > count) {"),
    ("alt target: the position bound is exclusive",
     "    if (position === 0 || position > count) {",
     "    if (position === 0 || position >= count) {"),
    ("alt target: position is not converted to an index",
     "    return position - 1;",
     "    return position;"),
    ('alt target: "previous" is not an alias for "prev"',
     '    case "prev":\n    case "previous":',
     '    case "prev":'),
    ("alt target: the default direction is prev",
     '  switch (asStr(args["direction"]) ?? "next") {',
     '  switch (asStr(args["direction"]) ?? "prev") {'),
    ("alt target: prev walks off the front",
     "      return Math.max(0, current - 1);",
     "      return current - 1;"),
    ("alt target: next walks off the end",
     "      return Math.min(current + 1, count - 1);",
     "      return current + 1;"),
    ("alt target: first and last are swapped",
     '    case "first":\n      return 0;\n    case "last":\n      return count - 1;',
     '    case "first":\n      return count - 1;\n    case "last":\n      return 0;'),
    ("alt target: an unknown direction falls back to next",
     "    default:\n      throw invalidRequest(`unknown alt direction: ${asStr(args[\"direction\"])}`);",
     "    default:\n      return Math.min(current + 1, count - 1);"),
    ("alt: the returned position is 0-based",
     "    position: selection.alt_index + 1,",
     "    position: selection.alt_index,"),

    # --- inject_system ------------------------------------------------------
    ("inject: an empty text is rejected",
     '  const text = asStr(args["text"]);\n'
     '  if (text === undefined) throw invalidRequest("Missing required argument: text");',
     '  const text = asStr(args["text"]);\n'
     '  if (text === undefined || text === "") throw invalidRequest("Missing required argument: text");'),
    ("inject: the message is appended as a user turn",
     '    role: "system",',
     '    role: "user",'),
    ("inject: content_blocks are left empty",
     '    content_blocks: [{ type: "text", text }],',
     "    content_blocks: [],"),
    ("inject: the msg_id has no prefix",
     "  newId: () => string = () => `m_${crypto.randomUUID()}`,",
     "  newId: () => string = () => crypto.randomUUID(),"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/conversation.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
