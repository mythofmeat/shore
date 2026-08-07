#!/usr/bin/env python3
"""Mutation pass over the turn driver (#18 / #12).

Covers `src/handler/turn.ts` — recording the incoming user turn, seeding the
activity tracker, the context-token sum that gates compaction, and the
stream-end frame.

Four things the mutants attack:

- **What counts as a turn.** Which bodies are empty, that a regen appends
  nothing and returns alternatives rather than `undefined`, and that inline
  uploads suppress the legacy path list rather than merging with it.
- **The empty-text-block rule.** An image-only turn must not carry an empty
  text block. This one fails silently and late — the turn persists fine and
  breaks a request days later, when a cache breakpoint lands on it.
- **The backfill filters.** The 90-day cutoff and its boundary, user turns
  only, tool-result-only turns excluded, segments read as well as the live
  window, and an empty selection passed as nothing rather than as an empty
  list.
- **The token sum.** All three components, and that it saturates rather than
  wrapping.

A mutant is KILLED if `bun test tests/turn_parity.test.ts` fails with it
applied.

This is **33/36**, from 30/36 on the first full pass.

The six that lived the first time are the interesting part, and the pattern was
the one #12 warns about every time — the case was present and nothing in it was
load-bearing:

- **Whitespace-only text counting as empty.** No case sent any. The Rust checks
  `is_empty()`, not a trim, so `"   "` *does* get a text block; a case now sends
  it.
- **The revision read before the append.** The mutant was broken, not the
  fixture: it bound an unused const and changed nothing. It now overrides the
  reader, and dies.
- **The first message's id instead of the last.** Both the generator and the
  replay normalised *every* `msg_id` to one sentinel, so the two compared equal.
  Only a minted `m_<uuid v4>` is normalised now; a seeded id is part of the case
  and survives, which is what makes the two distinguishable.

Three survivors remain, and all three are kept in the list, marked, so a later
reader does not "fix" them:

- **The text block before the ingest blocks**, and **content derived from the
  blocks rather than the body text.** Both are equivalent because
  `ingestImages` returns an always-empty block list — it says so in its own
  docstring, and attachments travel in `images`. So the ingest blocks cannot
  order against anything, and the derived content is always exactly `body.text`.
  The structure is kept anyway because it is the Rust's and it states where
  ingest blocks would go if that ever changed.
- **The cutoff boundary being exclusive.** Not reachable through this seam:
  `ensure_and_backfill_autonomy` reads `Local::now()` itself, so its cutoff is
  always milliseconds later than any timestamp the generator can compute. A case
  claiming to sit on the boundary would freeze whichever side of that skew the
  run landed on. The fixture says so too.

Run from the repository root:
    python3 daemon/scripts/mutate_turn.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TURN = "src/handler/turn.ts"

# (label, find, replace)
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
    ("blocks: the text block goes before the ingest blocks (EQUIVALENT)",
     "  const contentBlocks = [...blocks];\n"
     '  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });',
     "  const contentBlocks = [];\n"
     '  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });\n'
     "  contentBlocks.push(...blocks);"),
    ("blocks: whitespace-only text counts as empty",
     '  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });',
     '  if (body.text.trim() !== "") contentBlocks.push({ type: "text", text: body.text });'),

    # --- the persisted message ------------------------------------------------
    ("message: content is derived from the blocks rather than the body text (EQUIVALENT)",
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
    ("backfill: it runs even when the state already existed",
     "  if (!ctx.autonomy.ensureState(charName, config)) return;\n",
     ""),
    ("backfill: it runs only when the state already existed",
     "  if (!ctx.autonomy.ensureState(charName, config)) return;",
     "  if (ctx.autonomy.ensureState(charName, config)) return;"),
    ("backfill: the window is 9 days rather than 90",
     "export const ACTIVITY_BACKFILL_DAYS = 90;",
     "export const ACTIVITY_BACKFILL_DAYS = 9;"),
    ("backfill: the cutoff boundary is exclusive (EQUIVALENT)",
     "      if (!Number.isNaN(at.getTime()) && at >= cutoff) timestamps.push(at);",
     "      if (!Number.isNaN(at.getTime()) && at > cutoff) timestamps.push(at);"),
    ("backfill: there is no cutoff, so a years-old history seeds the tracker",
     "      if (!Number.isNaN(at.getTime()) && at >= cutoff) timestamps.push(at);",
     "      if (!Number.isNaN(at.getTime())) timestamps.push(at);"),
    ("backfill: assistant turns count as user activity",
     '      if (msg.role !== "user" || isToolResultOnly(msg)) continue;',
     "      if (isToolResultOnly(msg)) continue;"),
    ("backfill: tool-result-only turns count as user activity",
     '      if (msg.role !== "user" || isToolResultOnly(msg)) continue;',
     '      if (msg.role !== "user") continue;'),
    ("backfill: archived segments are not read",
     "  for (let i = 0; i < segments.segmentCount(); i += 1) {",
     "  for (let i = 0; i < 0; i += 1) {"),
    ("backfill: an empty selection is passed down as an empty list",
     "  if (timestamps.length > 0) ctx.autonomy.backfillActivity(charName, timestamps);",
     "  ctx.autonomy.backfillActivity(charName, timestamps);"),
    # EQUIVALENT — kept so it is not "fixed" later. See the module docstring.
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


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/turn_parity.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    original = (ROOT / TURN).read_text()
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, find, replace) in enumerate(MUTANTS, 1):
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        (ROOT / TURN).write_text(original.replace(find, replace, 1))
        killed = not run()
        (ROOT / TURN).write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    (ROOT / TURN).write_text(original)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
