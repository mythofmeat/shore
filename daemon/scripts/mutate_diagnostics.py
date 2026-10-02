#!/usr/bin/env python3
"""Mutation pass over the diagnostics ring buffers: eviction, ordering,
capacity, and the JSON they produce.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/diagnostics.ts"

MUTANTS = [
    # --- eviction -------------------------------------------------------------
    ("ring: the newest entry is evicted rather than the oldest",
     "    if (this.#buf.length >= this.#capacity) this.#buf.shift();\n    this.#buf.push(item);",
     "    if (this.#buf.length >= this.#capacity) this.#buf.pop();\n    this.#buf.push(item);"),
    ("ring: nothing is ever evicted",
     "    if (this.#buf.length >= this.#capacity) this.#buf.shift();",
     "    if (false) this.#buf.shift();"),
    ("ring: eviction is one entry late",
     "    if (this.#buf.length >= this.#capacity) this.#buf.shift();",
     "    if (this.#buf.length > this.#capacity) this.#buf.shift();"),
    ("ring: eviction is one entry early",
     "    if (this.#buf.length >= this.#capacity) this.#buf.shift();",
     "    if (this.#buf.length >= this.#capacity - 1) this.#buf.shift();"),
    ("ring: entries are prepended rather than appended",
     "    if (this.#buf.length >= this.#capacity) this.#buf.shift();\n    this.#buf.push(item);",
     "    if (this.#buf.length >= this.#capacity) this.#buf.shift();\n"
     "    this.#buf.unshift(item);"),
    ("ring: a capacity of zero holds nothing",
     "    if (this.#buf.length >= this.#capacity) this.#buf.shift();\n    this.#buf.push(item);",
     "    if (this.#capacity === 0) return;\n"
     "    if (this.#buf.length >= this.#capacity) this.#buf.shift();\n    this.#buf.push(item);"),

    # --- lastN ----------------------------------------------------------------
    ("lastN: returns the first n rather than the last",
     "    return this.#buf.slice(Math.max(this.#buf.length - n, 0));",
     "    return this.#buf.slice(0, n);"),
    ("lastN: off by one",
     "    return this.#buf.slice(Math.max(this.#buf.length - n, 0));",
     "    return this.#buf.slice(Math.max(this.#buf.length - n - 1, 0));"),
    ("lastN: zero means everything rather than nothing",
     "    return this.#buf.slice(Math.max(this.#buf.length - n, 0));",
     "    return n === 0 ? [...this.#buf] : this.#buf.slice(Math.max(this.#buf.length - n, 0));"),
    ("lastN: the order is reversed",
     "    return this.#buf.slice(Math.max(this.#buf.length - n, 0));",
     "    return this.#buf.slice(Math.max(this.#buf.length - n, 0)).reverse();"),
    ("items: the order is reversed",
     "  items(): T[] {\n    return [...this.#buf];\n  }",
     "  items(): T[] {\n    return [...this.#buf].reverse();\n  }"),
    ("isEmpty: reports the capacity rather than the contents",
     "    return this.#buf.length === 0;",
     "    return this.#capacity === 0;"),

    # --- the aggregate --------------------------------------------------------
    ("toJson: count reports the number returned rather than the number held",
     "  return { count: buffer.length, recent: buffer.lastN(lastN).map(omitAbsent) };",
     "  const recent = buffer.lastN(lastN).map(omitAbsent);\n"
     "  return { count: recent.length, recent };"),
    ("toJson: every entry is returned regardless of lastN",
     "  return { count: buffer.length, recent: buffer.lastN(lastN).map(omitAbsent) };",
     "  return { count: buffer.length, recent: buffer.items().map(omitAbsent) };"),
    ("toJson: the error and key-fallback rings are swapped",
     "      errors: ring(this.errors, lastN),\n      key_fallbacks: ring(this.key_fallbacks, lastN),",
     "      errors: ring(this.key_fallbacks, lastN),\n      key_fallbacks: ring(this.errors, lastN),"),
    ("toJson: the api-call ring answers for the key fallbacks too",
     "      key_fallbacks: ring(this.key_fallbacks, lastN),",
     "      key_fallbacks: ring(this.api_calls, lastN),"),

    # --- serde's skip_serializing_if -----------------------------------------
    ('omitAbsent: absent optional fields are written as null',
     '  return Object.fromEntries(\n'
     '    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),\n'
     '  ) as T;',
     '  return Object.fromEntries(\n'
     '    Object.entries(entry).map(([k, v]) => [k, v === undefined ? null : v]),\n'
     '  ) as T;'),
    ('omitAbsent: nothing is elided',
     '  return Object.fromEntries(\n'
     '    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),\n'
     '  ) as T;',
     '  return { ...entry };'),
    ("omitAbsent: falsy values are elided too",
     "    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),",
     "    Object.entries(entry).filter(([, v]) => Boolean(v)),"),

    # --- capacity -------------------------------------------------------------
    ("capacity: the default ring is ten deep rather than a hundred",
     "const DEFAULT_CAPACITY = 100;",
     "const DEFAULT_CAPACITY = 10;"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/diagnostics.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
