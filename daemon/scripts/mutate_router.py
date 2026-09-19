#!/usr/bin/env python3
"""Mutation pass over the message handler (#18 / #12).

Covers `src/handler/router.ts` — the consumer of `Server.routes()`: what a
routed message causes, who receives a generation's stream, and what a cancel
does.

Four things the mutants attack:

- **The launch decision.** That an unresolvable character stops the request
  rather than launching one, that a `Cancel` never launches, and that a `Regen`
  does.
- **The lease.** That only a real user message takes it, and that a
  generation's stream goes to the fanout rather than to the issuer alone. Both
  fail silently in the *quiet* direction — the turn still happens, a frontend
  just never sees it.
- **The cancel frame.** That it is sent only when something was running, that
  it carries the active generation's rid, and that it is
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
cancel case incorrectly used a request id on the cancel frame. Issue #226
corrects that fixture: a wire cancel has no rid, so its acknowledgement must
carry the active generation's rid.

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
    ("a cancel falls through (EQUIVALENT — the next guard catches it, and "
     "keeping both is what makes the intent readable)",
     '    if (msg.type === "cancel") {\n'
     "      await this.cancelGeneration(meta.session.sessionId, \"user cancelled\");\n"
     "      return;\n"
     "    }",
     '    if (msg.type === "cancel") {\n'
     "      await this.cancelGeneration(meta.session.sessionId, \"user cancelled\");\n"
     "    }"),
    ("a regen is dropped instead of launched",
     '    if (msg.type !== "message" && msg.type !== "regen") return;',
     '    if (msg.type !== "message") return;'),
    ("a hello or command is treated as a message",
     '    if (msg.type !== "message" && msg.type !== "regen") return;',
     "    if (false) return;"),
    ("a request from a vanished session still launches",
     "    const issuerSend = this.#deps.router.senderFor(meta.session.sessionId);\n"
     "    if (issuerSend === undefined) return;",
     "    const issuerSend =\n"
     "      this.#deps.router.senderFor(meta.session.sessionId) ?? (() => Promise.resolve());"),

    # ── the regen body ──────────────────────────────────────────────────
    ("a regen carries the frame's text through",
     '          rid: msg.rid ?? null,\n          text: "",\n          stream: msg.stream,',
     '          rid: msg.rid ?? null,\n          text: (msg as { text?: string }).text ?? "x",\n'
     "          stream: msg.stream,"),
    ("a regen forces streaming on",
     '          text: "",\n          stream: msg.stream,',
     '          text: "",\n          stream: true,'),
    ("a regen drops its rid",
     '      ? {\n          rid: msg.rid ?? null,\n          text: "",',
     '      ? {\n          rid: null,\n          text: "",'),

    # ── the lease ───────────────────────────────────────────────────────
    ("every engine message takes the lease",
     '    this.#deps.leases.observe(resolved.name, meta.session.sessionId, meta.kind, undefined, meta.session.selectedThread);',
     '    this.#deps.leases.observe(resolved.name, meta.session.sessionId, "message", undefined, meta.session.selectedThread);'),
    ("no engine message takes the lease",
     '    this.#deps.leases.observe(resolved.name, meta.session.sessionId, meta.kind, undefined, meta.session.selectedThread);',
     '    void resolved;'),
    ("the lease is keyed by the session rather than the character",
     '    this.#deps.leases.observe(resolved.name, meta.session.sessionId, meta.kind, undefined, meta.session.selectedThread);',
     '    this.#deps.leases.observe(String(meta.session.sessionId), meta.session.sessionId, meta.kind, undefined, meta.session.selectedThread);'),
    ("the stream goes to the issuer alone, not the fanout",
     '    const send = this.#deps.leases.fanout(\n      charName,\n      meta.session.sessionId,\n      async (msg) => { if (inSelectedThread()) await issuerSend(msg); },\n      this.#deps.router,\n      undefined,\n      thread,\n    );',
     '    const send = issuerSend;'),
    ("the disconnect sweep leaves the leases in place",
     "    this.#deps.leases.clear();",
     "    void 0;"),
    ("the disconnect sweep cancels nothing",
     "    for (const sessionId of this.#sessions.keys()) {\n"
     '      await this.cancelGeneration(sessionId, "all clients disconnected");\n'
     "    }",
     "    void 0;"),
    ("cancellation uses an unsanitised generation rid",
     '    const generation: ActiveGeneration = { abort: () => controller.abort(), rid };',
     '    const generation: ActiveGeneration = { abort: () => controller.abort(), rid: body.rid };'),

    # ── the cancel frame ────────────────────────────────────────────────
    ("a cancel with nothing running still sends a frame",
     '    if (generations === undefined) return;',
     '    if (generations === undefined) {\n      await this.#deps.router.sendToSession(sessionId, cancelledStreamEnd(null));\n      return;\n    }'),
    ("a cancel sends no frame at all",
     "      await this.#deps.router.sendToSession(sessionId, cancelledStreamEnd(generation.rid));",
     "      void generation;"),
    ("a cancel does not abort what it announces",
     '      generation.abort();\n      generations.delete(key);',
     '      generations.delete(key);'),
    ("a finished generation clears a later launch's abort handle",
     '        if (generations.get(scope) === generation) {',
     '        if (true) {'),
    ("a completed generation retains its session state",
     '        if (generations.get(scope) === generation) {\n          generations.delete(scope);\n          if (generations.size === 0) this.#sessions.delete(meta.session.sessionId);\n        }',
     '        void generation;'),
    ("a cancelled generation retains its session state",
     '    if (generations.size === 0) this.#sessions.delete(sessionId);',
     '    void generations;'),
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
     "    if (previous !== undefined) {\n"
     '      this.#deps.log?.info?.("aborting previous generation (superseded by new request)");\n'
     "      previous.abort();\n"
     "    }",
     "    void previous;"),
    ("superseding also sends a cancelled stream_end",
     '    const generation: ActiveGeneration = { abort: () => controller.abort(), rid };\n    generations.set(scope, generation);\n    this.#sessions.set(meta.session.sessionId, generations);',
     '    const generation: ActiveGeneration = { abort: () => controller.abort(), rid };\n    generations.set(scope, generation);\n    this.#sessions.set(meta.session.sessionId, generations);\n    void this.#deps.router.sendToSession(meta.session.sessionId, cancelledStreamEnd(rid));'),

    # ── the rid filter ──────────────────────────────────────────────────
    ("the rid filter accepts anything",
     "    if (code > 0x7f || code === 0) return null;",
     "    if (false) return null;"),
    ("the rid filter stops rejecting NUL",
     "    if (code > 0x7f || code === 0) return null;",
     "    if (code > 0x7f) return null;"),
    ("the rid filter stops rejecting non-ascii",
     "    if (code > 0x7f || code === 0) return null;",
     "    if (code > 0x10ffff || code === 0) return null;"),
    ("a rejected rid fails the request instead of dropping the id",
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
