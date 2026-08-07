#!/usr/bin/env python3
"""Mutation pass over `call_log` and `transcript` (#18 / #12).

These are diagnostics, which makes their failure modes unusually quiet: a
wrong answer here looks exactly like a right one to anyone who was not already
suspicious. What the fixture has to catch:

- **Answering for the wrong character.** Both commands scope to the session's
  character unless told otherwise, and the response does not echo which
  character the rows came from — so a leak between two characters' logs is
  invisible in the output.
- **The `id` path versus the index path.** One `call_log` command does two
  different things depending on whether `id` parses as an integer. Send
  `"1"` down the id path and it answers a question nobody asked; send `1`
  down the index path and the payload silently vanishes.
- **`count` defaulting.** A negative, fractional or string count is `None` to
  serde, which means *the default*, not zero. Zero is a real count and means
  no limit. Three different behaviours, one argument.
- **The reordering.** `transcript` returns ticks newest-first but the
  iterations within a tick chronologically. Every wrong version of that still
  returns every row, in an order that looks deliberate.
- **The disabled shape.** With the store off both commands answer
  `{ enabled: false }` rather than failing, and `transcript` still carries its
  `source` while `call_log` carries `entries`. A client renders on `enabled`.

A mutant is KILLED if `bun test tests/call_log_parity.test.ts` fails with it
applied.

This is **41/41**, from 36/41 on the first pass.

Four of the five survivors were one fixture gap. The store held five calls
and nine transcripts, so a default limit of 20, a default of 10 and no limit
at all were the same query — every mutant that moved the default or changed
what a zero or negative count means returned an identical answer. Twenty
filler rows, stamped older than the interesting ones, turn the default into a
boundary something actually reaches while leaving the tick layout at the head
of the result.

The fifth was an untested path rather than a gap: no case made the store
fail, so both commands' error prefixes were unexercised and could be swapped
freely. The fixture cannot cover it — the generator has no way to make SQLite
fail on demand, and the text after the prefix would be Node's wording rather
than Rust's regardless — so the prefixes are asserted directly, read from the
Rust, and provoked by closing the store underneath the command.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_call_log.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/call_log.ts"

# (label, find, replace)
MUTANTS = [
    # --- count ----------------------------------------------------------------
    ("count: the default is 10 rather than 20",
     "    limit: countArg(args, 20),",
     "    limit: countArg(args, 10),"),
    ("count: transcript's default is not call_log's",
     "    store.queryTranscripts(source, ctx.characterName, countArg(args, 20)),",
     "    store.queryTranscripts(source, ctx.characterName, countArg(args, 10)),"),
    ("count: a fractional count is accepted",
     "  return typeof v === \"number\" && Number.isInteger(v) && v >= 0 ? v : fallback;",
     "  return typeof v === \"number\" && v >= 0 ? v : fallback;"),
    ("count: a negative count is accepted",
     "  return typeof v === \"number\" && Number.isInteger(v) && v >= 0 ? v : fallback;",
     "  return typeof v === \"number\" && Number.isInteger(v) ? v : fallback;"),
    ("count: a numeric string is accepted",
     "  const v = args[\"count\"];\n"
     "  return typeof v === \"number\" && Number.isInteger(v) && v >= 0 ? v : fallback;",
     "  const v = Number(args[\"count\"]);\n"
     "  return Number.isInteger(v) && v >= 0 ? v : fallback;"),
    ("count: zero means the default rather than no limit",
     "  return typeof v === \"number\" && Number.isInteger(v) && v >= 0 ? v : fallback;",
     "  return typeof v === \"number\" && Number.isInteger(v) && v > 0 ? v : fallback;"),

    # --- the id path ----------------------------------------------------------
    ("id: a numeric string is treated as an id",
     "  return typeof v === \"number\" && Number.isInteger(v) ? v : undefined;",
     "  const n = Number(v);\n  return Number.isInteger(n) ? n : undefined;"),
    ("id: a fractional id is truncated rather than ignored",
     "  return typeof v === \"number\" && Number.isInteger(v) ? v : undefined;",
     "  return typeof v === \"number\" ? Math.trunc(v) : undefined;"),
    ("id: zero is treated as absent",
     "  const id = asI64(args[\"id\"]);\n  if (id !== undefined) {",
     "  const id = asI64(args[\"id\"]);\n  if (id !== undefined && id !== 0) {"),
    ("id: a miss returns an empty result rather than erroring",
     "    if (payload === null) throw invalidRequest(`no call with id ${id}`);",
     "    if (payload === null) return { enabled: true, call: null };"),
    ("id: the miss is a not_found rather than an invalid_request",
     "    if (payload === null) throw invalidRequest(`no call with id ${id}`);",
     "    if (payload === null) throw notFound(`no call with id ${id}`);"),
    ("id: the miss message loses the id",
     "    if (payload === null) throw invalidRequest(`no call with id ${id}`);",
     "    if (payload === null) throw invalidRequest(\"no call with that id\");"),
    ("id: the payload is returned under `entries` like the index",
     "    return { enabled: true, call: payload };",
     "    return { enabled: true, entries: [payload] };"),
    ("id: the filters are applied to the lookup too",
     "    const payload = query(CALL_STORE_FAILED, () => store.getCall(id));",
     "    const payload = query(CALL_STORE_FAILED, () =>\n"
     "      store.queryCalls({ character: ctx.characterName, limit: 0 }).some((s) => s.id === id)\n"
     "        ? store.getCall(id)\n        : null,\n    );"),

    # --- the character scope --------------------------------------------------
    ("character: the filter is dropped, so every character's calls are returned",
     "    character: asStr(args[\"character\"]) ?? ctx.characterName,",
     "    character: asStr(args[\"character\"]) ?? null,"),
    ("character: the session's character wins over the argument",
     "    character: asStr(args[\"character\"]) ?? ctx.characterName,",
     "    character: ctx.characterName,"),
    ("character: a non-string argument is coerced rather than ignored",
     "    character: asStr(args[\"character\"]) ?? ctx.characterName,",
     "    character: args[\"character\"] === undefined ? ctx.characterName : String(args[\"character\"]),"),
    ("character: transcript is not scoped to the character",
     "    store.queryTranscripts(source, ctx.characterName, countArg(args, 20)),",
     "    store.queryTranscripts(source, null, countArg(args, 20)),"),
    ("character: transcript echoes back a different name than it filtered on",
     "    character: ctx.characterName,\n    entries: orderTranscriptRows(rows),",
     "    character: \"\",\n    entries: orderTranscriptRows(rows),"),

    # --- call_type ------------------------------------------------------------
    ("call_type: a non-string argument is coerced rather than ignored",
     "    call_type: asStr(args[\"call_type\"]) ?? null,",
     "    call_type: args[\"call_type\"] === undefined ? null : String(args[\"call_type\"]),"),
    ("call_type: the filter is ignored entirely",
     "    call_type: asStr(args[\"call_type\"]) ?? null,",
     "    call_type: null,"),

    # --- the source check -----------------------------------------------------
    ("source: dreaming is still accepted",
     "  if (source !== TRANSCRIPT_SOURCE) {",
     "  if (source !== TRANSCRIPT_SOURCE && source !== \"dreaming\") {"),
    ("source: any source is accepted",
     "  if (source !== TRANSCRIPT_SOURCE) {",
     "  if (false) {"),
    ("source: a non-string source is coerced rather than defaulted",
     "  const source = asStr(args[\"source\"]) ?? TRANSCRIPT_SOURCE;",
     "  const source = args[\"source\"] === undefined ? TRANSCRIPT_SOURCE : String(args[\"source\"]);"),
    ("source: the default is empty rather than heartbeat",
     "  const source = asStr(args[\"source\"]) ?? TRANSCRIPT_SOURCE;",
     "  const source = asStr(args[\"source\"]) ?? \"\";"),
    ("source: the rejection message loses the offending value",
     "      `unknown transcript source '${source}' (expected '${TRANSCRIPT_SOURCE}')`,",
     "      `unknown transcript source (expected '${TRANSCRIPT_SOURCE}')`,"),
    ("source: the check runs after the store is consulted, not before",
     "  if (source !== TRANSCRIPT_SOURCE) {\n"
     "    throw invalidRequest(\n"
     "      `unknown transcript source '${source}' (expected '${TRANSCRIPT_SOURCE}')`,\n"
     "    );\n"
     "  }\n"
     "  const store = ctx.callStore;\n"
     "  if (store === undefined) return { enabled: false, source, entries: [] };",
     "  const store = ctx.callStore;\n"
     "  if (store === undefined) return { enabled: false, source, entries: [] };\n"
     "  if (source !== TRANSCRIPT_SOURCE) {\n"
     "    throw invalidRequest(\n"
     "      `unknown transcript source '${source}' (expected '${TRANSCRIPT_SOURCE}')`,\n"
     "    );\n"
     "  }"),

    # --- the disabled shape ---------------------------------------------------
    ("disabled: call_log omits the empty entries list",
     "  if (store === undefined) return { enabled: false, entries: [] };",
     "  if (store === undefined) return { enabled: false };"),
    ("disabled: call_log reports itself enabled",
     "  if (store === undefined) return { enabled: false, entries: [] };",
     "  if (store === undefined) return { enabled: true, entries: [] };"),
    ("disabled: transcript omits the source it was asked for",
     "  if (store === undefined) return { enabled: false, source, entries: [] };",
     "  if (store === undefined) return { enabled: false, entries: [] };"),
    ("disabled: transcript carries a character it never looked up",
     "  if (store === undefined) return { enabled: false, source, entries: [] };",
     "  if (store === undefined)\n"
     "    return { enabled: false, source, character: ctx.characterName, entries: [] };"),
    ("enabled: the index omits its flag",
     "  return { enabled: true, entries: query(CALL_STORE_FAILED, () => store.queryCalls(filter)) };",
     "  return { entries: query(CALL_STORE_FAILED, () => store.queryCalls(filter)) };"),

    # --- the reordering -------------------------------------------------------
    ("order: rows are returned in store order, newest first throughout",
     "  ticks.reverse();\n  return ticks.flat();",
     "  return rows.slice();"),
    ("order: rows are returned oldest-first throughout",
     "  ticks.reverse();\n  return ticks.flat();",
     "  return rows.slice().reverse();"),
    ("order: the ticks are not put back into newest-first order",
     "  ticks.reverse();\n  return ticks.flat();",
     "  return ticks.flat();"),
    ("order: a repeated iteration continues the tick rather than starting one",
     "    const continues = previous !== undefined && row.iteration > previous;",
     "    const continues = previous !== undefined && row.iteration >= previous;"),
    ("order: the first row continues a tick that does not exist yet",
     "    const continues = previous !== undefined && row.iteration > previous;",
     "    const continues = previous === undefined || row.iteration > previous;"),
    ("order: every row starts its own tick",
     "    const continues = previous !== undefined && row.iteration > previous;",
     "    const continues = false;"),
    ("order: the boundary is measured against the previous tick's first row",
     "    previous = row.iteration;\n",
     "    if (!continues) previous = row.iteration;\n"),
    ("order: the walk runs newest-first rather than chronologically",
     "  for (let i = rows.length - 1; i >= 0; i -= 1) {\n    const row = rows[i] as TranscriptRow;",
     "  for (let i = 0; i < rows.length; i += 1) {\n    const row = rows[i] as TranscriptRow;"),

    # --- the failure wording --------------------------------------------------
    ("errors: transcript reports a call-store failure",
     "  const rows = query(\"transcript query failed\", () =>",
     "  const rows = query(CALL_STORE_FAILED, () =>"),
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/call_log_parity.test.ts"],
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
