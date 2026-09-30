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
    ("a saved message is never recorded as accepted", R,
     '    if (message.type === "request_accepted" && message.rid === info.rid && info.accepted !== true) this.#store(record.owner, { ...info, accepted: true });\n', ''),
    ("acceptance is recorded in memory only, so a restart forgets it", R,
     'this.#store(record.owner, { ...info, accepted: true });', 'this.#records.set(info.id, { owner: record.owner, info: { ...info, accepted: true } });'),
    ("late completions overwrite a terminal outcome", R,
     '    if (message.type === "request_finished") this.#live.delete(key);\n', ''),
    ("the daemon's outcome cannot resolve an uncertain request", R,
     '    if (this.#sessions?.get(record.owner) === undefined) return undefined;', '    if (this.#sessions?.get(record.owner) === undefined || record.info.phase === "uncertain") return undefined;'),
    ("router results never reach history", S,
     '      const settled = this.history.settle(sessionId, message);', '      const settled = undefined as SettledRequest | undefined; void message;'),
    ("an orphaned outcome is never announced", S,
     'if (settled !== undefined && !server.sessionRouter.has(sessionId)) this.#announce(settled);', ''),
    ("an outcome settled between tabs is lost", S,
     '        if (message.type === "history") for (const finished of unannounced.splice(0)) this.#send(socket, finished);\n', ''),
    ("disconnect marks running work uncertain", S,
     '    state.drain?.();\n    state.pending.clear();', '    state.drain?.();\n    for (const pending of state.pending.values()) if (pending.historyId !== undefined) this.history.interrupt(state.auth, pending.historyId);\n    state.pending.clear();'),
    ("outcome storage failure loses the outcome", R,
     '    catch { this.#records.set(info.id, { owner, info: structuredClone(info) }); }', '    catch { void owner; }'),
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
