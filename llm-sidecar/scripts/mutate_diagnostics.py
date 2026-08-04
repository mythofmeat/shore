#!/usr/bin/env python3
"""Mutation pass over the diagnostics ring buffers (#18 / #12).

Small module, and every one of its failure modes is quiet — nothing here can
throw, so a wrong answer just looks like a slightly different diagnostic:

- **Keeping the wrong end.** A ring that evicts the newest instead of the
  oldest, or a `lastN` that returns the *first* n, still returns entries of
  the right type and roughly the right number. It is the wrong report.
- **Off-by-one at the capacity.** Evicting one entry early or one late is a
  quiet capacity change, and the buffer is a fixed size precisely so memory
  is bounded.
- **`count` versus `recent.length`.** They are different numbers on purpose —
  a client renders "3 of 100" from them — and swapping one for the other
  reads as a plausible object.
- **Absent optional fields.** They are `skip_serializing_if` on the Rust
  side, so they are *missing* from the object rather than null. A port that
  emits `"error": null` changes the shape of a wire format.

A mutant is KILLED if `bun test tests/diagnostics_parity.test.ts` fails with
it applied.

This is **20/20**, from 18/21 on the first pass.

Two survivors were the same defect in the *test*, not the code. The `sparse`
seed left its optional fields off the object entirely, so
`Object.entries` never saw them and there was nothing for the serialiser to
elide — both "write nulls instead" and "elide nothing" then changed no
output. The seed now assigns an explicit `undefined`, which is the shape a
real call site produces: a cost the provider did not report arrives as a
variable holding `undefined`, and assigning it is what the interface's
`| undefined` is for. Note `toEqual` alone would still not have caught it —
it treats a missing key and an explicit `undefined` as equal — so the
elision is asserted over `Object.keys` too.

One mutant is **removed as equivalent**: `lastN` reading
`slice(length - n)` rather than `slice(Math.max(length - n, 0))`. A negative
index clamps to the start in JavaScript, so the two are the same expression.
The `Math.max` stays because it says what is meant, and because it is what
the Rust's `saturating_sub` says.

`count` versus `recent.length` earns its own seed: they agree in every
ordinary case, so telling them apart needs the `overflowing` seed, which
pushes 105 entries into a 100-entry ring and asks for the last 10. The
buffer holds 100, `recent` holds 10, and 105 appears nowhere in the answer.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_diagnostics.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/diagnostics.ts"

# (label, find, replace)
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
    ("toJson: the tool and error rings are swapped",
     "      tool_calls: ring(this.tool_calls, lastN),\n      errors: ring(this.errors, lastN),",
     "      tool_calls: ring(this.errors, lastN),\n      errors: ring(this.tool_calls, lastN),"),
    ("toJson: the api-call ring answers for the key fallbacks too",
     "      key_fallbacks: ring(this.key_fallbacks, lastN),",
     "      key_fallbacks: ring(this.api_calls, lastN),"),

    # --- serde's skip_serializing_if -----------------------------------------
    ("omitAbsent: absent optional fields are written as null",
     "  return Object.fromEntries(\n"
     "    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),\n  );",
     "  return Object.fromEntries(\n"
     "    Object.entries(entry).map(([k, v]) => [k, v === undefined ? null : v]),\n  );"),
    ("omitAbsent: nothing is elided",
     "  return Object.fromEntries(\n"
     "    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),\n  );",
     "  return { ...entry } as Record<string, unknown>;"),
    ("omitAbsent: falsy values are elided too",
     "    Object.entries(entry).filter(([, v]) => v !== undefined && v !== null),",
     "    Object.entries(entry).filter(([, v]) => Boolean(v)),"),

    # --- capacity -------------------------------------------------------------
    ("capacity: the default ring is ten deep rather than a hundred",
     "const DEFAULT_CAPACITY = 100;",
     "const DEFAULT_CAPACITY = 10;"),
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/diagnostics_parity.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    original = SRC.read_text()
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, find, replace) in enumerate(MUTANTS, 1):
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        SRC.write_text(original.replace(find, replace, 1))
        killed = not run()
        SRC.write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    SRC.write_text(original)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
