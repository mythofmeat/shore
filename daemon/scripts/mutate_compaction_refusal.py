#!/usr/bin/env python3
"""Mutation pass over what compaction does when the model refuses, when the
chat turn it runs after is cancelled, when its archive step fails, and when it
writes memory from an archived segment.
"""
import sys

M = "src/memory/compaction/manager.ts"
R = "src/memory/compaction/run.ts"
C = "src/commands/compact.ts"
T = "src/handler/turn.ts"
I = "src/autonomy/idle_compaction.ts"

TESTS = [
    "tests/compaction_refusal.test.ts",
    "tests/compaction_resume.test.ts",
    "tests/compact_command.test.ts",
    "tests/turn.test.ts",
]

MUTANTS = [
    # --- a refusal ------------------------------------------------------------
    ("refusal: the refused turn is kept as the pass's last word", M,
     "      this.refused = true;\n      return;\n",
     "      this.refused = true;\n"),
    ("refusal: a refused final turn counts as a finished pass", M,
     "  if (driver.refused || response.finish_reason === REFUSAL) throw refusedIn(driver.state);\n",
     ""),
    ("refusal: a refusal the provider then reports as an error is a provider failure", M,
     "    if (driver.refused) throw refusedIn(driver.state, e);\n",
     ""),
    ("refusal: the pause is recorded as a provider failure", M,
     "  const refused = !cancelled && error instanceof CompactionRefused;",
     "  const refused = false;"),
    ("refusal: an old checkpoint's refused turn still ends the pass", M,
     "  if (driver.state.pendingTurn?.finish_reason === REFUSAL) forgetRefusedTurn(request, driver.state);\n",
     ""),
    ("refusal: the refused text stays in the request a retry sends", M,
     "    request.messages.pop();\n",
     ""),

    # --- the hold -------------------------------------------------------------
    ("hold: automatic passes resume a refused one", R,
     '    if (trigger !== "manual") {\n      const held',
     '    if (false as boolean) {\n      const held'),
    ("hold: shore compact cannot retry a refused pass", R,
     '    if (trigger !== "manual") {\n      const held',
     '    if (true as boolean) {\n      const held'),
    ("hold: every held attempt notifies again", R,
     "    if (outcome.held !== true) deps.notify?.(",
     "    deps.notify?.("),
    ("hold: the idle timer runs the held pass", I,
     "    if (await compactionHeld(deps.config.dirs.data, character, selected)) {",
     "    if (false as boolean) {"),
    ("hold: every chat turn asks for a pass while one is held", T,
     "  if (await compactionHeld(dataDir, charName, engine.thread ?? await homeThreadOf(dataDir, charName))) return false;\n",
     ""),

    # --- the chat turn and the archive -----------------------------------------
    ("cancel: the pass ignores the chat turn it runs after", R,
     "deps.emit, stoppedWith(deps.signal, scope));",
     "deps.emit, deps.signal);"),
    ("archive: a failed archive keeps a checkpoint whose writes were rolled back", M,
     "  } catch (e) {\n    await clearCheckpoint(opts);\n    throw e;\n  }",
     "  } catch (e) {\n    throw e;\n  }"),

    # --- an archived segment ----------------------------------------------------
    ("segment: the pass is not told the conversation is an old one", M,
     "    segmentNotice(opts.segment, opts.messages);",
     '    "";'),
    ("segment: the pass reads the active conversation instead", R,
     "  const chatRequest = await resolveChatRequest(character, thread, archived.messages, effective,",
     "  const chatRequest = await resolveChatRequest(character, thread, (await loadMessagesForCompaction(deps.config.dirs.data, character, thread)).store.messages(), effective,"),
    ("segment: an unknown segment is an internal error", C,
     '    if (e.kind === "not_found") return notFound(e.message);\n',
     ""),
    ("segment: other options are silently ignored", C,
     "  if (mixed) throw invalidRequest(",
     "  if (false as boolean) throw invalidRequest("),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS, timeout=180)


if __name__ == "__main__":
    sys.exit(main())
