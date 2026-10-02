#!/usr/bin/env python3
"""Mutation pass over the generation setup phase: `resolveGenerationModel`'s
fallback chain and `buildGenerationRequest`'s assembly.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SETUP = ROOT / "src/handler/setup.ts"

MUTANTS = [
    # --- the resolution chain ---------------------------------------------
    ("chain: the pre-resolved model is ignored",
     "  if (activeModel !== undefined) {\n    base = activeModel;",
     "  if (false as boolean) {\n    base = activeModel as ResolvedModel;"),
    ("chain: a configured default beats the pre-resolved model",
     "  if (activeModel !== undefined) {\n"
     "    base = activeModel;\n"
     "  } else {\n"
     "    const name = config.app.defaults.model;",
     "  {\n    const name = config.app.defaults.model;"),
    ("chain: a misspelled default silently becomes the first model",
     "      base = findEffectiveModel(configView(config), config.dirs.cache, name, true);",
     "      try {\n"
     "        base = findEffectiveModel(configView(config), config.dirs.cache, name, true);\n"
     "      } catch {\n"
     "        base = firstChatModel(config.models) as ResolvedModel;\n"
     "      }"),
    ("chain: hidden models are excluded from the default lookup",
     "      base = findEffectiveModel(configView(config), config.dirs.cache, name, true);",
     "      base = findEffectiveModel(configView(config), config.dirs.cache, name, false);"),
    ("chain: the default is looked up against the data dir",
     "      base = findEffectiveModel(configView(config), config.dirs.cache, name, true);",
     "      base = findEffectiveModel(configView(config), config.dirs.data, name, true);"),
    ("chain: an empty catalog resolves to something instead of failing",
     "      if (first === undefined) throw new NoModelError(NO_CHAT_MODELS_MESSAGE);",
     "      if (first === undefined) return {} as ResolvedModel;"),
    ("chain: the no-model error says something else",
     "      if (first === undefined) throw new NoModelError(NO_CHAT_MODELS_MESSAGE);",
     '      if (first === undefined) throw new NoModelError("no model");'),

    # --- the overlay -------------------------------------------------------
    ("overlay: applied even when empty (EQUIVALENT — applySamplerOverlay writes only "
     "the fields the overlay sets, so an empty one returns a value-identical copy)",
     "  return samplerIsEmpty(overlay) ? base : applySamplerOverlay(base, overlay);",
     "  return applySamplerOverlay(base, overlay);"),
    ("overlay: never applied",
     "  return samplerIsEmpty(overlay) ? base : applySamplerOverlay(base, overlay);",
     "  return base;"),
    ("overlay: the emptiness test is inverted",
     "  return samplerIsEmpty(overlay) ? base : applySamplerOverlay(base, overlay);",
     "  return samplerIsEmpty(overlay) ? applySamplerOverlay(base, overlay) : base;"),

    # --- history selection -------------------------------------------------
    ("history: a regen sends the whole window",
     "  const messages = params.regen\n"
     "    ? engine.messagesThroughLastUserTurn()\n"
     "    : [...engine.messages()];",
     "  const messages = [...engine.messages()];"),
    ("history: a fresh turn is truncated like a regen",
     "  const messages = params.regen\n"
     "    ? engine.messagesThroughLastUserTurn()\n"
     "    : [...engine.messages()];",
     "  const messages = engine.messagesThroughLastUserTurn();"),
    ("history: the regen test is inverted",
     "  const messages = params.regen\n"
     "    ? engine.messagesThroughLastUserTurn()\n"
     "    : [...engine.messages()];",
     "  const messages = params.regen\n"
     "    ? [...engine.messages()]\n"
     "    : engine.messagesThroughLastUserTurn();"),
    ("prior context: never set",
     "  const hasPriorContext = engine.segmentCount() > 0;",
     "  const hasPriorContext = false as boolean;"),
    ("prior context: always set",
     "  const hasPriorContext = engine.segmentCount() > 0;",
     "  const hasPriorContext = true as boolean;"),
    ("prior context: off by one",
     "  const hasPriorContext = engine.segmentCount() > 0;",
     "  const hasPriorContext = engine.segmentCount() > 1;"),

    # --- the mcp surface ---------------------------------------------------
    ("mcp: the allowlist is not applied",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(toolGrants(config.app.tools));",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(['mcp__*']);"),
    ("mcp: the surface is dropped",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(toolGrants(config.app.tools));",
     "  const mcpToolDefs: never[] = [];"),
    ("mcp: servers granted by name are ignored",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(toolGrants(config.app.tools));",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(config.app.tools.enabled_tools);"),
    ("mcp: filtered by the subagent allowlist instead",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(toolGrants(config.app.tools));",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(\n"
     "    config.app.tools.enabled_subagents,\n"
     "  );"),

    # --- what reaches prepareChatContext -----------------------------------
    ("context: the character data dir is the data dir itself",
     "    characterDataDir: characterDataDir(params.dataDir, charName),",
     "    characterDataDir: params.dataDir,"),
    ("context: the timezone is not threaded through",
     "    ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),",
     "    ...{},"),

    # --- the request -------------------------------------------------------
    ("request: an api key is baked in",
     '    ...buildRequestWithResolvedKey(toRequestModel(resolved), "", {',
     '    ...buildRequestWithResolvedKey(toRequestModel(resolved), "baked", {'),
    ("request: the message budget is not reported, so a crowded prompt never compacts",
     "    messageBudget: prepared.prompt.messageBudget,",
     "    messageBudget: Number.MAX_SAFE_INTEGER,"),
    ("request: the tool surface is dropped",
     "    ...(prepared.toolDefs === undefined ? {} : { tools: prepared.toolDefs }),",
     "    ...{},"),
    ("request: an absent surface ships as an empty list",
     "    ...(prepared.toolDefs === undefined ? {} : { tools: prepared.toolDefs }),",
     "    tools: prepared.toolDefs ?? [],"),
    ("request: the system blocks are dropped",
     "    system: prepared.system,",
     "    ...{},"),
    ("request: the replay policy is hardcoded",
     "    replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),",
     '    replay: "none" as const,'),

]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/setup.test.ts"], src=SETUP)


if __name__ == "__main__":
    sys.exit(main())
