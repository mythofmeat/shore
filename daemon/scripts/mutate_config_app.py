#!/usr/bin/env python3
"""Mutation pass over `config/app.ts`: reading the AppConfig document, and the
helpers that answer questions about it.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "src/config/app.ts"
MODELS = ROOT / "src/config/models.ts"

MUTANTS = [
    # --- the struct walk --------------------------------------------------
    ("readStruct: walk the document's own key order instead of sorted keys",
     "for (const key of sortedKeys(value)) {\n    const read =",
     "for (const key of Object.keys(value)) {\n    const read ="),
    ("readStruct: sort in UTF-16 order",
     "for (const key of sortedKeys(value)) {\n    const read =",
     "for (const key of Object.keys(value).sort()) {\n    const read ="),
    ("readStruct: check every unknown field before reading any value",
     "  for (const key of sortedKeys(value)) {\n"
     "    const read = (spec.fields as Record<string, Reader<unknown> | undefined>)[key];\n"
     "    if (read === undefined) {",
     "  for (const key of sortedKeys(value)) {\n"
     "    if (!known.includes(key)) return { err: unknownField(key, known) };\n"
     "  }\n"
     "  for (const key of sortedKeys(value)) {\n"
     "    const read = (spec.fields as Record<string, Reader<unknown> | undefined>)[key];\n"
     "    if (read === undefined) {"),
    ("readStruct: accept unknown fields",
     "      return { err: unknownField(key, known) };\n"
     "    }\n"
     "    const parsed = read(value[key]);",
     "      continue;\n"
     "    }\n"
     "    const parsed = read(value[key]);"),

    ("readStruct: report missing fields in sorted order (EQUIVALENT — no spec "
     "declares its required fields out of sorted order, so the two agree)",
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
    ("expectedList: an empty field list still prints a clause (EQUIVALENT — "
     "unreachable; the sole caller builds `known` from a spec's own fields, and "
     "every spec declares at least one)",
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
     '  (v) => (typeof v === "number" ? { ok: v } : { err: invalidType(v, "f64") }),',
     '  (v) =>\n'
     '    typeof v === "number" && !Number.isInteger(v)\n'
     "      ? { ok: v }\n"
     '      : { err: invalidType(v, "f64") },'),
    ("models: invalidType: sequences and maps carry a rendering after all",
     MODELS,
     "  if (Array.isArray(value) || isTable(value)) return undefined;",
     "  if (false) return undefined;"),
    # --- flatten-only structs ---------------------------------------------
    # --- the positional (visit_seq) path ----------------------------------







    # --- maps -------------------------------------------------------------
    ("readMap: insertion order instead of code point order",
     "      for (const key of sortedKeys(v)) {\n        const parsed = inner(v[key]);",
     "      for (const key of Object.keys(v)) {\n        const parsed = inner(v[key]);"),
    ("readMap: UTF-16 order",
     "      for (const key of sortedKeys(v)) {\n        const parsed = inner(v[key]);",
     "      for (const key of Object.keys(v).sort()) {\n        const parsed = inner(v[key]);"),
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
     "return tools.enabled_tools.length > 0 || tools.enabled_mcp.length > 0 || tools.enabled_subagents.length > 0;",
     "return tools.enabled_tools.length > 0;"),
    ("anyToolEnabled: every list must be non-empty",
     "return tools.enabled_tools.length > 0 || tools.enabled_mcp.length > 0 || tools.enabled_subagents.length > 0;",
     "return tools.enabled_tools.length > 0 && tools.enabled_mcp.length > 0 && tools.enabled_subagents.length > 0;"),
    ("anyToolEnabled: MCP servers granted by name do not count",
     "return tools.enabled_tools.length > 0 || tools.enabled_mcp.length > 0 || tools.enabled_subagents.length > 0;",
     "return tools.enabled_tools.length > 0 || tools.enabled_subagents.length > 0;"),
    ("toolGrants: MCP servers granted by name are ignored",
     "return [...tools.enabled_tools, ...tools.enabled_mcp.map((server) => `mcp__${server}__*`)];",
     "return [...tools.enabled_tools];"),
    ("toolGrants: a server grant also matches servers sharing its prefix",
     "return [...tools.enabled_tools, ...tools.enabled_mcp.map((server) => `mcp__${server}__*`)];",
     "return [...tools.enabled_tools, ...tools.enabled_mcp.map((server) => `mcp__${server}*`)];"),
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
    ('resolveBackgroundModelName: the task pin is ignored',
     '  return defaults.background[task];',
     '  return undefined;'),

    ("resolveDisplayName: $USER wins over the configured name",
     'return defaults.display_name ?? env["USER"] ?? "User";',
     'return env["USER"] ?? defaults.display_name ?? "User";'),
    ("resolveDisplayName: an empty configured name falls through",
     'return defaults.display_name ?? env["USER"] ?? "User";',
     'return (defaults.display_name || env["USER"]) ?? "User";'),
    ("resolveDisplayName: no ultimate fallback",
     'return defaults.display_name ?? env["USER"] ?? "User";',
     'return defaults.display_name ?? env["USER"] ?? "";'),
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


    ("parseThinkingReplay: matching is case-insensitive",
     "  switch (s) {", "  switch (s.toLowerCase()) {"),


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
    ("defaults: message_complete is off",
     "  message_complete: true,\n  usage_warning: false,",
     "  message_complete: false,\n  usage_warning: false,"),

    ("defaults: the tool deadline is unlimited",
     "  timeout: ConfigDuration.fromSecs(300),",
     "  timeout: ConfigDuration.fromSecs(0),"),
    ("defaults: archive_after is on",
     "  archive_after: ConfigDuration.fromSecs(0),",
     "  archive_after: ConfigDuration.fromSecs(86_400),"),
    ("defaults: budgets warn at a single threshold",
     "    warn_at: [0.8, 1.0],", "    warn_at: [1.0],"),

    # --- schema shape -----------------------------------------------------
    ("schema: AppConfig field order changes the expected list",
     "    daemon: struct(DAEMON),\n    defaults: struct(DEFAULTS),",
     "    defaults: struct(DEFAULTS),\n    daemon: struct(DAEMON),"),
    ("schema: SubagentConfig requires only description",
     'required: ["description", "prompt"],', 'required: ["description"],'),
    ("schema: SubagentConfig lists prompt first",
     'required: ["description", "prompt"],', 'required: ["prompt", "description"],'),
    ("schema: cost_usd is optional",
     '  required: ["cost_usd"],', ""),
    ("schema: tools.config is keyed like any other map, not by tool name",
     '    config: readMap(struct(TOOL_OVERRIDE), "tools"),',
     "    config: readMap(struct(TOOL_OVERRIDE)),"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/app.test.ts", "tests/config_schema.test.ts"], src=APP)


if __name__ == "__main__":
    sys.exit(main())
