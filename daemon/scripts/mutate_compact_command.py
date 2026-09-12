#!/usr/bin/env python3
"""Mutation pass over the `compact` command (#18 / #12).

Three kinds of code, and the mutants are aimed differently at each.

The **argument parse** fails by coercing where the Rust refused: a string that
looks like a number, a `1` that becomes `true`, a negative that becomes a
clamp. Every one of those failures is silent — a rejected argument and an
absent one produce the same pass — so the mutants are all "accept one more
thing than the Rust did".

The **guards** fail by order. Claiming the compaction slot and reading the
conversation are both cheap and both refuse, so swapping them looks like
nothing until two clients compact at once and the second is told its
conversation is empty.

The **renderings** fail by dropping a field, by carrying the wrong one of two
numbers that are usually equal, or by truncating in the wrong unit. The last is
the one this file exists for: `chars().take(200)` counts Unicode scalar values
and `slice(0, 200)` counts UTF-16 code units, and nothing but an astral-plane
character tells them apart.

A mutant is KILLED if `bun test tests/compact_command.test.ts` fails
with it applied.

This is **28/28**, from 28/29 on the first pass. One survivor, and it is the
shape this project has been caught by five times running — the case was there
and nothing in it was load-bearing:

- **The dry run recomputing `would_write_files` from its preview list.** The
  only producer, `CompactionManager::compact`, sets the count *from* the list,
  so every recorded case had them equal and a renderer that recomputed the
  number was indistinguishable from one that copied the field. The fix is in
  the fixture, not the assertion: one generated case sets the count to 99
  against two previews, which makes the renderer's contract — copy what you
  were given — a thing the replay can see.

Worth writing down about the *replay* rather than the code, because two of
these mutants only die because of it: rebuilding the outcome from the recorded
response is how a rendering fixture feeds a mutant its own answer back.
`outcomeFor` names every field explicitly rather than spreading the response,
and `expand()` lengthens a preview that came back at the truncation boundary,
because a preview handed back verbatim passes under any truncation length at
all — including none.

Run from the repository root:
    python3 daemon/scripts/mutate_compact_command.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
C = "src/commands/compact.ts"
R = "src/memory/compaction/run.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the argument parse ---------------------------------------------------
    ('parse: dry_run is truthiness rather than a boolean', 'src/operations/contracts.ts',
     '  const value: unknown = input ?? {};',
     '  const value: unknown = name === "compact" && typeof input === "object" && input !== null && "dry_run" in input ? { ...input, dry_run: Boolean(input.dry_run) } : input ?? {};'),
    ('parse: dry_run defaults to true', 'src/commands/compact.ts',
     '    dryRun: args.dry_run ?? false,',
     '    dryRun: args.dry_run ?? true,'),
    ('parse: keep_turns accepts a numeric string', 'src/operations/contracts.ts',
     '  const value: unknown = input ?? {};',
     '  const value: unknown = name === "compact" && typeof input === "object" && input !== null && "keep_turns" in input ? { ...input, keep_turns: Number(input.keep_turns) } : input ?? {};'),
    ('parse: keep_turns accepts a fraction', 'src/operations/contracts.ts',
     '  const value: unknown = input ?? {};',
     '  const value: unknown = name === "compact" && typeof input === "object" && input !== null && "keep_turns" in input ? { ...input, keep_turns: typeof input.keep_turns === "number" ? Math.floor(input.keep_turns) : input.keep_turns } : input ?? {};'),
    ('parse: a negative keep_turns is clamped rather than rejected', 'src/operations/contracts.ts',
     '  const value: unknown = input ?? {};',
     '  const value: unknown = name === "compact" && typeof input === "object" && input !== null && "keep_turns" in input ? { ...input, keep_turns: typeof input.keep_turns === "number" ? Math.max(0, input.keep_turns) : input.keep_turns } : input ?? {};'),
    ('parse: keep_turns 0 is treated as absent', 'src/commands/compact.ts',
     '    keepTurnsOverride: args.keep_turns ?? undefined,',
     '    keepTurnsOverride: args.keep_turns || undefined,'),

    # --- the guards -----------------------------------------------------------
    ("guards: the conversation is read before the slot is claimed",
     R,
     '\n    const guard = tryBeginCompaction(dataDir, character);\n    if (guard === undefined) throw CompactionError.busy(character);\n\n    let coverage: CompactionCoverage | undefined;\n    try {\n      const loaded = await loadMessagesForCompaction(dataDir, character, thread);\n      if (loaded.messages.length === 0) return undefined;',
     '  const preloaded = await loadMessagesForCompaction(dataDir, character, thread);\n    if (preloaded.messages.length === 0) return undefined;\n    const guard = tryBeginCompaction(dataDir, character);\n    if (guard === undefined) throw CompactionError.busy(character);\n\n    let coverage: CompactionCoverage | undefined;\n    try {\n      const loaded = preloaded;'),
    ("guards: the busy refusal is an internal error again",
     C,
     '    if (e.kind === "busy") return new CommandError("busy", e.message);',
     '    if (e.kind === "busy") return internalError(e.message);'),
    ("guards: an empty conversation is a success rather than a refusal",
     C,
     '  if (outcome === undefined) throw invalidRequest("No messages to compact");',
     '  if (outcome === undefined) return { status: "nothing_to_compact" };'),
    ("guards: an empty conversation is an internal error",
     C,
     '  if (outcome === undefined) throw invalidRequest("No messages to compact");',
     '  if (outcome === undefined) throw internalError("No messages to compact");'),
    ("guards: the slot is never given back",
     R,
     '        guard.release();',
     '        void guard;'),

    ("prefix: the rebuilt prefix ignores the thread's pinned model",
     R,
     "    await threadChatModel(effective.dirs.data, character, thread),\n",
     ""),
    ("prefix: the pin is read for home rather than the thread being compacted",
     R,
     "    await threadChatModel(effective.dirs.data, character, thread),",
     "    await threadChatModel(effective.dirs.data, character),"),

    ("thread: shore compact always compacts home, whatever thread you are in",
     C,
     "        ...(engine.thread === undefined ? {} : { thread: engine.thread }),\n",
     ""),

    # --- the error mapping ----------------------------------------------------
    ("errors: insufficient messages is an internal error",
     C,
     '    if (e.kind === "insufficient_messages") return invalidRequest(e.message);',
     '    if (e.kind === "insufficient_messages") return internalError(e.message);'),
    ("errors: every compaction failure is the caller's fault",
     C,
     "    return internalError(e.message);\n  }\n  return internalError(e instanceof Error ? e.message : String(e));",
     "    return invalidRequest(e.message);\n  }\n  return internalError(e instanceof Error ? e.message : String(e));"),
    ("errors: a failure from under the assembly loses its message",
     C,
     "  return internalError(e instanceof Error ? e.message : String(e));",
     '  return internalError("compaction failed");'),
    ("errors: the llm prefix is dropped",
     "src/memory/compaction/types.ts",
     '    return new CompactionError("llm", `llm: ${detail}`, { cause });',
     '    return new CompactionError("llm", detail, { cause });'),
    ("errors: the busy message picks up a prefix",
     "src/memory/compaction/types.ts",
     '    return new CompactionError("busy", `Compaction already running for ${character}`);',
     '    return new CompactionError("busy", `conversation: Compaction already running for ${character}`);'),

    # --- the renderings -------------------------------------------------------
    ("renderings: turn_count carries the retained turns",
     C,
     "      message_count: outcome.messageCount,\n      turn_count: outcome.compactedTurns,\n      compacted_turns: outcome.compactedTurns,\n      retained_count: outcome.retainedCount,\n      retained_turns: outcome.retainedTurns,\n      new_conversation_id: outcome.newConversationId,",
     "      message_count: outcome.messageCount,\n      turn_count: outcome.retainedTurns,\n      compacted_turns: outcome.compactedTurns,\n      retained_count: outcome.retainedCount,\n      retained_turns: outcome.retainedTurns,\n      new_conversation_id: outcome.newConversationId,"),
    ("renderings: the compatibility duplicate is dropped",
     C,
     "      turn_count: outcome.compactedTurns,\n      compacted_turns: outcome.compactedTurns,\n      retained_count: outcome.retainedCount,\n      retained_turns: outcome.retainedTurns,\n      new_conversation_id: outcome.newConversationId,",
     "      compacted_turns: outcome.compactedTurns,\n      retained_count: outcome.retainedCount,\n      retained_turns: outcome.retainedTurns,\n      new_conversation_id: outcome.newConversationId,"),
    ("renderings: the dry run reports the preview length rather than the count",
     C,
     "    would_write_files: outcome.wouldWriteFiles,",
     "    would_write_files: outcome.fileOpsPreview.length,"),
    ("preview: truncation counts UTF-16 code units",
     C,
     '    content_preview: Array.from(op.content).slice(0, PREVIEW_CHARS).join(""),',
     "    content_preview: op.content.slice(0, PREVIEW_CHARS),"),
    ("preview: truncation counts bytes",
     C,
     '    content_preview: Array.from(op.content).slice(0, PREVIEW_CHARS).join(""),',
     '    content_preview: new TextDecoder().decode(new TextEncoder().encode(op.content).slice(0, PREVIEW_CHARS)),'),
    ("preview: the boundary is off by one",
     C,
     "const PREVIEW_CHARS = 200;",
     "const PREVIEW_CHARS = 201;"),
    ("preview: the content is not truncated at all",
     C,
     '    content_preview: Array.from(op.content).slice(0, PREVIEW_CHARS).join(""),',
     "    content_preview: op.content,"),

    # --- the completion -------------------------------------------------------
    ("completion: the deferred edits are applied before the reload",
     C,
     "  try {\n    await engine.reload();\n  } catch (e) {\n    throw internalError(e instanceof Error ? e.message : String(e));\n  }\n\n  try {\n    await applyDeferredEdits(",
     "  try {\n    await applyDeferredEdits(join(ctx.config.dirs.data, character), ctx.config.dirs.config, character);\n  } catch {\n    // swapped\n  }\n  try {\n    await engine.reload();\n  } catch (e) {\n    throw internalError(e instanceof Error ? e.message : String(e));\n  }\n\n  try {\n    await applyDeferredEdits("),
    ("completion: a failed reload is a warning rather than a refusal",
     C,
     "  try {\n    await engine.reload();\n  } catch (e) {\n    throw internalError(e instanceof Error ? e.message : String(e));\n  }",
     "  try {\n    await engine.reload();\n  } catch (e) {\n    shoreLog.warn(String(e));\n  }"),
    ("completion: autonomy is told the compacted turns",
     C,
     "    );\n    await completeCompaction(engine, ctx, character, outcome.retainedTurns);",
     "    );\n    await completeCompaction(engine, ctx, character, outcome.compactedTurns);"),
    ("completion: a rotation tells autonomy the compacted turns",
     C,
     "      await completeCompaction(engine, ctx, character, outcome.retainedTurns);",
     "      await completeCompaction(engine, ctx, character, outcome.compactedTurns);"),
    ("completion: a rotation dry run completes the compaction anyway",
     C,
     "    if (!outcome.dryRun) {\n      await completeCompaction(",
     "    if (true) {\n      await completeCompaction("),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/compact_command.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
