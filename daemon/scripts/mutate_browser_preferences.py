#!/usr/bin/env python3
"""Check persistent browser display choices and shared budget presentation rules."""
import sys
from mutation import run

P = "src/browser/preferences.ts"
B = "src/browser/budget_display.ts"
MUTANTS = [
    ("stream metadata ignored", "src/browser/workspace.ts", 'next.metadata = accumulateMetadata(next.metadata, message.metadata);', ''),
    ("subagent metadata overwrites main response", "src/browser/workspace.ts", 'next.subagent === null && next.msgId', 'next.msgId'),
    ("selection retains old message metadata", "src/browser/workspace.ts", 'metadata: changed ? {} :', 'metadata: false ? {} :'),
    ("token counts incorrectly limited to 32 bits", "src/browser/metadata.ts", 'Number(0xffff_ffff_ffff_ffffn)', '4_294_967_295'),
    ("metadata loses first-token timing", "src/browser/metadata.ts", 'ttft_ms: previous.timing.ttft_ms', 'ttft_ms: incoming.timing.ttft_ms'),

    ("legacy reasoning preference lost", P, 'storage.getItem("shore.reasoning") === "false"', 'false'),
    ("corrupt saved values accepted", P, '!viewValue(key, value)', 'false'),
    ("invalid named scope accepted", P, 'extra !== undefined', 'false'),
    ("single budget added to toggle cycle", P, 'budgets.length > 1', 'budgets.length > 0'),
    ("multiple budgets omitted from toggle cycle", P, 'choices.push(...budgets)', 'choices.push()'),
    ("preference write forgotten", P, 'this.#dirty.add(key);', ''),
    ("one tab overwrites unrelated fields", P, 'for (const key of this.#dirty) {', 'for (const key of VIEW_KEYS) {'),
    ("failed preferences lost on cross-tab notification", P, 'for (const key of this.#dirty) values[key] = this.#state.values[key];', ''),
    ("reset fails to persist defaults", P, 'this.#dirty = new Set(VIEW_KEYS)', 'this.#dirty = new Set()'),
    ("repaired storage retains stale error", P, 'this.#dirty.size === 0 ? "" : this.#state.error', 'this.#state.error'),
    ("warning thresholds ignored", B, 'level.crossed_warn_at.length > 0', 'false'),
    ("over limit not a warning", B, 'level.over_limit ||', 'false ||'),
    ("pace warning ignored in warning-only mode", B, '(budget.pace !== undefined && levelWarning(budget.pace))', 'false'),
    ("cap mode uses auto headline", B, 'case "cap": return { level: budget, scope: "cap" };', 'case "cap": return budgetLevel(budget, "auto");'),
    ("pace mode ignores pace readings", B, 'case "pace": return pace === undefined', 'case "pace": return true'),
    ("automatic ignores warning priority", B, 'levelWarning(pace) !== levelWarning(budget)', 'false'),
    ("equal levels prefer pace", B, 'pace.percent_used > budget.percent_used', 'pace.percent_used >= budget.percent_used'),
    ("equal budgets prefer first", B, 'level.percent_used >= budgetLevel(selected', 'level.percent_used > budgetLevel(selected'),
    ("named budget comparison is case sensitive", B, 'item.name.toLowerCase() === focus.name?.toLowerCase()', 'item.name === focus.name'),
    ("warning mode always visible", B, 'case "warn": return budgetWarning(budget);', 'case "warn": return true;'),
    ("off mode still visible", B, 'case "off": return false;', 'case "off": return true;'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_preferences.test.ts"]))
