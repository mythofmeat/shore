#!/usr/bin/env python3
"""Mutation pass over the SWP listener: start-up, the handshake, the bound
address, writes after a disconnect, and routing.
"""
import sys

S = "src/swp/server.ts"

TESTS = ["tests/swp_server.test.ts"]

MUTANTS = [
    ("startup: early TCP clients remain open before the daemon can serve them",
     S,
     '      if (!this.#serving || this.#stopped) { socket.destroy(); return; }',
     '      if (this.#stopped) { socket.destroy(); return; }'),
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
    ("write: replying after disconnect leaves a session or reports a handler error",
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
     "    this.#routes.push(msg);",
     "    void msg;"),
    ("route: controls wait in the regular queue instead of reaching their handler",
     S,
     "    if (isControlRoutedMessage(msg) && this.#controlHandler !== undefined) {\n"
     "      await this.#controlHandler(msg);\n"
     "      return;\n"
     "    }",
     "    if (false as boolean) {\n"
     "      await this.#controlHandler?.(msg as never);\n"
     "      return;\n"
     "    }"),
    ("route: the queue never wakes its reader, so a drain started first hangs",
     S,
     "  push(msg: RoutedMessage): void {\n"
     "    this.#items.push(msg);\n"
     "    const wake = this.#wake;\n"
     "    this.#wake = null;\n"
     "    wake?.();",
     "  push(msg: RoutedMessage): void {\n    this.#items.push(msg);"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
