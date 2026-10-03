#!/usr/bin/env python3
"""Exercise shared control routing, resumable compaction cancellation, and resuming a pass the user asks for."""
import sys
from mutation import run

H = "src/handler/router.ts"
R = "src/memory/compaction/run.ts"
M = "src/memory/compaction/manager.ts"
MUTANTS = [
    ("cancel bypasses active commands", H,
     '      (command) => command.sessionId === sessionId ||', '      (command) => false ||'),
    ("queued mutations are not registered for cancellation", H,
     'routed.kind === "command" ? this.#registerCommand(routed.cmd, routed.meta) : undefined', 'undefined'),
    ("an aborted command starts anyway", H,
     'controller.signal.throwIfAborted();', ''),
    ("confirmed command results are discarded after cancellation", H,
     'const result = await this.#deps.dispatchCommand(cmd, meta, controller.signal);', 'const result = await this.#deps.dispatchCommand(cmd, meta, controller.signal); if (controller.signal.aborted) return;'),
    ("a returned outcome is falsely marked cancelled", H,
     'await this.#finishRequest(meta, meta.rid, outcome, failure);', 'await this.#finishRequest(meta, meta.rid, controller.signal.aborted ? "cancelled" : outcome, failure);'),
    ("compaction loses its request signal", "src/commands/registry.ts",
     '...(context.session.signal === undefined ? {} : { signal: context.session.signal }), ...', '...'),
    ("compaction provider calls lose cancellation", "src/autonomy/in_process.ts",
     ', ...(signal === undefined ? {} : { signal })', ''),
    ("compaction tools lose cancellation", R,
     'if (deps.signal !== undefined) toolCtx.signal = deps.signal;', ''),
    ("compaction cannot guard its archive boundary", R,
     '        ...(deps.signal === undefined ? {} : { signal: deps.signal }),\n      },', '      },'),
    ("completed model work archives despite cancellation", M,
     '      opts.emit,\n    );\n    opts.signal?.throwIfAborted();', '      opts.emit,\n    );'),
    ("late cancellation still archives active history", M,
     'if (opts.signal?.aborted === true) return await pauseCompaction(opts, checkpoint, opts.signal.reason);', ''),
    ("cancelled tools start another provider call", "src/llm/providers/generic_loop.ts",
     'this.abort.signal.throwIfAborted();', ''),
    ("compact is not the user's own pass", "src/commands/compact.ts",
     '          trigger: "manual",\n', '          trigger: "idle",\n'),
    ("compact's model calls are labelled background", "src/handler/deps.ts",
     '        }, { foreground: true }),', '        }),'),
    ("a pass forgets it was asked for", R,
     '        foreground: options.trigger === "manual",\n', ''),
    ("a pass the user asked for replays a stored pause", M,
     '  if (opts.foreground !== true && checkpoint.state === "paused"', '  if (checkpoint.state === "paused"'),
    ("a pause forgets what stopped it", M,
     '    : stop?.summary ?? stop?.message ?? (error instanceof Error ? error.message : String(error));', '    : undefined;'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/router.test.ts", "tests/generic_loop.test.ts", "tests/compaction_resume.test.ts", "tests/daemon_run.test.ts"], timeout=90))
