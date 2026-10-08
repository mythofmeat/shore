#!/usr/bin/env python3
"""Mutation pass over workspace turn history: recording each reply's file
changes, undoing them on regenerate and delete, swapping them on a swipe, and
the guard that leaves files changed since a turn alone.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TURNS = ROOT / "src/tools/workspace_turns.ts"
GEN = ROOT / "src/handler/generation.ts"
CONV = ROOT / "src/commands/conversation.ts"
TICK = ROOT / "src/autonomy/heartbeat_tick.ts"

MUTANTS = [
    ("guard: a file changed since the turn is overwritten anyway",
     TURNS,
     "    if (since.has(change.path)) skipped.push(change.path);",
     "    if (false) skipped.push(change.path);"),
    ("undo: replays the turn instead of reversing it",
     TURNS,
     "(record) => [record.after, record.before]",
     "(record) => [record.before, record.after]"),
    ("record: a turn that changed nothing still gets a record",
     TURNS,
     "    if (after === before) return;\n",
     ""),
    ("prune: records still shown as alternatives are dropped",
     TURNS,
     "      if (alt !== undefined) live.add(alt);",
     ""),
    ("move: folders emptied by an undo are left behind",
     TURNS,
     "    await pruneEmptyParents(turns.workspace, path);\n",
     ""),
    ("threads: every thread shares one set of records",
     TURNS,
     "  return `refs/turns/${Buffer.from(thread, \"utf8\").toString(\"hex\")}`;",
     "  return \"refs/turns/all\";"),
    ("alias: an edited reply keeps no record",
     TURNS,
     "    if (record?.before === undefined || record.after === undefined) return;",
     "    return;"),
    ("regen: the old reply's files are still there for the new reply",
     GEN,
     "  if (replaced.length > 0) await undoTurns(workspaceTurns, engine.thread, [...replaced].reverse());\n",
     ""),
    ("regen: a failed regenerate leaves the old reply's files undone",
     GEN,
     "      await redoTurns(workspaceTurns, engine.thread, replaced);\n",
     ""),
    ("turn: the reply's changes are never recorded",
     GEN,
     "      await recordTurn(workspaceTurns, engine.thread, newest, before);\n",
     ""),
    ("turn: a failed turn skips settling the workspace",
     GEN,
     "  } catch (error) {\n    await settleWorkspace();\n    throw error;\n  }",
     "  } catch (error) {\n    throw error;\n  }"),
    ("delete: a turn with later turns after it is undone anyway",
     CONV,
     "  if (!replies.slice(first).every((m) => gone.has(m.msg_id))) {",
     "  if (false) {"),
    ("delete: turns are undone oldest first",
     CONV,
     "await undoTurns(turns, engine.thread, [...versions].reverse())",
     "await undoTurns(turns, engine.thread, versions)"),
    ("alt: swiping an older turn swaps its files too",
     CONV,
     "  if (turns !== undefined && newest) {",
     "  if (turns !== undefined) {"),
    ("edit: the edited reply loses its record",
     CONV,
     "    await aliasTurn(turns, engine.thread, previous, next);\n",
     ""),
    ("heartbeat: a tick's changes are never recorded",
     TICK,
     "    if (sent?.version !== undefined) await recordTurn(workspaceTurns, thread, sent.version, before);\n",
     ""),
]

from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, [
        "tests/workspace_turns.test.ts",
        "tests/workspace_rewind_commands.test.ts",
        "tests/generation.test.ts",
        "tests/autonomy_in_process.test.ts",
    ])


if __name__ == "__main__":
    sys.exit(main())
