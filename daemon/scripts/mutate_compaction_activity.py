#!/usr/bin/env python3
"""Mutation pass over live compaction activity: the running pass's frames and progress, watching and stopping it, and how it shows in status."""
import sys

A = "src/memory/compaction/activity.ts"
C = "src/commands/compact.ts"
S = "src/commands/status.ts"
M = "src/memory/compaction/manager.ts"
R = "src/memory/compaction/run.ts"

TESTS = [
    "tests/compaction_activity.test.ts",
    "tests/autonomy_in_process.test.ts",
    "tests/daemon_run.test.ts",
]

MUTANTS = [
    # --- the running pass -----------------------------------------------------
    ("frames: a late watcher misses what the pass already did", A,
     "  for (const frame of pass.frames) sink(frame);",
     ""),
    ("frames: a watcher sees the catch-up and nothing after it", A,
     "  for (const watcher of pass.watchers) watcher(frame);",
     ""),
    ("frames: whoever started the pass stops seeing it", A,
     "      upstream?.(frame);",
     ""),
    ("frames: thinking and text merge into one chunk", A,
     "    previous.content_type === frame.content_type && previous.subagent === frame.subagent",
     "    previous.subagent === frame.subagent"),
    ("frames: another source's chunk merges into the pass's", A,
     "previous.content_type === frame.content_type && previous.subagent === frame.subagent && ",
     "previous.content_type === frame.content_type && "),
    ("progress: the round is never recorded", A,
     '  if (frame.type === "phase") pass.phase = frame.phase;',
     ""),
    ("progress: the last tool is never recorded", A,
     '  if (frame.type === "tool_call") pass.lastTool = frame.tool_name;',
     ""),
    ("signal: the starter's own cancellation no longer stops the pass", A,
     "    signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),",
     "    signal: controller.signal,"),
    # --- how it ends ----------------------------------------------------------
    ("end: a second end overwrites the first", A,
     "    if (closed) return;",
     ""),
    ("end: a pass that ends late clears the next pass's slot", A,
     "    if (running.get(key) === pass) running.delete(key);",
     "    running.delete(key);"),
    ("end: a pass with nothing to do replaces the last real outcome", A,
     '    if (end.kind === "failed" || end.outcome !== undefined) lastEnded.set(key, record);',
     "    lastEnded.set(key, record);"),
    ("end: a failed pass is forgotten", A,
     '    if (end.kind === "failed" || end.outcome !== undefined) lastEnded.set(key, record);',
     '    if (end.kind !== "failed" && end.outcome !== undefined) lastEnded.set(key, record);'),
    ("cancel: the pass is never aborted", A,
     '  pass.controller.abort(new DOMException(reason, "AbortError"));',
     ""),
    ("cancel: answers before the pass has ended", A,
     "  return await pass.ended;",
     "  return undefined;"),
    ("cancel: a stopped pass forgets why it stopped", M,
     "    ? describeAbort(opts.signal?.reason)",
     "    ? undefined"),
    ("cancel: a stopped pass is reported as a provider failure", M,
     '  checkpoint.pauseReason = cancelled ? "cancelled" : stop === undefined ? "provider" : "budget";',
     '  checkpoint.pauseReason = stop === undefined ? "provider" : "budget";'),
    ("watch: a watcher that leaves keeps receiving frames", A,
     "    pass.watchers.delete(sink);",
     ""),
    ("watch: a watcher that leaves is held until the pass ends", A,
     "    return await untilAborted(pass.ended, signal);",
     "    return await pass.ended;"),
    ("trigger: every pass is recorded as started by hand", R,
     '    const trigger = options.trigger ?? "manual";',
     '    const trigger = "manual";'),
    # --- the commands ---------------------------------------------------------
    ("compact: a second compact starts its own pass instead of following the running one", C,
     "  if (live !== undefined) {",
     "  if (false) {"),
    ("compact: arguments for a new pass are dropped to follow the running one", C,
     "    if (dryRun || restart || keepTurnsOverride !== undefined) {",
     "    if (false) {"),
    ("watch: a pass watched to its end reads as idle", C,
     '    : { character, state: "finished", pass: passEnd(ended) };',
     '    : { character, state: "idle", pass: passEnd(ended) };'),
    ("cancel: a stopped pass reads as idle", C,
     '    : { character, state: "cancelled", pass: passEnd(ended) };',
     '    : { character, state: "idle", pass: passEnd(ended) };'),
    ("report: a pass's report is dropped", C,
     "    report: end.kind === \"outcome\" && end.outcome !== undefined ? compactionReport(ended.character, end.outcome) : null,",
     "    report: null,"),
    ("report: a failed pass loses its error", C,
     '    error: end.kind === "failed" ? end.error : null,',
     "    error: null,"),
    # --- status ---------------------------------------------------------------
    ("status: a running pass is not shown", S,
     "  const live = runningPass(dataDir, character);",
     "  const live = undefined;"),
    ("status: a paused checkpoint is not shown", S,
     '    paused: live !== undefined || checkpoint?.state !== "paused" ? null : {',
     "    paused: true ? null : {"),
    ("status: the last pass is not shown", S,
     "    last: passEnd(lastPass(dataDir, character)),",
     "    last: null,"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS, timeout=120)


if __name__ == "__main__":
    sys.exit(main())
