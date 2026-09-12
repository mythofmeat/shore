#!/usr/bin/env python3
"""Exercise Rust/browser revision parity, lifecycle completion and recovery."""
import sys
from mutation import run

CONNECTION = "src/browser/connection.ts"
SYNC = "src/browser/sync.ts"
ROUTER = "src/handler/router.ts"
WIRE = "src/browser/wire.ts"

MUTANTS = [
    ("background generations never report their outcome", ROUTER,
     'await this.#finishRequest(meta, rid, generation.outcome ?? (failure === undefined ? "completed" : "failed"), failure);',
     'void failure;'),
    ("superseded requests report successful completion", ROUTER,
     'previous.outcome = "superseded";', 'void previous;'),
    ("an interrupted mutation has no uncertain-state notification", CONNECTION,
     'this.#emit({ kind: "uncertain", rid, request: pending.request, selection: pending.selection });',
     'void pending;'),
    ("reconnect replays potentially completed mutations", CONNECTION,
     'this.#pendingBytes = 0;\n    for (const [rid, pending] of interrupted)',
     'this.#pendingBytes = 0;\n    const stopReplay = this.subscribe((update) => { if (update.kind === "status" && update.status === "ready") { stopReplay(); for (const [, pending] of interrupted) this.submit(pending.request); } });\n    for (const [rid, pending] of interrupted)'),
    ("stale browser contracts reach the session", CONNECTION,
     'body.contract !== this.#options.contract || body.protocol !== this.#options.protocol', 'false'),
    ("a confirmed request remains pending", CONNECTION,
     'this.#pending.delete(message.rid);', 'void message.rid;'),
    ("a snapshot hides its paired message notification", SYNC,
     'state.snapshotRevision = message.revision;\n        return "deliver";',
     'state.snapshotRevision = message.revision;\n        state.messageRevision = message.revision;\n        return "deliver";'),
    ("a delta gap is applied as continuous history", SYNC,
     'if (message.delta.base_revision !== state.snapshotRevision) return "resync";', 'void message.delta;'),
    ("malformed known events pass browser validation", WIRE,
     'if (!validServerMessage(value)) return', 'if (false) return'),
    ("future events are treated as invalid current frames", WIRE,
     'if (!knownTypes.has(value.type)) return { kind: "future", message: value as Record<string, unknown> & { type: string } };',
     'void knownTypes;'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_sync.test.ts", "tests/browser_wire.test.ts", "tests/router.test.ts", "tests/web_transport.test.ts"]))
