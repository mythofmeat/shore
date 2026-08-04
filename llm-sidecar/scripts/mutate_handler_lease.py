#!/usr/bin/env python3
"""Mutation pass over the stream lease (#18 / #12).

The lease decides which sessions a generation's output reaches: the session
that asked, plus the last one to send a real user message for that character.
Everything about it is a policy — who takes it, how long it lasts, who it
skips, when it is dropped — and none of it produces a value a fixture could
replay, so the tests assert the policies directly and this checks they would
notice if a policy changed.

The mutants cover four things:

- **Taking it.** Only a real user message does. A regen or a command taking it
  would point the stream at whatever script fired last instead of at the
  person watching.
- **Its lifetime.** One hour, expiring on the boundary, evicted as it is read.
- **Resolving it.** The issuer gets no second copy; a lease on a disconnected
  session is dropped rather than retried.
- **The fanout.** Both recipients get every frame, the recipients are fixed
  when the generation starts, and neither one's failure reaches the other.

A mutant is KILLED if `bun test tests/handler_lease.test.ts` fails with it
applied.

This is **20/20**, from 20/21 on the first full pass.

The survivor was swapping the issuer and expiry checks in `spectator`, and it
survived because it is equivalent: `now` only moves forward, so a lease that
has lapsed can never be used by anyone again, and whether the issuer's own read
evicts it changes only the size of a map. It is off the list, and the source
now checks expiry first — the order that leaves nothing behind. Chasing it with
a test would have meant asserting map contents through a hole cut in the class
for that purpose.

One further mutant was written, tried and removed as equivalent:

- **Sending to the issuer before the lease holder.** Each recipient still
  receives every frame in order; what changes is the interleaving between two
  independent sockets, which no client can observe and nothing in Shore reads.
  The order is asserted in one test anyway, because it is a choice the Rust
  made and a test is the only place left to write it down — so this mutant is
  killed, which is exactly why it is not interesting.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_handler_lease.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEASE = "src/handler/lease.ts"
SESSION = "src/swp/session.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- taking the lease -----------------------------------------------------
    ("take: every engine message takes the lease, regen included",
     LEASE,
     '    if (kind !== "message") return;\n',
     ""),
    ("take: a regen takes it and a user message does not",
     LEASE,
     '    if (kind !== "message") return;',
     '    if (kind !== "regen") return;'),
    ("take: nothing ever takes it",
     LEASE,
     '    if (kind !== "message") return;',
     "    return;"),
    ("take: the lease is global rather than per character",
     LEASE,
     '    this.#leases.set(character, { sessionId, expiresAt: now + LEASE_TTL_MS });',
     '    this.#leases.set("", { sessionId, expiresAt: now + LEASE_TTL_MS });'),
    ("take: a later message does not displace an earlier holder",
     LEASE,
     "    this.#leases.set(character, { sessionId, expiresAt: now + LEASE_TTL_MS });",
     "    if (!this.#leases.has(character)) {\n"
     "      this.#leases.set(character, { sessionId, expiresAt: now + LEASE_TTL_MS });\n"
     "    }"),

    # --- its lifetime ---------------------------------------------------------
    ("ttl: a day instead of an hour",
     LEASE,
     "export const LEASE_TTL_MS = 60 * 60 * 1000;",
     "export const LEASE_TTL_MS = 24 * 60 * 60 * 1000;"),
    ("ttl: a minute instead of an hour",
     LEASE,
     "export const LEASE_TTL_MS = 60 * 60 * 1000;",
     "export const LEASE_TTL_MS = 60 * 1000;"),
    ("ttl: the lease is stamped without its lifetime, so it is born expired",
     LEASE,
     "expiresAt: now + LEASE_TTL_MS });",
     "expiresAt: now });"),
    ("ttl: the boundary is inclusive, so the lease outlives its hour",
     LEASE,
     "    if (now >= lease.expiresAt) {",
     "    if (now > lease.expiresAt) {"),
    ("ttl: it never expires",
     LEASE,
     "    if (now >= lease.expiresAt) {\n"
     "      this.#leases.delete(character);\n"
     "      return undefined;\n"
     "    }\n",
     ""),
    ("ttl: an expired lease is declined but left in the map",
     LEASE,
     "    if (now >= lease.expiresAt) {\n      this.#leases.delete(character);\n      return undefined;\n    }",
     "    if (now >= lease.expiresAt) {\n      return undefined;\n    }"),

    # --- resolving it ---------------------------------------------------------
    ("resolve: the issuer is fanned out to twice",
     LEASE,
     "    if (lease.sessionId === issuerSession) return undefined;\n",
     ""),
    ("resolve: a lease on a vanished session is kept and retried forever",
     LEASE,
     "    if (send === undefined) this.#leases.delete(character);",
     "    if (send === undefined) return undefined;"),
    ("resolve: clearing forgets nothing",
     LEASE,
     "  clear(): void {\n    this.#leases.clear();",
     "  clear(): void {"),

    # --- the fanout -----------------------------------------------------------
    ("fanout: the lease holder never receives anything",
     LEASE,
     "      if (spectatorSend !== undefined) await sendQuietly(spectatorSend, msg);\n",
     ""),
    ("fanout: the issuer never receives anything",
     LEASE,
     "      await sendQuietly(issuerSend, msg);\n",
     ""),
    ("fanout: the recipients are re-resolved on every frame",
     LEASE,
     "    const spectatorSend = this.spectator(character, issuerSession, router, now);\n"
     "    return async (msg: ServerMessage) => {\n",
     "    return async (msg: ServerMessage) => {\n"
     "      const spectatorSend = this.spectator(character, issuerSession, router, now);\n"),
    ("fanout: a dead lease holder aborts the generation",
     LEASE,
     "      if (spectatorSend !== undefined) await sendQuietly(spectatorSend, msg);",
     "      if (spectatorSend !== undefined) await spectatorSend(msg);"),
    ("fanout: a dead issuer aborts the generation",
     LEASE,
     "      await sendQuietly(issuerSend, msg);",
     "      await issuerSend(msg);"),

    # --- the router method the lease resolves through -------------------------
    ("router: any connected session answers for any session id",
     SESSION,
     "  senderFor(sessionId: number): DirectSender | undefined {\n    return this.#senders.get(sessionId);",
     "  senderFor(sessionId: number): DirectSender | undefined {\n"
     "    return this.#senders.get(sessionId) ?? [...this.#senders.values()][0];"),
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/handler_lease.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    originals = {p: (ROOT / p).read_text() for p in {LEASE, SESSION}}
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, path, find, replace) in enumerate(MUTANTS, 1):
        original = originals[path]
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        (ROOT / path).write_text(original.replace(find, replace, 1))
        killed = not run()
        (ROOT / path).write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    for path, text in originals.items():
        (ROOT / path).write_text(text)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
