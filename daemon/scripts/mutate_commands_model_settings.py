#!/usr/bin/env python3
"""Mutation pass over the daemon-owned model-setting registry."""
import sys

from mutation import run as run_mutants


SOURCE = "src/llm/settings.ts"

MUTANTS = [
    ("numbers reject native JSON numbers",
     '  const parsed = typeof value === "number"\n    ? value',
     '  const parsed = false\n    ? value'),
    ("booleans stop accepting yes and on",
     '      case "yes":\n      case "on":\n        return { value: true };',
     '        return { value: true };'),
    ("u32 accepts fractions",
     '  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xff_ff_ff_ff',
     '  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0xff_ff_ff_ff'),
    ("reasoning disable is no longer normalized",
     '    case "disable":\n    case "disabled":',
     '    case "disabled":'),
    ("replay inverts legacy booleans",
     '  if (typeof value === "boolean") return { value: value ? "all" : "none" };',
     '  if (typeof value === "boolean") return { value: value ? "none" : "all" };'),
    ("null no longer clears every setting",
     '  if (value === null || value === undefined) {',
     '  if (value === undefined) {'),
    ("unknown setting keys are silently accepted",
     '  if (definition === undefined) throw new Error(`unknown setting key: ${key}`);',
     '  if (false as boolean) throw new Error(`unknown setting key: ${key}`);'),
    ("missing supported_parameters rejects sampling",
     '  if (parameters === undefined) return "honored";',
     '  if (parameters === undefined) return "rejected";'),
    ("explicitly empty supported_parameters permits sampling",
     '  return parameters.includes(name) ? "honored" : "rejected";',
     '  return parameters.length === 0 || parameters.includes(name) ? "honored" : "rejected";'),
    ("thinking metadata closes an unknown effort domain",
     '  if (support?.effort !== undefined) return false;',
     '  if (support?.effort !== undefined || support?.thinking !== undefined) return false;'),
    ("an explicit effort domain permits arbitrary custom values",
     '  if (support?.effort !== undefined) return false;',
     '  if (support?.effort !== undefined) return true;'),
    ("adapter-local off disappears from reasoning suggestions",
     '  return unique([...base, ...(adapterSupportsOff(sdk) ? [REASONING_OFF] : [])]);',
     '  return unique(base);'),
    ("budget is incorrectly honored by OpenAI",
     '  const supportedSdk = sdk === "anthropic" || sdk === "gemini" || sdk === "moonshot";',
     '  const supportedSdk = sdk === "anthropic" || sdk === "gemini" || sdk === "moonshot" || sdk === "openai";'),
    ("schema emits definitions in reverse order",
     '  return SETTING_DEFINITIONS.map((definition) => ({',
     '  return SETTING_DEFINITIONS.toReversed().map((definition) => ({'),
    ("wire serialization ignores the registry order",
     '  for (const definition of SETTING_DEFINITIONS) {',
     '  for (const definition of SETTING_DEFINITIONS.toReversed()) {'),
]


def main() -> int:
    return run_mutants(MUTANTS, ["tests/model_settings.test.ts"], SOURCE)


if __name__ == "__main__":
    sys.exit(main())
