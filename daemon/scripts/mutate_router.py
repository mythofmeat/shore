#!/usr/bin/env python3
"""Mutation pass over `handler/router.ts`: what a routed message causes, who
receives a generation's stream, and what a cancel does.
"""
import sys

ROUTER = "src/handler/router.ts"

MUTANTS = [
    # ── acceptance ──────────────────────────────────────────────────────
    ("acceptance only reaches a session still viewing the thread",
     "    const send = this.#lifecycle(meta) ? this.#deps.router.senderFor(meta.session.sessionId) : undefined;",
     "    const send = this.#lifecycle(meta) && this.#deps.router.threadFor(meta.session.sessionId) === meta.session.selectedThread ? this.#deps.router.senderFor(meta.session.sessionId) : undefined;"),
    ("acceptance is sent to clients that never asked for the request lifecycle",
     "    const send = this.#lifecycle(meta) ? this.#deps.router.senderFor(meta.session.sessionId) : undefined;",
     "    const send = this.#deps.router.senderFor(meta.session.sessionId);"),
    ("acceptance is never reported to request history",
     "    this.#deps.router.reportRequest(meta.session.sessionId, accepted);\n",
     ""),
    ("the generation is never told how to confirm acceptance",
     "      accepted: () => this.#acceptRequest(meta, rid),\n",
     ""),

    # ── the launch decision ─────────────────────────────────────────────
    ("an unresolvable character launches anyway",
     '    if ("error" in resolved) {',
     "    if (false as boolean) {\n      const resolved = { name: \"\" };"),
    ("a regen is dropped instead of launched",
     '    if (msg.type === "hello" || msg.type === "command") return;',
     '    if (msg.type === "hello" || msg.type === "command" || msg.type === "regen") return;'),
    ("a hello or command is treated as a message",
     '    if (msg.type === "hello" || msg.type === "command") return;',
     "    if (false) return;"),
    ("a cancel falls through into generation",
     '    if (plan.kind === "cancel") {\n'
     "      await this.#cancel(meta.session.sessionId, meta.rid);\n"
     "      return;\n"
     "    }",
     '    if (plan.kind === "cancel") {\n'
     "      await this.#cancel(meta.session.sessionId, meta.rid);\n"
     "    }"),
    ("a request from a vanished session launches nothing",
     "    const issuer = meta.session.sessionId;\n",
     "    const issuer = meta.session.sessionId;\n    if (!this.#deps.router.has(issuer)) return;\n"),

    # ── the regen body ──────────────────────────────────────────────────
    ("a regen carries the frame's text through", "src/operations/requests.ts",
     'rid: request.rid ?? null, text: "", stream: request.stream,',
     'rid: request.rid ?? null, text: (request as { text?: string }).text ?? "x", stream: request.stream,'),
    ("a regen forces streaming on", "src/operations/requests.ts",
     'text: "", stream: request.stream,', 'text: "", stream: true,'),
    ("a regen drops its rid", "src/operations/requests.ts",
     'rid: request.rid ?? null, text: "",', 'rid: null, text: "",'),

    # ── who sees a turn, and what a disconnect does ────────────────────
    ("the stream goes to the issuer alone, not every viewer",
     "          if (sessionId !== issuer) {\n            void this.#deliver(target, msg, sessionId);\n            continue;\n          }",
     "          if (sessionId !== issuer) continue;"),
    ("a viewer that switched away keeps receiving the turn",
     "          if (target === undefined || current.character !== viewer.character || current.thread !== viewer.thread) {",
     "          if (target === undefined) {"),
    ("a non-streaming issuer is sent the partial stream",
     '          if (!body.stream && (msg.type === "stream_chunk" || (msg.type === "stream_start" && !msg.regen))) continue;',
     "          void body;"),
    ("a non-streaming regenerate never tells its issuer what it replaces",
     '(msg.type === "stream_start" && !msg.regen)',
     'msg.type === "stream_start"'),
    ("a joining session is not replayed the turn so far",
     "    for (const frame of generation.replay) void this.#deliver(send, frame, sessionId);",
     "    void send;"),
    ("a connecting session never joins a running turn",
     "      this.#join(routed.sessionId);\n      return;",
     "      return;"),
    ("switching into a running conversation does not join its turn",
     "      if (this.#deps.router.has(sessionId) && this.#sessionScope(sessionId) !== before) this.#join(sessionId);\n",
     ""),
    ("every command rejoins, replaying the turn twice",
     " && this.#sessionScope(sessionId) !== before) this.#join(sessionId);",
     ") this.#join(sessionId);"),
    ("a replay is sent after the turn has finished",
     "    if (generation === undefined || generation.finished) return;",
     "    if (generation === undefined) return;"),
    ("replayed chunks are not coalesced",
     '  if (msg.type === "stream_chunk" && last?.type === "stream_chunk" && last.content_type === msg.content_type) {',
     "  if (false as boolean) {"),
    ("thinking and text are coalesced into one chunk",
     ' && last.content_type === msg.content_type) {',
     ") {"),
    ("sub-agent frames are replayed into the main turn",
     '  if ("subagent" in msg && msg.subagent !== undefined && msg.subagent !== null) return;\n',
     ""),
    ("a disconnect cancels every generation the session was viewing",
     "    for (const generation of this.#generations.values()) generation.viewers.delete(routed.sessionId);\n    this.#queues.delete(routed.sessionId);",
     "    for (const generation of this.#generations.values()) if (generation.viewers.has(routed.sessionId)) generation.abort();\n    this.#queues.delete(routed.sessionId);"),
    ("a disconnect aborts state-changing commands too",
     "      (command) => command.sessionId === routed.sessionId && !command.changesState,",
     "      (command) => command.sessionId === routed.sessionId,"),
    ("a disconnect leaves read-only commands running",
     "      (command) => command.sessionId === routed.sessionId && !command.changesState,",
     "      () => false,"),
    ("a cancel cannot reach an orphaned command",
     "        (command.changesState && command.scope === scope && !this.#deps.router.has(command.sessionId)),",
     "        false,"),
    ("a cancel reaches another live client's command",
     " && !this.#deps.router.has(command.sessionId)),",
     "),"),
    ("request outcomes are not reported to observers",
     "    this.#deps.router.reportRequest(meta.session.sessionId, finished);\n",
     ""),

    # ── the cancel frame ────────────────────────────────────────────────
    ("a cancel with nothing running still sends a frame",
     '    if (generation === undefined) return;',
     '    if (generation === undefined) {\n      await this.#deps.router.sendToSession(sessionId, cancelledStreamEnd(rid));\n      return;\n    }'),
    ("a cancel sends no frame at all",
     "      await generation.send(frame);\n      if (!generation.viewers.has(sessionId)) await this.#deps.router.sendToSession(sessionId, frame);",
     "      void frame;"),
    ("a cancel does not abort what it announces",
     '    generation.outcome = "cancelled";\n    generation.abort();',
     '    generation.outcome = "cancelled";'),
    ("a finished generation clears a later launch's abort handle",
     '        if (this.#generations.get(scope) === generation) this.#generations.delete(scope);',
     '        this.#generations.delete(scope);'),
    ("a completed generation retains its state",
     '        if (this.#generations.get(scope) === generation) this.#generations.delete(scope);',
     '        void scope;'),
    ("a cancelled generation retains its state",
     '    this.#deps.log?.info?.("cancelling active generation", { reason });\n    this.#generations.delete(scope);',
     '    this.#deps.log?.info?.("cancelling active generation", { reason });'),
    ("the generation is never told it was cancelled",
     "      signal: controller.signal,",
     "      signal: new AbortController().signal,"),
    ("the cancel frame is not marked final",
     "      finish_reason: \"cancelled\",\n      is_final: true,",
     "      finish_reason: \"cancelled\",\n      is_final: false,"),
    ("the cancel frame reports end_turn",
     '      finish_reason: "cancelled",',
     '      finish_reason: "end_turn",'),
    ("the cancel frame carries no rid",
     "    rid,\n  );\n}",
     "    null,\n  );\n}"),

    # ── superseding ─────────────────────────────────────────────────────
    ("a second request does not abort the first",
     "      previous.abort();",
     "      void previous;"),
    ("superseding leaves the original request without a terminal result",
     '      if (previous.rid !== null) await previous.send(cancelledStreamEnd(previous.rid));',
     '      void previous.rid;'),

    # ── the rid filter ──────────────────────────────────────────────────
    ("the rid filter accepts anything",
     "src/swp/admission.ts",
     "    if (code > 0x7f || code === 0) return null;",
     "    if (false) return null;"),
    ("the rid filter stops rejecting NUL",
     "src/swp/admission.ts",
     "    if (code > 0x7f || code === 0) return null;",
     "    if (code > 0x7f) return null;"),
    ("the rid filter stops rejecting non-ascii",
     "src/swp/admission.ts",
     "    if (code > 0x7f || code === 0) return null;",
     "    if (code > 0x10ffff || code === 0) return null;"),
    ("a rejected rid fails the request instead of dropping the id",
     "src/swp/admission.ts",
     "    if (code > 0x7f || code === 0) return null;",
     "    if (code > 0x7f || code === 0) throw new Error(`bad rid ${rid}`);"),
    ("the generation is given the unsanitised rid",
     "    const rid = sanitiseRid(body.rid);",
     "    const rid = body.rid;"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/router.test.ts"], src=ROUTER)


if __name__ == "__main__":
    sys.exit(main())
