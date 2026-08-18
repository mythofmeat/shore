#!/usr/bin/env python3
"""Mutation pass over the AppConfig port (#18 / #12).

#12 requires every parity fixture be mutation-checked, on the evidence that
five ports in a row had a fixture replay green while still full of holes. This
is the harness for `config/app.ts`.

Each entry is a single textual edit that inverts one decision in the port. A
mutant is KILLED if `bun test tests/app.test.ts` fails with it applied;
a survivor means either the fixture cannot see that decision, or the code is
equivalent under it.

The interesting decisions here are not the field types — those are pinned many
times over by the parse cases — but the *walk*: sorted vs document order,
interleaved vs two-pass unknown-field detection, declaration order for missing
fields, and code-point vs UTF-16 ordering of the map-valued sections.

The first pass was 70/77, and the six live survivors were the useful output:
four were fixture gaps (no non-ASCII unknown key, no sequence given where a
struct or map was expected, no unknown key in a one-field struct, and no
middle-star pattern whose name extended past the star), and one was a mutant
aimed at a file this harness did not open. Filling those found `visit_seq`
entirely — the Rust accepts `autonomy = []` as a struct of defaults, and the
port had been rejecting it. Final state is 84/85 with one documented equivalent,
noted at its site in the source.

Run from the repository root:
    python3 daemon/scripts/mutate_config_app.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "src/config/app.ts"
# `invalidType` is shared with the model catalog, so one mutant lands there.
MODELS = ROOT / "src/config/models.ts"

# (label, find, replace) — implicitly APP unless the label starts with "models:"
MUTANTS = [
    # --- the struct walk --------------------------------------------------
    ("readStruct: walk the document instead of the BTreeMap",
     "for (const key of sortedKeys(value)) {\n    const read =",
     "for (const key of Object.keys(value)) {\n    const read ="),
    ("readStruct: sort in UTF-16 order",
     "for (const key of sortedKeys(value)) {\n    const read =",
     "for (const key of Object.keys(value).sort()) {\n    const read ="),
    ("readStruct: check every unknown field before reading any value",
     "  for (const key of sortedKeys(value)) {\n    const read = (spec.fields as Record<string, Reader<unknown> | undefined>)[key];\n    if (read === undefined) return { err: unknownField(key, known) };",
     "  for (const key of sortedKeys(value)) {\n    if (!known.includes(key)) return { err: unknownField(key, known) };\n  }\n  for (const key of sortedKeys(value)) {\n    const read = (spec.fields as Record<string, Reader<unknown> | undefined>)[key];\n    if (read === undefined) return { err: unknownField(key, known) };"),
    ("readStruct: accept unknown fields",
     "if (read === undefined) return { err: unknownField(key, known) };",
     "if (read === undefined) continue;"),
    ("readStruct: report missing fields in sorted order",
     "for (const key of spec.required ?? []) {",
     "for (const key of [...(spec.required ?? [])].sort()) {"),
    ("readStruct: skip the required-field check",
     "if (!seen.has(key)) return { err: `missing field \\`${key}\\`` };",
     "if (false) return { err: `missing field \\`${key}\\`` };"),
    ("readStruct: a non-table is not a type error",
     "if (!isTable(value)) return { err: invalidType(value, `struct ${spec.name}`) };",
     "if (!isTable(value)) return { ok: spec.make() };"),
    ("readStruct: an array counts as a table",
     "function isTable(value: unknown): value is Table {\n  return typeof value === \"object\" && value !== null && !Array.isArray(value);",
     "function isTable(value: unknown): value is Table {\n  return typeof value === \"object\" && value !== null;"),
    # --- error phrasing ---------------------------------------------------
    ("expectedList: no two-field branch",
     "if (known.length === 2) return `\\`${known[0]}\\` or \\`${known[1]}\\``;",
     "if (false) return `\\`${known[0]}\\` or \\`${known[1]}\\``;"),
    ("expectedList: no one-field branch",
     "if (known.length === 1) return `\\`${known[0]}\\``;",
     "if (false) return `\\`${known[0]}\\``;"),
    ("expectedList: an empty field list still prints a clause",
     "if (known.length === 0) return undefined;",
     "if (known.length === 0) return `one of `;"),
    ("readEnum: use the document path's wrong-type message",
     'return { err: "invalid type: unit variant, expected string only" };',
     'return { err: "wanted string or table" };'),
    ("readUint: no lower bound",
     "if (v < 0 || v > max)", "if (v > max)"),
    ("readUint: u32 gets no ceiling",
     "const max = name === \"u32\" ? 0xffff_ffff : Number.POSITIVE_INFINITY;",
     "const max = Number.POSITIVE_INFINITY;"),
    ("readUint: a float is accepted",
     "if (typeof v !== \"number\" || !Number.isInteger(v)) return { err: invalidType(v, name) };",
     "if (typeof v !== \"number\") return { err: invalidType(v, name) };"),
    ("readUint: out of range is an invalid *type*, not an invalid value",
     "return { err: `invalid value: integer \\`${v}\\`, expected ${name}` };",
     "return { err: invalidType(v, name) };"),
    ("readF64: an integer no longer widens",
     'typeof v === "number" ? { ok: v } : { err: invalidType(v, "f64") };',
     'typeof v === "number" && !Number.isInteger(v) ? { ok: v } : { err: invalidType(v, "f64") };'),
    ("readPath: a path is spelled like any other string",
     'typeof v === "string" ? { ok: v } : { err: invalidType(v, "path string") };',
     'typeof v === "string" ? { ok: v } : { err: invalidType(v, "a string") };'),
    ("models: invalidType: sequences and maps carry a rendering after all",
     "  if (Array.isArray(value) || isTable(value)) return undefined;",
     "  if (false) return undefined;"),
    # --- flatten-only structs ---------------------------------------------
    ("readFlattenOnly: keys land in the flattened map instead of erroring",
     "for (const key of sortedKeys(value)) return { err: unknownField(key, []) };",
     "return { ok: new Map(Object.entries(value)) };"),
    ("readFlattenOnly: the unknown-field error lists fields",
     "for (const key of sortedKeys(value)) return { err: unknownField(key, []) };",
     'for (const key of sortedKeys(value)) return { err: unknownField(key, ["extra"]) };'),
    # --- the positional (visit_seq) path ----------------------------------
    ("readStructFromSeq: an array is a type error, not a positional struct",
     "  if (Array.isArray(value)) return readStructFromSeq(spec, value);\n",
     ""),
    ("readStructFromSeq: trailing elements are ignored",
     "  if (seq.length > keys.length) {\n    return { err: `invalid length ${seq.length}, expected fewer elements in array` };\n  }\n",
     ""),
    ("readStructFromSeq: a short array is always an error",
     "      if (!noDefault.has(key)) continue;",
     "      if (false) continue;"),
    ("readStructFromSeq: a short array is never an error",
     "      if (!noDefault.has(key)) continue;",
     "      continue;"),
    ("readStructFromSeq: the reported length is the array's, not the field index",
     "err: `invalid length ${i}, expected struct ${spec.name} with ${keys.length} elements`,",
     "err: `invalid length ${seq.length}, expected struct ${spec.name} with ${keys.length} elements`,"),
    ("readStructFromSeq: an Option counts as defaulted, like on the map path",
     "  const noDefault = new Set<string>(spec.noDefault ?? []);",
     "  const noDefault = new Set<string>(spec.required ?? []);"),
    ("readStructFromSeq: fields fill in sorted order, not declaration order",
     "  const keys = Object.keys(spec.fields);\n  const noDefault",
     "  const keys = Object.keys(spec.fields).sort();\n  const noDefault"),
    # --- maps -------------------------------------------------------------
    ("readMap: insertion order instead of code point order",
     "    for (const key of sortedKeys(v)) {\n      const parsed = inner(v[key]);",
     "    for (const key of Object.keys(v)) {\n      const parsed = inner(v[key]);"),
    ("readMap: UTF-16 order",
     "    for (const key of sortedKeys(v)) {\n      const parsed = inner(v[key]);",
     "    for (const key of Object.keys(v).sort()) {\n      const parsed = inner(v[key]);"),
    ("readMap: a non-table is not a type error",
     'if (!isTable(v)) return { err: invalidType(v, "a map") };',
     'if (!isTable(v)) return { ok: new Map() };'),
    ("mapKeysInOrder: UTF-16 order",
     "return [...map.keys()].sort(compareByCodePoint);",
     "return [...map.keys()].sort();"),
    # --- tool allowlist ---------------------------------------------------
    ("toolPatternMatches: a trailing star is literal",
     'return pattern.endsWith("*")\n    ? name.startsWith(pattern.slice(0, -1))\n    : pattern === name;',
     "return pattern === name;"),
    ("toolPatternMatches: every pattern is a prefix",
     'return pattern.endsWith("*")\n    ? name.startsWith(pattern.slice(0, -1))\n    : pattern === name;',
     "return name.startsWith(pattern.replace(/\\*$/, \"\"));"),
    ("toolPatternMatches: the star is kept in the prefix",
     "? name.startsWith(pattern.slice(0, -1))",
     "? name.startsWith(pattern)"),
    ("toolPatternMatches: a star anywhere is a glob",
     'pattern.endsWith("*")', 'pattern.includes("*")'),
    ("subagentEnabled: globs apply to sub-agents too",
     "return tools.enabled_subagents.includes(name);",
     "return tools.enabled_subagents.some((p) => toolPatternMatches(p, name));"),
    ("anyToolEnabled: only tools count",
     "return tools.enabled_tools.length > 0 || tools.enabled_subagents.length > 0;",
     "return tools.enabled_tools.length > 0;"),
    ("anyToolEnabled: both lists must be non-empty",
     "return tools.enabled_tools.length > 0 || tools.enabled_subagents.length > 0;",
     "return tools.enabled_tools.length > 0 && tools.enabled_subagents.length > 0;"),
    ("resultCharsFor: the global wins over the per-tool override",
     "return tools.config.get(name)?.max_result_chars ?? tools.max_result_chars;",
     "return tools.max_result_chars;"),
    ("timeoutFor: zero is a deadline like any other",
     "return resolved.asMillisExact() > 0n ? resolved : undefined;",
     "return resolved;"),
    ("timeoutFor: the per-tool override is ignored",
     "const resolved = tools.config.get(name)?.timeout ?? tools.timeout;",
     "const resolved = tools.timeout;"),
    ("timeoutFor: only the global zero disables the deadline",
     "const resolved = tools.config.get(name)?.timeout ?? tools.timeout;\n  return resolved.asMillisExact() > 0n ? resolved : undefined;",
     "if (tools.timeout.asMillisExact() === 0n) return undefined;\n  return tools.config.get(name)?.timeout ?? tools.timeout;"),
    # --- defaults resolution ----------------------------------------------
    ("resolveBackgroundModelName: background.model wins over the per-task key",
     "return defaults.background[task] ?? defaults.background.model;",
     "return defaults.background.model ?? defaults.background[task];"),
    ("resolveBackgroundModelName: defaults.model is a background fallback",
     "return defaults.background[task] ?? defaults.background.model;",
     "return defaults.background[task] ?? defaults.background.model ?? defaults.model;"),
    ("resolveBackgroundModelName: the deprecated alias is consulted",
     "return defaults.background[task] ?? defaults.background.model;",
     "return defaults.background[task] ?? defaults.heartbeat ?? defaults.background.model;"),
    ("resolveDisplayName: $USER wins over the configured name",
     'return defaults.display_name ?? env["USER"] ?? "User";',
     'return env["USER"] ?? defaults.display_name ?? "User";'),
    ("resolveDisplayName: an empty configured name falls through",
     'return defaults.display_name ?? env["USER"] ?? "User";',
     'return (defaults.display_name || env["USER"]) ?? "User";'),
    ("resolveDisplayName: no ultimate fallback",
     'return defaults.display_name ?? env["USER"] ?? "User";',
     'return defaults.display_name ?? env["USER"] ?? "";'),
    ("normalizeDeprecatedAliases: the alias wins over the new key",
     "if (defaults.background.heartbeat === undefined) {",
     "if (true) {"),
    ("normalizeDeprecatedAliases: the alias is not cleared",
     "defaults.heartbeat = undefined;",
     ""),
    ("normalizeDeprecatedAliases: an empty alias is treated as absent",
     "if (value === undefined) return;",
     "if (value === undefined || value === \"\") return;"),
    # --- compaction validation --------------------------------------------
    ("validateCompaction: a disabled config is still validated",
     "if (!compaction.enabled) return undefined;",
     "if (false) return undefined;"),
    ("validateCompaction: archive_after is not checked for fractions",
     '  const archive = rejectFractionalSeconds(\n    "memory.compaction.archive_after",\n    compaction.archive_after,\n  );\n  if (archive !== undefined) return archive;',
     ""),
    ("validateCompaction: the turn check runs before the idle check",
     '  const idle = rejectFractionalSeconds(\n    "memory.compaction.idle_trigger",\n    compaction.idle_trigger,\n  );\n  if (idle !== undefined) return idle;',
     ""),
    ("validateCompaction: only min_turns must exceed keep_recent_turns",
     "if (compaction.min_turns <= k || compaction.max_turns <= k) {",
     "if (compaction.min_turns <= k) {"),
    ("validateCompaction: equality with keep_recent_turns is allowed",
     "if (compaction.min_turns <= k || compaction.max_turns <= k) {",
     "if (compaction.min_turns < k || compaction.max_turns < k) {"),
    ("validateCompaction: max_turns may undercut min_turns",
     "if (compaction.max_turns < compaction.min_turns) {",
     "if (false) {"),
    ("rejectFractionalSeconds: zero is not a whole number of seconds",
     "if (millis % 1000n === 0n) return undefined;",
     "if (millis !== 0n && millis % 1000n === 0n) return undefined;"),
    ("rejectFractionalSeconds: the second suggestion is not the next second",
     "${millis / 1000n + 1n}s", "${millis / 1000n + 2n}s"),
    ("rejectFractionalSeconds: the first suggestion rounds up",
     "Use \\`${millis / 1000n}s\\`", "Use \\`${millis / 1000n + 1n}s\\`"),
    # --- thinking replay --------------------------------------------------
    ("parseThinkingReplay: last_turn is rejected",
     '    case "last_turn":\n      return "all";',
     '      return "all";'),
    ("parseThinkingReplay: the legacy stringy bools are rejected",
     '    case "true":\n', ""),
    ("parseThinkingReplay: matching is case-insensitive",
     "  switch (s) {", "  switch (s.toLowerCase()) {"),
    ("readThinkingReplay: a bool is not accepted",
     'if (typeof v === "boolean") return { ok: v ? "all" : "none" };',
     ""),
    ("readThinkingReplay: the legacy bool is inverted",
     'return { ok: v ? "all" : "none" };',
     'return { ok: v ? "none" : "all" };'),
    ("readThinkingReplay: a non-string reports the string error",
     'return { err: "data did not match any variant of untagged enum BoolOrStr" };',
     'return { err: invalidType(v, "a string") };'),
    # --- budget helpers ---------------------------------------------------
    ("budgetPaceAction: defaults to block",
     'return budget.pace_action ?? "warn";',
     'return budget.pace_action ?? "block";'),
    ("budgetPaceWarnAt: an empty override falls back to warn_at",
     "return budget.pace_warn_at ?? budget.warn_at;",
     "return budget.pace_warn_at?.length ? budget.pace_warn_at : budget.warn_at;"),
    ("budgetPaceWarnAt: no fallback",
     "return budget.pace_warn_at ?? budget.warn_at;",
     "return budget.pace_warn_at ?? [];"),
    ("budgetPeriodRank: reversed",
     "return BUDGET_PERIODS.indexOf(period);",
     "return BUDGET_PERIODS.length - 1 - BUDGET_PERIODS.indexOf(period);"),
    ("numDaysFromMonday: Sunday-first weeks",
     "return BUDGET_WEEKDAYS.indexOf(day);",
     "return (BUDGET_WEEKDAYS.indexOf(day) + 1) % 7;"),
    # --- defaults ---------------------------------------------------------
    ("defaults: message_complete follows the stale doc comment",
     "  message_complete: false,", "  message_complete: true,"),
    ("defaults: stream is off",
     "  stream: true,", "  stream: false,"),
    ("defaults: the tool deadline is unlimited",
     "  timeout: ConfigDuration.fromSecs(300),",
     "  timeout: ConfigDuration.fromSecs(0),"),
    ("defaults: keepalive max is an hour, not twelve",
     "  keepalive_max: ConfigDuration.fromSecs(43_200),",
     "  keepalive_max: ConfigDuration.fromSecs(3600),"),
    ("defaults: archive_after is on",
     "  archive_after: ConfigDuration.fromSecs(0),",
     "  archive_after: ConfigDuration.fromSecs(86_400),"),
    ("defaults: the sidecar is off",
     "  enabled: true,\n  socket_path: undefined,",
     "  enabled: false,\n  socket_path: undefined,"),
    ("defaults: budgets warn at a single threshold",
     "    warn_at: [0.8, 1.0],", "    warn_at: [1.0],"),
    ("defaults: allow_compaction_over_budget is off",
     "  allow_compaction_over_budget: true,",
     "  allow_compaction_over_budget: false,"),
    # --- schema shape -----------------------------------------------------
    ("schema: AppConfig field order changes the expected list",
     "    daemon: (v) => readStruct(DAEMON, v),\n    defaults: (v) => readStruct(DEFAULTS, v),",
     "    defaults: (v) => readStruct(DEFAULTS, v),\n    daemon: (v) => readStruct(DAEMON, v),"),
    ("schema: SubagentConfig requires only description",
     'required: ["description", "prompt"],', 'required: ["description"],'),
    ("schema: SubagentConfig lists prompt first",
     'required: ["description", "prompt"],', 'required: ["prompt", "description"],'),
    ("schema: cost_usd is optional",
     '  required: ["cost_usd"],', ""),
    ("schema: tools.config is a plain table, not a per-tool map",
     "    config: readMap((v) => readStruct(TOOL_OVERRIDE, v)),",
     "    config: (v) => ({ ok: new Map() }) as ReturnType<Reader<Map<string, ToolOverride>>>,"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    routed = [
        (label, MODELS, find, replace)
        if label.startswith("models:")
        else (label, find, replace)
        for label, find, replace in MUTANTS
    ]
    return _run_mutants(routed, ["tests/app.test.ts"], src=APP)


if __name__ == "__main__":
    sys.exit(main())
