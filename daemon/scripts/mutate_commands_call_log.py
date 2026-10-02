#!/usr/bin/env python3
"""Mutation pass over the `call_log` and `transcript` commands: argument
decoding, filters, ordering, and the disabled and error replies.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/call_log.ts"

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
     "      return { enabled: true, call: presentCall(payload), wire: presentWire(wire, bodies) };",
     "      return { enabled: true, entries: [presentCall(payload)], wire: presentWire(wire, bodies) };"),
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
     "    character: ctx.characterName,\n    entries: [...rows].reverse(),",
     "    character: \"\",\n    entries: [...rows].reverse(),"),

    # --- call_type ------------------------------------------------------------
    ("call_type: a non-string argument is coerced rather than ignored",
     "    call_type: asStr(args[\"call_type\"]) ?? null,",
     "    call_type: args[\"call_type\"] === undefined ? null : String(args[\"call_type\"]),"),
    ("call_type: the filter is ignored entirely",
     "    call_type: asStr(args[\"call_type\"]) ?? null,",
     "    call_type: null,"),

    # --- the source check -----------------------------------------------------
    ("source: dreaming is still accepted",
     "  if (!TRANSCRIPT_SOURCES.includes(source)) {",
     "  if (!TRANSCRIPT_SOURCES.includes(source) && source !== \"dreaming\") {"),
    ("source: any source is accepted",
     "  if (!TRANSCRIPT_SOURCES.includes(source)) {",
     "  if (false) {"),
    ('source: explicit null bypasses the heartbeat default',
     '  const source = args.source ?? TRANSCRIPT_SOURCE;',
     '  const source = args.source === undefined ? TRANSCRIPT_SOURCE : args.source;'),
    ('source: the default is empty rather than heartbeat',
     '  const source = args.source ?? TRANSCRIPT_SOURCE;',
     '  const source = args.source ?? "";'),
    ("source: the rejection message loses the offending value",
     "      `unknown transcript source '${source}' (expected one of ${TRANSCRIPT_SOURCES.join(\", \")})`,",
     "      `unknown transcript source (expected one of ${TRANSCRIPT_SOURCES.join(\", \")})`,"),
    ("source: the check runs after the store is consulted, not before",
     "  if (!TRANSCRIPT_SOURCES.includes(source)) {\n"
     "    throw invalidRequest(\n"
     "      `unknown transcript source '${source}' (expected one of ${TRANSCRIPT_SOURCES.join(\", \")})`,\n"
     "    );\n"
     "  }\n"
     "  const store = ctx.callStore;\n"
     "  if (store === undefined) return { enabled: false, source, entries: [] };",
     "  const store = ctx.callStore;\n"
     "  if (store === undefined) return { enabled: false, source, entries: [] };\n"
     "  if (!TRANSCRIPT_SOURCES.includes(source)) {\n"
     "    throw invalidRequest(\n"
     "      `unknown transcript source '${source}' (expected one of ${TRANSCRIPT_SOURCES.join(\", \")})`,\n"
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
     "  return { enabled: true, entries: [...newestFirst].reverse() };",
     "  return { entries: [...newestFirst].reverse() };"),
    ("order: the index is left newest-first",
     "  return { enabled: true, entries: [...newestFirst].reverse() };",
     "  return { enabled: true, entries: [...newestFirst] };"),

    # --- the reordering -------------------------------------------------------
    ("order: transcript rows are returned in store order, newest first throughout",
     "    entries: [...rows].reverse(),",
     "    entries: [...rows],"),

    # --- the failure wording --------------------------------------------------
    ("errors: transcript reports a call-store failure",
     "  const rows = query(\"transcript query failed\", () =>",
     "  const rows = query(CALL_STORE_FAILED, () =>"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/call_log.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
