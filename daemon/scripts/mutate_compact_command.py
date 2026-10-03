#!/usr/bin/env python3
"""Mutation pass over the `compact` command: argument parsing, its guards, the
thread and prefix it compacts, its errors and renderings, the preview, and
completion.
"""
import sys

C = "src/commands/compact.ts"
R = "src/memory/compaction/run.ts"

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
     '\n    const guard = tryBeginCompaction(dataDir, character);\n    if (guard === undefined) throw CompactionError.busy(character);\n',
     '\n    const preloaded = await loadMessagesForCompaction(dataDir, character, thread);\n    if (preloaded.messages.length === 0) return undefined;\n    const guard = tryBeginCompaction(dataDir, character);\n    if (guard === undefined) throw CompactionError.busy(character);\n'),
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
     '      guard.release();',
     '      void guard;'),

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
     "        message_count: outcome.messageCount,\n        turn_count: outcome.compactedTurns,\n        compacted_turns: outcome.compactedTurns,\n        retained_count: outcome.retainedCount,\n        retained_turns: outcome.retainedTurns,\n        new_conversation_id: outcome.newConversationId,",
     "        message_count: outcome.messageCount,\n        turn_count: outcome.retainedTurns,\n        compacted_turns: outcome.compactedTurns,\n        retained_count: outcome.retainedCount,\n        retained_turns: outcome.retainedTurns,\n        new_conversation_id: outcome.newConversationId,"),
    ("renderings: the compatibility duplicate is dropped",
     C,
     "        turn_count: outcome.compactedTurns,\n        compacted_turns: outcome.compactedTurns,\n        retained_count: outcome.retainedCount,\n        retained_turns: outcome.retainedTurns,\n        new_conversation_id: outcome.newConversationId,",
     "        compacted_turns: outcome.compactedTurns,\n        retained_count: outcome.retainedCount,\n        retained_turns: outcome.retainedTurns,\n        new_conversation_id: outcome.newConversationId,"),
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


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/compact_command.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
