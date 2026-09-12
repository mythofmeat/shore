#!/usr/bin/env python3
"""Exercise manual tool argument, result and generated control contracts."""
import sys
from mutation import run

TOOL = "src/commands/run_tool.ts"
FORMS = "src/browser/forms.ts"
CONTROLS = "src/browser/tool_forms.ts"
MUTANTS = [
    ("structured tool input disappears", TOOL,
     'const input = { ...request.input, ...coercePairs(request.pairs, resolved.schema) };',
     'const input = { ...coercePairs(request.pairs, resolved.schema) };'),
    ("string tool overrides disappear", TOOL,
     'const input = { ...request.input, ...coercePairs(request.pairs, resolved.schema) };',
     'const input = { ...request.input };'),
    ("full output disappears", TOOL,
     'raw: request.raw ? run.raw : null,', 'raw: null,'),
    ("rejected tools appear successful", TOOL,
     'ok: !run.isError,', 'ok: true,'),
    ("nested calls disappear", TOOL,
     'calls: nestedCalls(frames, toolUseId, request.raw),', 'calls: [],'),
    ("failed nested calls appear successful", TOOL,
     'call.ok = !frame.is_error;', 'call.ok = true;'),
    ("nested raw output remains clipped", TOOL,
     'return raw ? text : truncateSummary(text, NESTED_OUTPUT_CHARS);',
     'return truncateSummary(text, NESTED_OUTPUT_CHARS);'),
    ("tool roster loses subagents", CONTROLS,
     '...access.subagents.map((agent) => `ask_${agent.name}`), ', ''),
    ("tool roster loses MCP tools", CONTROLS,
     ', ...access.mcp', ''),
    ("tool text fields strip multiline input", CONTROLS,
     'field.multiline = true;', 'field.multiline = false;'),
    ("optional object fields become explicit defaults", FORMS,
     'control.required.map((key) => {', 'Object.keys(control.fields).map((key) => {'),
    ("dictionary values lose their declared type", FORMS,
     'additional: next(node["additionalProperties"] ?? true)', 'additional: { kind: "json" }'),
    ("constrained dictionary keys silently lose their constraints", FORMS,
     'if (keys["type"] !== "string" || Object.keys(keys).length !== 1) throw', 'if (false) throw'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/run_tool_command.test.ts", "tests/browser_workspace.test.ts", "tests/operation_contracts.test.ts"]))
