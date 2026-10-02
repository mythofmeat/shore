#!/usr/bin/env python3
"""Mutation pass over `handler/turn.ts`: recording the user turn, seeding the
activity tracker, the context-token sum that gates compaction, and the
stream-end frame.
"""
import sys

TURN = "src/handler/turn.ts"

MUTANTS = [
    # --- what counts as a turn ------------------------------------------------
    ("empty: a body with only images reads as empty",
     'return body.text !== "" || body.images.length > 0 || body.image_data.length > 0;',
     'return body.text !== "";'),
    ("empty: a body with only inline uploads reads as empty",
     'return body.text !== "" || body.images.length > 0 || body.image_data.length > 0;',
     'return body.text !== "" || body.images.length > 0;'),
    ("empty: a body with only legacy paths reads as empty",
     'return body.text !== "" || body.images.length > 0 || body.image_data.length > 0;',
     'return body.text !== "" || body.image_data.length > 0;'),
    ("empty: every body counts as content, so an empty one appends a blank turn",
     "  if (!bodyHasContent(body)) return undefined;\n",
     ""),

    # --- acceptance -----------------------------------------------------------
    ("accept: acceptance is confirmed before the turn is saved",
     "  await engine.appendMessage(userMsg);\n",
     "  await ctx.accepted?.();\n  await engine.appendMessage(userMsg);\n"),
    ("accept: a saved turn is never confirmed",
     "  await ctx.accepted?.();\n",
     ""),

    # --- regen ----------------------------------------------------------------
    ("regen: a regen falls through and appends the body it was sent",
     "  if (regen) return engine.pendingRegenAlt() ?? { alternatives: [] };\n",
     ""),
    ("regen: no prior assistant turn yields undefined instead of empty alternatives",
     "  if (regen) return engine.pendingRegenAlt() ?? { alternatives: [] };",
     "  if (regen) return engine.pendingRegenAlt();"),
    ("regen: a fresh turn is treated as a regen",
     "  if (regen) return engine.pendingRegenAlt() ?? { alternatives: [] };",
     "  if (!regen) return engine.pendingRegenAlt() ?? { alternatives: [] };"),

    # --- the empty-text-block rule -------------------------------------------
    ("blocks: an image-only turn gets an empty text block anyway",
     '  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });',
     '  contentBlocks.push({ type: "text", text: body.text });'),
    ("blocks: the text block is never appended",
     '  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });\n',
     ""),
    ("blocks: the text block goes before the ingest blocks",
     "  const contentBlocks = [...blocks];\n"
     '  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });',
     "  const contentBlocks = [];\n"
     '  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });\n'
     "  contentBlocks.push(...blocks);"),
    ("blocks: whitespace-only text counts as empty",
     '  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });',
     '  if (body.text.trim() !== "") contentBlocks.push({ type: "text", text: body.text });'),

    # --- the persisted message ------------------------------------------------
    ("message: content is derived from the blocks rather than the body text",
     "    content: body.text,",
     '    content: contentBlocks.map((b) => (b.type === "text" ? b.text : "")).join(""),'),
    ("message: the turn is persisted as assistant",
     '    role: "user",',
     '    role: "assistant",'),
    ("message: images are dropped from the stored turn",
     "    images,",
     "    images: [],"),

    # --- the broadcast --------------------------------------------------------
    ("emit: the frame carries no origin, so a client cannot tell its own echo",
     '    "user_input",',
     "    undefined as never,"),
    ("emit: the origin says autonomous",
     '    "user_input",',
     '    "autonomous",'),
    ("emit: the revision is read before the append rather than after",
     "  await engine.appendMessage(userMsg);\n",
     "  const revisionBefore = engine.currentRevision();\n"
     "  await engine.appendMessage(userMsg);\n"
     "  engine.currentRevision = () => revisionBefore;\n"),
    ("emit: nothing is broadcast at all",
     "  emitNewMessageEvent(",
     "  if (false) emitNewMessageEvent("),

    # --- the backfill filters -------------------------------------------------
    ("backfill: it runs again after a backfill already happened",
     "  if (!ctx.autonomy.needsActivityBackfill(charName)) return;\n",
     ""),
    ("backfill: the already-backfilled check is inverted",
     "  if (!ctx.autonomy.needsActivityBackfill(charName)) return;",
     "  if (ctx.autonomy.needsActivityBackfill(charName)) return;"),
    ("backfill: the window is 9 days rather than 90",
     "const ACTIVITY_BACKFILL_DAYS = 90;",
     "const ACTIVITY_BACKFILL_DAYS = 9;"),
    ("backfill: the cutoff boundary is exclusive",
     "      if (Number.isNaN(at.getTime()) || at < cutoff) continue;",
     "      if (Number.isNaN(at.getTime()) || at <= cutoff) continue;"),
    ("backfill: there is no cutoff, so a years-old history seeds the tracker",
     "      if (Number.isNaN(at.getTime()) || at < cutoff) continue;",
     "      if (Number.isNaN(at.getTime())) continue;"),
    ("backfill: assistant turns count as user activity",
     '      if (msg.role !== "user" || isToolResultOnly(msg)) continue;',
     "      if (isToolResultOnly(msg)) continue;"),
    ("backfill: tool-result-only turns count as user activity",
     '      if (msg.role !== "user" || isToolResultOnly(msg)) continue;',
     '      if (msg.role !== "user") continue;'),
    ("backfill: archived segments are not read",
     "i >= 0 && barren < SEGMENTS_PAST_THE_WINDOW",
     "false"),
    ("backfill: segments are read before the live window",
     "  collect(engine.messages());\n  const segments = engine.segments();",
     "  const segments = engine.segments();"),

    # --- the token sum --------------------------------------------------------
    ("tokens: cache reads are not counted, so a warm cache never triggers",
     "    BigInt(usage.cache_read_tokens) +\n",
     ""),
    ("tokens: cache writes are not counted",
     "    BigInt(usage.cache_creation_tokens);",
     "    BigInt(0);"),
    ("tokens: only the cache components count",
     "    BigInt(usage.input_tokens) +\n",
     ""),
    ("tokens: the sum wraps instead of saturating",
     "  return Number(sum > ceiling ? ceiling : sum);",
     "  return Number(BigInt.asUintN(64, sum));"),

    # --- stream end -----------------------------------------------------------
    ("streamend: the first message's id is sent instead of the last",
     "  const last = messages[messages.length - 1];",
     "  const last = messages[0];"),
    ("streamend: no message id is ever attached",
     "    ...(last === undefined ? {} : { msgId: last.msg_id }),",
     "    ...{},"),
    ("streamend: the frame is not marked final",
     "    isFinal: true,",
     "    isFinal: false,"),
    ("streamend: the revision is omitted",
     "    revision: engine.currentRevision(),",
     "    ...{},"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/turn.test.ts"], src=TURN)


if __name__ == "__main__":
    sys.exit(main())
