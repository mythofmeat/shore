#!/usr/bin/env python3
"""Mutation pass over the context windows Shore knows for Claude models, on the
static and the discovered catalog paths.
"""
import sys

MODELS = "src/config/models.ts"
EFFECTIVE = "src/config/effective_catalog.ts"

TESTS = [
    "tests/model_resolution.test.ts",
    "tests/preferences.test.ts",
]

MUTANTS = [
    ("table: only the [1m] suffix gets the million-token window", MODELS,
     '  if (modelId.endsWith("[1m]") || MILLION_TOKEN_CLAUDE.test(modelId)) return 1_000_000;',
     '  if (modelId.endsWith("[1m]")) return 1_000_000;'),
    ("table: models served through other protocols are given Claude's window", MODELS,
     '  if (sdk !== "claude_agent" && sdk !== "anthropic") return undefined;\n',
     ""),
    ("static: a configured model keeps the generic default", MODELS,
     "      if (window !== undefined) defaults.maxContextTokens = window;\n",
     ""),
    ("static: the known window overrides the provider's own setting", MODELS,
     "      if (window !== undefined) defaults.maxContextTokens = window;\n      if (entry !== undefined) mergeFrom(defaults, entry.defaults);",
     "      if (entry !== undefined) mergeFrom(defaults, entry.defaults);\n      if (window !== undefined) defaults.maxContextTokens = window;"),
    ("discovered: an alias is looked up by its own name", EFFECTIVE,
     "    knownContextWindow(sdk, upstreamModelId(modelId, disc)) ??",
     "    knownContextWindow(sdk, modelId) ??"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS, timeout=120)


if __name__ == "__main__":
    sys.exit(main())
