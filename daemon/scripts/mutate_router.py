#!/usr/bin/env python3
"""Mutation pass over the message handler (#18 / #12).

Covers `src/handler/router.ts` — the consumer of `Server.routes()`: what a
routed message causes, who receives a generation's stream, and what a cancel
does.

Four things the mutants attack:

- **The launch decision.** That an unresolvable character stops the request
  rather than launching one, that a `Cancel` never launches, and that a `Regen`
  does.
- **Who sees a turn (#247).** That a generation's stream goes to every session
  viewing its conversation rather than the issuer alone, that a session joining
  mid-turn is replayed the turn so far exactly once, and that a disconnect
  never cancels a generation or a state-changing command. All of these fail in
  the *quiet* direction — the turn still happens, a frontend just never sees
  it, or it silently stops.
- **The cancel frame.** That it is sent only when something was running, that
  it carries the cancel's rid rather than the generation's, and that it is
  `is_final` with `finish_reason: "cancelled"`. A client waits forever on a
  missing one and renders two endings on a spurious one.
- **The rid filter.** Both halves of `is_ascii() && !contains('\\0')`, and that
  a rejected rid yields `null` rather than failing the request.

A mutant is KILLED if `bun test tests/router.test.ts` fails with it
applied.

This is **31/32**, from 21/28 on the first pass.

The first pass is the reason this file exists. Two of the seven survivors were
not fixture holes but **bugs in the port**, and neither would have shown up as a
failing test:

- **The abort controller was created and its signal never handed over.** The
  Rust called `JoinHandle::abort()`, which really does stop a tokio task. A
  promise has no such handle, so `controller.abort()` was a no-op: a cancelled
  generation kept running and kept streaming into a turn the client had already
  been told was over. `GenerationParams.signal` is that fix, and it is the whole
  of the cancellation contract on this side.
- **A superseded generation cleared its successor's abort handle.** The
  `finally` compared against `state.abort`, a field that a later launch had
  already reassigned — so the comparison was `x === x` and the delete always
  fired. The successor was then uncancellable: `cancelGeneration` would find
  nothing to abort and send no `stream_end`, and the client would wait forever.
  It compares against the handle the launch created now, captured in a local.

The other five were ordinary fixture holes: no case sent a `hello` down the
engine path, none came from a session that had already gone, none had a second
session holding the lease (so the fanout and the issuer's own sender were
indistinguishable), none carried a rid that sanitisation would reject, and the
cancel case used the same rid as the message it cancelled.

One survivor remains, equivalent, kept in the list so a later reader does not
"fix" it: **a `Cancel` falling through its early return.** The next guard —
`msg.type !== "message" && msg.type !== "regen"` — catches it, so the two
branches agree. Kept because the early return is what makes the intent legible
at the top of the function rather than a consequence three lines down.

Run from the repository root:
    python3 daemon/scripts/mutate_router.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ROUTER = ROOT / "src/handler/router.ts"
ROUTER = "src/handler/router.ts"

# (label, find, replace)
MUTANTS = [
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
    ("a cancel falls through into generation (EQUIVALENT: the core request plan for a cancel has no body, so launching it throws before any generation starts)",
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


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/router.test.ts"], src=ROUTER)


if __name__ == "__main__":
    sys.exit(main())
