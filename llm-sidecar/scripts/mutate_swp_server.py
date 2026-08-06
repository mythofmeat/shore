#!/usr/bin/env python3
"""Mutation pass over the SWP listener (#18, step 5).

`swp_transport.test.ts` covers the protocol against in-memory duplexes and had
a harness of its own. This one covers the part that only exists once there is a
socket, and every mutant here is silent — a client connects, hand-shakes, and
is told something wrong rather than told nothing.

**The handshake arrives after construction.** The provider answers out of the
character registry, and the registry is built with this server's broadcast, so
one of the two has to exist first. Read at construction rather than per
connection, `setHandshakeProvider` becomes a no-op and every client is served
the fallback — one character literally named `default`, and an empty
conversation. Nothing errors. A user sees a window with the wrong character in
it and no reason why.

**The bind is separate from the accept.** `--addr 127.0.0.1:0` asks the kernel
for a port, and `instances.json` has to record the one it got. A bind that
reported the requested address instead would write a literal `:0` and send
every discovery client to a port nobody opened.

**Writing out.** Every connection writes one last frame — the shutdown notice
— and a write to a socket whose peer has already gone must *settle*. Bun does
not always call the write callback for a destroyed socket, and one unsettled
write wedges `serve`, which waits on every connection before returning. That
mutant times out rather than failing, which is why the timeout is a kill here.

**Routing.** A message that never reaches the queue is a message the handler
never answers, and the client waits for a reply that is not coming.

A mutant is KILLED if `bun test tests/swp_server.test.ts` fails with it applied.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_swp_server.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = "src/swp/server.ts"

TESTS = ["tests/swp_server.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the handshake --------------------------------------------------------
    ("handshake: captured at construction, so setting one afterwards does nothing",
     S,
     "        handshake: this.#handshake ?? DEFAULT_HANDSHAKE,",
     "        handshake: this.#config.handshake ?? DEFAULT_HANDSHAKE,"),
    ("handshake: the setter is a no-op and every client gets the fallback",
     S,
     "  setHandshakeProvider(handshake: HandshakeProvider): void {\n    this.#handshake = handshake;",
     "  setHandshakeProvider(handshake: HandshakeProvider): void {\n    void handshake;"),
    ("handshake: one passed at construction is dropped until something sets it",
     S,
     "    this.#handshake = config.handshake;",
     "    this.#handshake = undefined;"),
    ("handshake: the fallback is dropped, so a server with none set throws per connection",
     S,
     "        handshake: this.#handshake ?? DEFAULT_HANDSHAKE,",
     "        handshake: this.#handshake as HandshakeProvider,"),

    # --- the bind -------------------------------------------------------------
    ("bind: the requested address is reported, so port zero is recorded as zero",
     S,
     "    return { host: address.address, port: address.port };",
     "    return { host, port };"),
    ("bind: the resolved port is read off the wrong field",
     S,
     "    return { host: address.address, port: address.port };",
     "    return { host: address.address, port: 0 };"),

    # --- writing out ----------------------------------------------------------
    ("write: a write to a socket whose peer has gone never settles, wedging shutdown",
     S,
     "              if (socket.destroyed || socket.writableEnded) {\n"
     "                resolve();\n"
     "                return;\n"
     "              }\n"
     "              const settle = () => resolve();\n"
     '              socket.once("close", settle);\n'
     "              socket.write(bytes, (err) => {\n"
     '                socket.removeListener("close", settle);\n'
     "                if (err) reject(err);\n"
     "                else resolve();\n"
     "              });",
     "              socket.write(bytes, (err) => (err ? reject(err) : resolve()));"),
    ("write: the shutdown notice is not written, so a client sees a bare EOF",
     "src/swp/connection.ts",
     '      case "shutdown":\n        await writeMessage(sink, { type: "shutdown" });\n        return;',
     '      case "shutdown":\n        return;'),

    # --- routing --------------------------------------------------------------
    ("route: nothing is pushed, so the handler never sees a client's message",
     S,
     "        route: async (msg) => {\n          this.#routes.push(msg);\n        },",
     "        route: async (msg) => {\n          void msg;\n        },"),
    ("route: the queue never wakes its reader, so a drain started first hangs",
     S,
     "  push(msg: RoutedMessage): void {\n"
     "    this.#items.push(msg);\n"
     "    const wake = this.#wake;\n"
     "    this.#wake = null;\n"
     "    wake?.();",
     "  push(msg: RoutedMessage): void {\n    this.#items.push(msg);"),
]


def run_tests() -> bool:
    """True when the suite passes."""
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode == 0


def main() -> int:
    if not run_tests():
        print("baseline is red — fix the suite before mutating", file=sys.stderr)
        return 2

    survivors = []
    for i, (label, rel, find, replace) in enumerate(MUTANTS, start=1):
        path = ROOT / rel
        original = path.read_text()
        if find not in original:
            print(f"{i:3}. ERROR mutant does not apply: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        if original.count(find) != 1:
            print(f"{i:3}. ERROR mutant is ambiguous: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        path.write_text(original.replace(find, replace))
        try:
            killed = not run_tests()
        except subprocess.TimeoutExpired:
            # A hung listener is a kill: the mutant made a client wait forever,
            # which is exactly the failure these tests are for.
            killed = True
        finally:
            path.write_text(original)
        print(f"{i:3}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append(label)

    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} killed")
    for label in survivors:
        print(f"  SURVIVOR: {label}")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
