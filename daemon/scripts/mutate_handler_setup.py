#!/usr/bin/env python3
"""Mutation pass over the generation setup phase (#18 / #12).

#12 requires every parity fixture be mutation-checked. This module is two
functions with quite different risk: `resolveGenerationModel` is a four-way
fallback chain where every branch produces *a* model, so a wrong branch is
silent; `buildGenerationRequest` is assembly, where the failures are wrong
inputs threaded to the right places.

The chain is the dangerous one. Falling through to the first catalog model when
the user's `defaults.model` is misspelled would look like it worked, on a model
they did not ask for and are paying for.

A mutant is KILLED if `bun test tests/setup.test.ts` fails with it
applied; a survivor means either the fixture cannot see that decision, or the
code is equivalent under it.

The first pass was 26/33; the third is 32/33. Five of the seven first-pass
survivors were real gaps, and again the shape was "reachable but invisible":

- Nothing exercised model *discovery* at all — every case resolved a static
  catalog entry, and `findModel` succeeds before the hidden check or the cache
  ever come up. Two cases now register a provider with `discovery.ignore` and a
  cache file behind it, which is what makes `includeHidden` mean anything.
- The cache directory needed a second round on its own. A cached record and a
  bare provider entry build the *same* model unless the record carries upstream
  metadata, so the cached ids now have a `context_length` and a
  `max_output_tokens`. That is also why the record needs `discovered_at`:
  without it both sides swallow the file as unparseable and quietly resolve off
  the provider entry, which looks identical from the outside.
- Every case ran against a model with no `top_p` and no `reasoning_effort`, so
  "apply the override unconditionally" and "leave the model's own alone" agreed
  on `undefined`. Three cases now use a model carrying both.
- Nothing lived at the character-specific data path that did not also live at
  its parent, so pointing the lookup one level up produced the same prompt. An
  `AGENTS.md` under the character's own `active_prompt` now separates them.

The one survivor is a true equivalent: `applySamplerOverlay` copies the model
and then writes only the fields the overlay sets, so applying an empty overlay
returns a value-identical model. The Rust's short-circuit saves a clone, not a
behaviour, and is kept because it says which of the two branches is the
interesting one.

Run from the repository root:
    python3 daemon/scripts/mutate_handler_setup.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SETUP = ROOT / "src/handler/setup.ts"

# (label, find, replace)
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
     '      if (first === undefined) throw new NoModelError("No model configured");',
     "      if (first === undefined) return { } as ResolvedModel;"),
    ("chain: the no-model error says something else",
     '      if (first === undefined) throw new NoModelError("No model configured");',
     '      if (first === undefined) throw new NoModelError("no model");'),

    # --- the overlay -------------------------------------------------------
    ("overlay: applied even when empty",
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
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(config.app.tools.enabled_tools);",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(['mcp__*']);"),
    ("mcp: the surface is dropped",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(config.app.tools.enabled_tools);",
     "  const mcpToolDefs: never[] = [];"),
    ("mcp: filtered by the subagent allowlist instead",
     "  const mcpToolDefs = params.mcpRegistry.toolDefsFiltered(config.app.tools.enabled_tools);",
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
     '  const built = buildRequestWithResolvedKey(toRequestModel(resolved), "", {',
     '  const built = buildRequestWithResolvedKey(toRequestModel(resolved), "baked", {'),
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

    # --- overrides ---------------------------------------------------------
    ("overrides: not applied at all",
     "  return params.overrides === undefined\n"
     "    ? built\n"
     "    : { ...built, request: withOverrides(built.request, params.overrides) };",
     "  return built;"),
    ("overrides: temperature is applied unconditionally",
     "  if (overrides.temperature !== undefined) out.temperature = overrides.temperature;",
     "  out.temperature = overrides.temperature;"),
    ("overrides: top_p is applied unconditionally",
     "  if (overrides.top_p !== undefined) out.top_p = overrides.top_p;",
     "  out.top_p = overrides.top_p;"),
    ("overrides: temperature and top_p are swapped",
     "  if (overrides.temperature !== undefined) out.temperature = overrides.temperature;\n"
     "  if (overrides.top_p !== undefined) out.top_p = overrides.top_p;",
     "  if (overrides.top_p !== undefined) out.temperature = overrides.top_p;\n"
     "  if (overrides.temperature !== undefined) out.top_p = overrides.temperature;"),
    ("overrides: the thinking budget is ignored",
     "  if (overrides.thinking_budget !== undefined) {",
     "  if (false as boolean) {"),
    ("overrides: provider_options is replaced rather than extended",
     "    out.provider_options = { ...out.provider_options, budget_tokens: overrides.thinking_budget };",
     "    out.provider_options = { budget_tokens: overrides.thinking_budget };"),
    ("overrides: provider_options is created even with no budget",
     "  if (overrides.thinking_budget !== undefined) {\n"
     "    out.provider_options = { ...out.provider_options, budget_tokens: overrides.thinking_budget };\n"
     "  }",
     "  out.provider_options = {\n"
     "    ...out.provider_options,\n"
     "    ...(overrides.thinking_budget === undefined ? {} : { budget_tokens: overrides.thinking_budget }),\n"
     "  };"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/setup.test.ts"], src=SETUP)


if __name__ == "__main__":
    sys.exit(main())
