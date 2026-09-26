#!/usr/bin/env python3
"""Exercise ordinary mutation recovery, ownership and dispatch ordering."""
import sys
from mutation import run

R = "src/web/requests.ts"
S = "src/web/socket.ts"
MUTANTS = [
    ("mutation admission skips durable storage", R,
     'this.recovery?.saveRequest(owner, info);', ''),
    ("restart claims unfinished requests completed", R,
     '{ ...saved.info, phase: "uncertain" as const }', '{ ...saved.info, phase: "completed" as const }'),
    ("history discloses another sign-in's outcomes", R,
     '.filter((row) => row.owner === session.id).map((row)', '.filter(() => true).map((row)'),
    ("another sign-in can acknowledge outcomes", R,
     'if (record?.owner !== session.id) throw', 'if (record === undefined) throw'),
    ("running requests can be dismissed", R,
     'if (record.info.phase === "running") throw', 'if (false) throw'),
    ("retained request IDs are reusable", R,
     'if (owned.some((row) => row.info.rid === message.rid)) throw', 'if (false) throw'),
    ("capacity evicts uncertain outcomes", R,
     'row.info.phase !== "running" && row.info.phase !== "uncertain"', 'row.info.phase !== "running"'),
    ("oversized command results are retained", R,
     'Buffer.byteLength(JSON.stringify(result)) > REQUEST_HISTORY_LIMITS.resultBytes', 'false'),
    ("invalid result contracts are retained", R,
     ' || !validWebRequestInfo(candidate)', ''),
    ("late completions overwrite uncertainty", R,
     'record.info.expires_at <= Date.now() || record.info.phase !== "running"', 'record.info.expires_at <= Date.now()'),
    ("socket results never reach history", S,
     'if (id !== undefined) this.history.observe(state.auth, id, message);', ''),
    ("disconnect leaves pending work running", S,
     'if (pending.historyId !== undefined) this.history.interrupt(state.auth, pending.historyId);', ''),
    ("request records use the initial selection snapshot", S,
     'this.history.begin(state.auth, sessionMetaOf(selected), message)', 'this.history.begin(state.auth, state.peer.session, message)'),
    ("failed admission still dispatches", S,
     '        return;\n      }\n      state.pending.set(rid,', '      }\n      state.pending.set(rid,'),
    ("logout leaves durable request outcomes", "src/web/recovery.ts",
     'CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, info TEXT NOT NULL)',
     'CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, owner TEXT NOT NULL, info TEXT NOT NULL)'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/web_requests.test.ts", "tests/web_transport.test.ts"]))
