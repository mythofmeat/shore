#!/usr/bin/env python3
"""Mutation pass over the `thread` listing: each thread's own turn count, and
which thread holds the warm cache slot.
"""
import pathlib
import sys

T = "src/commands/threads.ts"
K = "src/cache/keepalive.ts"

TESTS = ["tests/thread_commands.test.ts", "tests/keepalive_service.test.ts"]

MUTANTS = [
    # --- how far along each thread is ----------------------------------------
    ("turns: every row reports the count of the thread the session is in",
     T,
     "    ...(ctx.turns === undefined ? {} : { turns: ctx.turns.get(record.id) ?? 0 }),",
     "    ...(ctx.turns === undefined ? {} : { turns: ctx.turns.get(current) ?? 0 }),"),
    ("turns: a thread the count did not reach is reported as unknown rather than zero",
     T,
     "    ...(ctx.turns === undefined ? {} : { turns: ctx.turns.get(record.id) ?? 0 }),",
     "    ...(ctx.turns === undefined ? {} : { turns: ctx.turns.get(record.id) }),"),
    ("turns: a daemon that counted nothing says every thread is empty",
     T,
     "    ...(ctx.turns === undefined ? {} : { turns: ctx.turns.get(record.id) ?? 0 }),",
     "    turns: ctx.turns?.get(record.id) ?? 0,"),
    ("turns: the count is dropped from the listing entirely",
     T,
     "    ...(ctx.turns === undefined ? {} : { turns: ctx.turns.get(record.id) ?? 0 }),\n",
     ""),

    # --- which thread holds the cache slot -----------------------------------
    ("warm: every thread is marked warm, so switching always looks free",
     T,
     "    ...(ctx.warm === record.id ? { warm: true } : {}),",
     "    ...(ctx.warm === undefined ? {} : { warm: true }),"),
    ("warm: the marker follows the session rather than the cache",
     T,
     "    ...(ctx.warm === record.id ? { warm: true } : {}),",
     "    ...(current === record.id ? { warm: true } : {}),"),
    ("warm: the marker follows home rather than the cache",
     T,
     "    ...(ctx.warm === record.id ? { warm: true } : {}),",
     "    ...(home === record.id ? { warm: true } : {}),"),
    ("warm: nothing is ever marked, so the cost of a switch is never said",
     T,
     "    ...(ctx.warm === record.id ? { warm: true } : {}),\n",
     ""),
    ("warm: the cold threads are marked false, so the absent field stops meaning anything",
     T,
     "    ...(ctx.warm === record.id ? { warm: true } : {}),",
     "    warm: ctx.warm === record.id,"),

    # --- where the warm slot is read from ------------------------------------
    ("slot: a character with no armed prefix still claims a warm thread",
     K,
     "    const prefix = this.#entries.get(character)?.prefix;\n"
     "    if (prefix === undefined) return undefined;\n"
     "    return prefix.context?.thread ?? MAIN_THREAD;",
     "    return this.#entries.get(character)?.prefix?.context?.thread ?? MAIN_THREAD;"),
    ("slot: a prefix from before threads existed names no thread at all",
     K,
     "    return prefix.context?.thread ?? MAIN_THREAD;",
     "    return prefix.context?.thread;"),
    ("slot: a disarmed entry keeps its claim on the slot",
     K,
     "    entry.prefix = undefined;\n    entry.keepalive.onCacheInvalidated();",
     "    entry.keepalive.onCacheInvalidated();"),
    ("slot: every character reads the same slot",
     K,
     "    const prefix = this.#entries.get(character)?.prefix;",
     "    const prefix = [...this.#entries.values()][0]?.prefix;"),

    # --- the rest of what a listing says -------------------------------------
    ("listing: a session pointed at an archived thread keeps claiming to be in it",
     T,
     "  const current = records.some((t) => t.id === ctx.current) ? ctx.current : home;",
     "  const current = ctx.current;"),
    ("listing: home is marked on the thread the session is in",
     T,
     "    home: record.id === home,",
     "    home: record.id === current,"),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
