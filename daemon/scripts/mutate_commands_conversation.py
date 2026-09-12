#!/usr/bin/env python3
"""Mutation pass over the conversation command surface (#18 / #12).

This module's risk is concentrated in two places, and neither errors when it is
wrong:

- **Reference resolution.** `resolveRef` turns "-1" or "3" into a msg_id. An
  off-by-one resolves to a real, adjacent message, and `edit` then rewrites the
  wrong turn and reports success. There is no failure to observe.
- **Paging arithmetic.** `log` and `history_page` return a slice plus four
  indices the client uses to place the archive boundary and ask for the next
  page. A boundary that is one off greys out the wrong message; a `cursor` that
  is one off makes the client re-request a page it already has, or skip one.

A mutant is KILLED if `bun test tests/conversation.test.ts` fails with it
applied; a survivor means either the tests cannot see that decision, or the
code is equivalent under it.

The first pass was 70/87, the second 79/88, and the fifth is 82/91. Six of the
nine first-pass survivors were real gaps, and the shape was the usual one — the
case was present and nothing in it was load-bearing:

- **Nothing read history without bounding it.** `history_page` was always called
  with a `before`, so "an absent cursor means the start of the conversation
  rather than the end" changed nothing. Three unbounded calls now cover it.
- **No conversation was long enough for the default to bound anything.** Every
  case had fewer than 64 user turns, so `pageStartByTurns(…, 64)` and `return 0`
  agreed. A generated 66-turn conversation now separates them; that is the shape
  of every plain `shore log`, and it had no coverage at all.
- **Nothing passed a non-integer.** `count`, `turns`, `index` and `position` all
  read through `asU64`, where `1.5` and `-1` are *absent* rather than errors — so
  they silently fall through to the next branch. Every argument had been an
  integer, so the difference between "reject" and "ignore" could not show. Both
  forms are now passed to each of the four.
- **Two assistant messages, so the backwards scan means something.** Every
  alternatives case had exactly one assistant message, and a scan that ran
  forwards found the same one.
- **A filtered page that starts inside the archive.** The local active boundary
  is counted *after* role filtering; with only pages whose archived half was
  entirely one role, filtering it changed no count.
- **Reading history must not write bytes back into the store.** `log` embeds
  image data into the page it returns. The merge passes message objects through
  by reference, so without a copy the base64 lands in the live store and
  `MessageStore` rewrites `active.jsonl` from those objects. Nothing looked at
  the engine after a read; every read now asserts the conversation is unchanged.

The nine remaining survivors are all true equivalents, in three groups:

1. **Two clamps that cover each other.** `resolveHistoryBefore` clamps the
   cursor to the message count and `pageStartByTurns` clamps its end bound to
   the same thing, as do the two in `historyPagePayload`. Removing any one is
   invisible because another catches it; removing the pair *is* caught, which is
   what the "BOTH redundant clamps" mutant is for. Kept as written — each one
   states a bound that holds.
2. **Guards on a value the store cannot produce.** `Message.normalize` clamps
   `alt_index` to `alternatives.length - 1` on every load, so no conversation on
   disk can carry an out-of-range one — a case writes `alt_index: 7` against
   three alternatives and the engine loads it as `2`. The clamps in
   `listAlternatives` and `alt` therefore cannot fire. Likewise
   `MessageStore.selectAlt` re-checks `index >= altCount` and raises the
   identical message, so `resolveAltTarget`'s bound is redundant with it.
3. **`"role" in args` versus `args.role === undefined`.** These differ only for a
   key that is present with an `undefined` value, which decoded JSON never
   produces.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_conversation.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/conversation.ts"

# `#155` moved the paging arithmetic into the engine, behind two paths: the
# storage-native one that reads a bounded range out of SQLite, and the fallback
# that still materialises the whole conversation. The command keeps argument
# decoding, the role filter and the payload shape, so mutants that reach into
# the engine name it with the four-part `(label, path, find, replace)` shape.
ENGINE = ROOT / "src/engine/conversation.ts"

# (label, find, replace) — or (label, [(find, replace), ...]) for a mutant that
# only becomes visible when several places change together. A mutant against a
# source other than SRC is `(label, path, find, replace)`.
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

    # --- paging arithmetic, fallback path ----------------------------------
    # `historyPageStart` walks a conversation that is already fully in memory.

    # --- paging arithmetic, storage-native path ----------------------------
    # `#pageStartByTurns` spends the turn budget on the in-memory tail first and
    # asks storage for whatever is left, so the hand-off is the interesting part.
    ("pageStartByTurns: zero turns returns the whole page",
     ENGINE,
     "    if (turns === 0) return end;",
     "    if (turns === 0) return 0;"),
    ("pageStartByTurns: the boundary is exclusive of the turn's own message",
     ENGINE,
     "      if (remaining === 0) return globalActiveStart + index;",
     "      if (remaining === 0) return globalActiveStart + index + 1;"),
    ("pageStartByTurns: off by one on the turn count",
     ENGINE,
     "      remaining -= 1;\n"
     "      if (remaining === 0) return globalActiveStart + index;",
     "      if (remaining === 0) return globalActiveStart + index;\n"
     "      remaining -= 1;"),
    ("pageStartByTurns: the scan starts at the end bound itself",
     ENGINE,
     "    for (let index = activeEnd - 1; index >= 0; index -= 1) {",
     "    for (let index = activeEnd; index >= 0; index -= 1) {"),
    ("pageStartByTurns: assistant turns are counted too",
     ENGINE,
     '      if (requiredMessage(active, index).role !== "user") continue;\n',
     ""),
    ("pageStartByTurns: storage is asked for the whole budget, not the remainder",
     ENGINE,
     "    return this.#segments.displayStartForTurns(Math.min(end, globalActiveStart), remaining);",
     "    return this.#segments.displayStartForTurns(Math.min(end, globalActiveStart), turns);"),
    ("pageStartByTurns: the archive hand-off is not clamped to the page end",
     ENGINE,
     "    return this.#segments.displayStartForTurns(Math.min(end, globalActiveStart), remaining);",
     "    return this.#segments.displayStartForTurns(globalActiveStart, remaining);"),

    # --- the archived/active split -----------------------------------------
    ("page split: the archived range is not clamped to the active boundary (EQUIVALENT — readDisplayRange matches on a half-open display_seq range and the archive holds no row at or past globalActiveStart)",
     ENGINE,
     "    const archiveEnd = Math.min(end, globalActiveStart);",
     "    const archiveEnd = end;"),
    ("page split: the archived range starts at the raw page start (EQUIVALENT — readDisplayRange returns empty when end <= start, which is the only case the clamp changes)",
     ENGINE,
     "    const archiveStart = Math.min(start, globalActiveStart);",
     "    const archiveStart = start;"),
    ("page split: the active offset is allowed to go negative",
     ENGINE,
     "    const activeStart = Math.max(start - globalActiveStart, 0);",
     "    const activeStart = start - globalActiveStart;"),

    # --- turn totals -------------------------------------------------------
    ("countUserTurns: counts every message",
     ENGINE,
     '  return messages.filter((message) => message.role === "user").length;',
     "  return messages.length;"),
    ("countUserTurns: counts assistant turns as well",
     ENGINE,
     '  return messages.filter((message) => message.role === "user").length;',
     '  return messages.filter((message) => message.role !== "system").length;'),
    ("totals: the storage path forgets the archived turns",
     ENGINE,
     "      totalTurns: this.#segments.displayTurnCount() + countUserTurns(active),",
     "      totalTurns: countUserTurns(active),"),

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

    # --- history_page bounds -----------------------------------------------
    # `resolveHistoryBefore` decodes the cursor; `historyEnd` turns it into an
    # index. The clamp lives with the latter now, so both are engine mutants.
    ("historyEnd: an absent cursor means the start, not the end",
     ENGINE,
     "  return Math.min(before ?? total, total);",
     "  return Math.min(before ?? 0, total);"),
    ('historyEnd: "active" is read as a literal cursor',
     ENGINE,
     '  if (before === "active") return activeStart;',
     "  if (false as boolean) return activeStart;"),
    ("historyEnd: an out-of-range cursor is not clamped",
     ENGINE,
     "  return Math.min(before ?? total, total);",
     "  return before ?? total;"),
    ("before: a bad cursor falls back instead of erroring",
     "  const index = asU64(before);\n"
     "  if (index === undefined) throw invalidRequest('before must be \"active\" or a message cursor');",
     "  const index = asU64(before);\n"
     "  if (index === undefined) return undefined;"),

    # --- the page payload --------------------------------------------------
    ("payload: the local active boundary is the global one",
     "  const activePageStart = history.messages\n"
     "    .slice(0, history.activeStart)\n"
     "    .filter((msg) => matchesRole(msg, role)).length;",
     "  const activePageStart = history.globalActiveStart;"),
    ("payload: the local boundary is counted before role filtering",
     "  const activePageStart = history.messages\n"
     "    .slice(0, history.activeStart)\n"
     "    .filter((msg) => matchesRole(msg, role)).length;",
     "  const activePageStart = history.messages.slice(0, history.activeStart).length;"),
    ("payload: has_more_before is inclusive of the first page",
     "    has_more_before: history.cursor > 0,",
     "    has_more_before: history.cursor >= 0,"),
    ("payload: the cursor points past the page it names",
     "    cursor: history.cursor,\n    next_before: history.cursor,",
     "    cursor: history.cursor,\n    next_before: history.cursor + page.length,"),
    ("payload: image bytes are embedded into the whole page",
     "  embedMessagesImageData(page.slice(activePageStart));",
     "  embedMessagesImageData(page);"),
    ("payload: image bytes are never embedded",
     "  embedMessagesImageData(page.slice(activePageStart));",
     "  void page;"),
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
     "  try {\n"
     "    await engine.editMessage(msgId, content);",
     "  const msgId = resolveRef([...engine.messages()], rawRef);\n"
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


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/conversation.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
