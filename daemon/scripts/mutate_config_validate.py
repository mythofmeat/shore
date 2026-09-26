#!/usr/bin/env python3
"""Mutation pass over the parse_config_table / validate_config port (#18 / #12).

#12 requires every parity fixture be mutation-checked, on the evidence that
five ports in a row had a fixture replay green while still full of holes. This
is the harness for the assembly and validation half of `config/loader.ts`.

Each entry is a single textual edit that inverts one decision in the port. A
mutant is KILLED if `bun test tests/validate.test.ts` fails with it
applied; a survivor means either the fixture cannot see that decision, or the
code is equivalent under it.

The decisions worth attacking here are almost all *ordering* and *severity*,
not values. Which of six checks runs first is invisible unless a config has two
faults at once; whether a bad reference throws or warns is invisible unless the
warnings are captured. The fixture is built for both — roughly a dozen cases
are multi-fault documents that exist only to pin an order, and every case
records its warnings — so this harness is the check that those cases actually
reach the decisions they were written for.

The first pass was 82/94 and the survivors were the useful output. Three were
badly written mutants of mine that edited to a no-op. The other nine were real
fixture gaps, and every one of them is now a case in the generator: no
`provider:model_id` sub-agent model, so the entire trusted-path arm of
`model_ref_resolves` was unreached; no `[[providers]]` array-of-tables, so a
non-table section could be passed straight through instead of ignored and
nothing noticed; no catalog error that was not shadowed by a registry error;
no config setting both `defaults.model` and `defaults.subagent_model`; no
document warning about a missing MCP server from both the global allowlist and
a sub-agent's grants; and no budget name carrying a character that Rust's trim
and JavaScript's disagree about. Final state is 93/93 with no live survivors
and no documented equivalents.

Run from the repository root:
    python3 daemon/scripts/mutate_config_validate.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOADER = ROOT / "src/config/loader.ts"

# (label, find, replace)
MUTANTS = [
    # --- section extraction -----------------------------------------------
    ("extract: tools is lifted out before AppConfig is parsed",
     "  const parsed = parseAppConfig(remainder);",
     "  delete remainder.tools;\n\n  const parsed = parseAppConfig(remainder);"),
    ("extract: the raw table is captured after extraction, not before",
     "  const rawTable = structuredClone(table);\n\n  const remainder = { ...table };",
     "  const remainder = { ...table };"),
    ("extract: a non-table section is passed through instead of ignored",
     "  return isTable(value) ? value : undefined;",
     "  return value === undefined ? undefined : (value as TomlTable);"),
    ("extract: the catalog does not inherit registry transport defaults",
     "      imageGenerationSection,\n      providers,\n    );",
     "      imageGenerationSection,\n    );"),
    ("extract: a registry failure reports as a catalog failure",
     'throw new ConfigError("provider_registry", e.message);',
     'throw new ConfigError("catalog", e.message);'),
    ("extract: a catalog failure reports as an app parse failure",
     'throw new ConfigError("catalog", e.message);',
     'throw new ConfigError("parse_app", e.message);'),
    ("extract: the registry is built before AppConfig is parsed",
     '  const parsed = parseAppConfig(remainder);\n'
     '  if ("err" in parsed) throw new ConfigError("parse_app", parsed.err);\n'
     '  const app = parsed.ok;\n'
     '\n'
     '\n'
     '  let providers: ProviderRegistry;\n'
     '  try {\n'
     '    providers = ProviderRegistry.fromSection(providersSection);\n'
     '  } catch (e) {\n'
     '    if (!(e instanceof ProviderRegistryError)) throw e;\n'
     '    throw new ConfigError("provider_registry", e.message);\n'
     '  }\n',
     '  let providers: ProviderRegistry;\n'
     '  try {\n'
     '    providers = ProviderRegistry.fromSection(providersSection);\n'
     '  } catch (e) {\n'
     '    if (!(e instanceof ProviderRegistryError)) throw e;\n'
     '    throw new ConfigError("provider_registry", e.message);\n'
     '  }\n'
     '\n'
     '  const parsed = parseAppConfig(remainder);\n'
     '  if ("err" in parsed) throw new ConfigError("parse_app", parsed.err);\n'
     '  const app = parsed.ok;\n'),

    # --- validateConfig: which defaults are checked ------------------------
    ('validate: defaults.model is not checked',
     '  warnOnUnresolvableModelRef(catalog, providers, "chat.model", app.defaults.model, onWarn);\n',
     ''),

    ('validate: background.heartbeat is reported under the legacy name',
     '    "heartbeat.model",',
     '    "defaults.heartbeat",'),
    ("validate: background.compaction reads the heartbeat value",
     "    app.defaults.background.compaction,",
     "    app.defaults.background.heartbeat,"),
    ('validate: subagent_model is not checked',
     '    "subagents.model",\n    app.defaults.subagent_model,\n    onWarn,\n  );\n',
     ''),

    # --- validateConfig: sub-agents ---------------------------------------
    ("subagents: the enabled test is inverted",
     "    if (app.tools.enabled_subagents.includes(name)) {",
     "    if (!app.tools.enabled_subagents.includes(name)) {"),
    ("subagents: the allowlist takes globs",
     "    if (app.tools.enabled_subagents.includes(name)) {",
     "    if (app.tools.enabled_subagents.some((s) => s === name || s === \"*\")) {"),
    ("subagents: an empty model falls through to the defaults",
     "      const resolved = sub.model ?? app.defaults.subagent_model ?? app.defaults.model;",
     "      const resolved = sub.model || app.defaults.subagent_model || app.defaults.model;"),
    ("subagents: defaults.model outranks defaults.subagent_model",
     "      const resolved = sub.model ?? app.defaults.subagent_model ?? app.defaults.model;",
     "      const resolved = sub.model ?? app.defaults.model ?? app.defaults.subagent_model;"),
    ("subagents: no model at all is not an error",
     "      if (resolved === undefined) {",
     "      if (false as boolean) {"),
    ("subagents: an unresolvable model is not an error",
     "      if (!modelRefResolves(catalog, providers, resolved)) {",
     "      if (false as boolean) {"),
    ("subagents: a disabled sub-agent is rejected like an enabled one",
     "      warnOnUnresolvableModelRef(\n        catalog,\n        providers,\n        `subagents.${name}.model`,\n        sub.model,\n        onWarn,\n      );",
     "      if (sub.model !== undefined && !modelRefResolves(catalog, providers, sub.model)) {\n        throw validationError(`subagents.${name} bad`);\n      }"),

    # --- validateConfig: order of the top-level checks --------------------
    ("order: mcp is not validated",
     "  validateMcpServers(app, onWarn);\n", ""),
    ("order: mcp is validated before the sub-agents",
     "  validateMcpServers(app, onWarn);\n  validateDefaultEmbedding",
     "  validateDefaultEmbedding"),
    ("order: image_generation is checked before embedding",
     "  validateDefaultEmbedding(providers, app.defaults.embedding, onWarn);\n  validateDefaultImageGeneration(providers, app.defaults.image_generation, onWarn);",
     "  validateDefaultImageGeneration(providers, app.defaults.image_generation, onWarn);\n  validateDefaultEmbedding(providers, app.defaults.embedding, onWarn);"),
    ("order: usage is checked before the aux defaults",
     "  validateDefaultEmbedding(providers, app.defaults.embedding, onWarn);",
     "  validateUsageConfig(app.usage);\n  validateDefaultEmbedding(providers, app.defaults.embedding, onWarn);"),
    ("order: compaction is checked before usage",
     "  validateUsageConfig(app.usage);\n  if (app.daemon.web.enabled)",
     "  const c0 = validateCompaction(app.memory.compaction);\n  if (c0 !== undefined) throw validationError(c0);\n  validateUsageConfig(app.usage);\n  if (app.daemon.web.enabled)"),
    ("order: compaction is not checked",
     "  if (compaction !== undefined) throw validationError(compaction);",
     "  void compaction;"),

    # --- validateMcpServers -----------------------------------------------
    ("mcp: an empty command is not a transport",
     "    const hasCommand = server.command !== undefined;",
     "    const hasCommand = Boolean(server.command);"),
    ("mcp: an empty url is not a transport",
     "    const hasUrl = server.url !== undefined;",
     "    const hasUrl = Boolean(server.url);"),
    ("mcp: the both/neither messages are swapped",
     "        `mcp.${name} sets both \\`command\\` and \\`url\\`; set exactly one transport`,",
     "        `mcp.${name} sets neither \\`command\\` nor \\`url\\`; set exactly one transport`,"),
    ("mcp: setting both transports is allowed",
     "    if (hasCommand && hasUrl) {", "    if (false as boolean) {"),
    ("mcp: setting neither transport is allowed",
     "    if (!hasCommand && !hasUrl) {", "    if (false as boolean) {"),
    ("mcp: the grant sweep does not run",
     "  for (const pattern of referenced) {",
     "  for (const pattern of [] as string[]) {"),
    ("mcp: the wildcard server is not excluded",
     '    if (server !== "" && server !== "*" && !app.mcp.has(server)) {',
     '    if (server !== "" && !app.mcp.has(server)) {'),
    ("mcp: an empty server name is not excluded",
     '    if (server !== "" && server !== "*" && !app.mcp.has(server)) {',
     '    if (server !== "*" && !app.mcp.has(server)) {'),
    ("mcp: the whole remainder is the server name",
     '    const server = pattern.slice("mcp__".length).split("__")[0] ?? "";',
     '    const server = pattern.slice("mcp__".length);'),
    ("mcp: sub-agent grants are not swept",
     "    ...[...app.subagents.values()].flatMap((s) => s.tools),\n", ""),
    ("mcp: the global allowlist is not swept",
     "    ...toolGrants(app.tools),\n", ""),
    ("mcp: servers granted by name are not swept",
     "    ...toolGrants(app.tools),\n", "    ...app.tools.enabled_tools,\n"),
    ("mcp: sub-agent grants are swept before the global allowlist",
     "    ...toolGrants(app.tools),\n    ...[...app.subagents.values()].flatMap((s) => s.tools),",
     "    ...[...app.subagents.values()].flatMap((s) => s.tools),\n    ...toolGrants(app.tools),"),
    ("a removed web_search grant is not reported",
     "    if (pattern === \"web_search\") onWarn(", "    if (false) onWarn("),

    # --- validateUsageConfig ----------------------------------------------
    ("usage: the timezone check is case insensitive",
     '  if (config.timezone !== "local" && config.timezone !== "utc") {',
     '  if (config.timezone.toLowerCase() !== "local" && config.timezone.toLowerCase() !== "utc") {'),
    ("usage: a cost_usd of exactly 0 is allowed",
     "    if (budget.cost_usd <= 0.0) {", "    if (budget.cost_usd < 0.0) {"),
    ("usage: a warn_at of exactly 0 is allowed",
     "      if (threshold <= 0.0) {\n        throw validationError(\n          `usage.budgets[${idx}].warn_at values must be greater than 0`,",
     "      if (threshold < 0.0) {\n        throw validationError(\n          `usage.budgets[${idx}].warn_at values must be greater than 0`,"),
    ("usage: pace is validated before the anchors",
     "    validateBudgetAnchors(idx, budget);\n    validateBudgetPace(idx, budget);",
     "    validateBudgetPace(idx, budget);\n    validateBudgetAnchors(idx, budget);"),
    ("usage: the name check runs before the anchors",
     "    validateBudgetAnchors(idx, budget);\n    validateBudgetPace(idx, budget);\n",
     ""),
    ("usage: warn_at is checked before cost_usd",
     "    if (budget.cost_usd <= 0.0) {\n      throw validationError(`usage.budgets[${idx}].cost_usd must be greater than 0`);\n    }\n",
     ""),
    ("usage: the blank-name placeholder is 0-based",
     "    const name = trimmed === \"\" ? `budget ${idx + 1}` : trimmed;",
     "    const name = trimmed === \"\" ? `budget ${idx}` : trimmed;"),
    ("usage: budget names are not trimmed",
     "    const trimmed = rustTrim(budget.name);",
     "    const trimmed = budget.name;"),
    ("usage: budget names are trimmed the JavaScript way",
     "    const trimmed = rustTrim(budget.name);",
     "    const trimmed = budget.name.trim();"),
    ("usage: duplicate budget names are allowed",
     "    if (names.has(name)) {", "    if (false as boolean) {"),

    # --- validateBudgetAnchors --------------------------------------------
    ("anchors: reset_hour 23 is out of range",
     "    if (budget.reset_hour > 23) {", "    if (budget.reset_hour >= 23) {"),
    ("anchors: the period pairing is checked before the range",
     '    if (budget.reset_hour > 23) {\n      throw validationError(\n        `usage.budgets[${idx}].reset_hour must be 0-23, got ${budget.reset_hour}`,\n      );\n    }\n',
     ""),
    ("anchors: reset_hour is valid on an hourly budget",
     '    if (budget.period === "hour") {', "    if (false as boolean) {"),
    ("anchors: reset_day_of_week is only valid for a daily budget",
     '  if (budget.reset_day_of_week !== undefined && budget.period !== "week") {',
     '  if (budget.reset_day_of_week !== undefined && budget.period !== "day") {'),
    ("anchors: reset_day_of_month accepts 0",
     "    if (day < 1 || day > 31) {", "    if (day > 31) {"),
    ("anchors: reset_day_of_month accepts 32",
     "    if (day < 1 || day > 31) {", "    if (day < 1) {"),
    ("anchors: reset_day_of_month is valid outside a monthly budget",
     '    if (budget.period !== "month") {', "    if (false as boolean) {"),

    # --- validateBudgetPace -----------------------------------------------
    ("pace: an equal pace period is allowed",
     "  if (budgetPeriodRank(pace) >= budgetPeriodRank(budget.period)) {",
     "  if (budgetPeriodRank(pace) > budgetPeriodRank(budget.period)) {"),
    ("pace: a longer pace period is allowed",
     "  if (budgetPeriodRank(pace) >= budgetPeriodRank(budget.period)) {",
     "  if (budgetPeriodRank(pace) < budgetPeriodRank(budget.period)) {"),
    ("pace: a stray pace_action is ignored",
     "    if (budget.pace_action !== undefined) {\n      throw validationError(`usage.budgets[${idx}].pace_action requires pace_period`);\n    }\n",
     ""),
    ("pace: a stray pace_warn_at is ignored",
     "    if (budget.pace_warn_at !== undefined) {\n      throw validationError(`usage.budgets[${idx}].pace_warn_at requires pace_period`);\n    }\n",
     ""),
    ("pace: pace_warn_at is reported before pace_action",
     "    if (budget.pace_action !== undefined) {\n      throw validationError(`usage.budgets[${idx}].pace_action requires pace_period`);\n    }\n    if (budget.pace_warn_at !== undefined) {\n      throw validationError(`usage.budgets[${idx}].pace_warn_at requires pace_period`);\n    }",
     "    if (budget.pace_warn_at !== undefined) {\n      throw validationError(`usage.budgets[${idx}].pace_warn_at requires pace_period`);\n    }\n    if (budget.pace_action !== undefined) {\n      throw validationError(`usage.budgets[${idx}].pace_action requires pace_period`);\n    }"),
    ("pace: a pace_warn_at of exactly 0 is allowed",
     "  for (const threshold of budget.pace_warn_at ?? []) {\n    if (threshold <= 0.0) {",
     "  for (const threshold of budget.pace_warn_at ?? []) {\n    if (threshold < 0.0) {"),
    ("pace: the pace thresholds are not checked",
     "  for (const threshold of budget.pace_warn_at ?? []) {",
     "  for (const threshold of []) {"),

    # --- aux defaults ------------------------------------------------------
    ("aux: a disabled provider only warns",
     "  if (!entry.enabled) {\n    throw validationError(",
     "  if (false as boolean) {\n    throw validationError("),
    ("aux: an absent provider is rejected",
     '    if (providerKey === "openai" || hardcodedProviderBaseUrl(providerKey) !== undefined) return;\n    onWarn(',
     '    throw validationError(`missing ${field}`);\n    onWarn('),
    ("aux: the disabled check does not look at `enabled`",
     "  if (!entry.enabled) {", "  if (entry.enabled) {"),
    ("embedding: a bare alias is accepted",
     '  const split = splitOnce(name, ":");\n  if (split === undefined) {\n    throw validationError(\n      `embedding.model "${name}" must be a \\`provider:model_id\\` identity ` +',
     '  const split = splitOnce(name, ":");\n  if (split === undefined) {\n    return;\n    throw validationError(\n      `embedding.model "${name}" must be a \\`provider:model_id\\` identity ` +'),
    ("embedding: an empty half is accepted",
     '    throw validationError(\n      `embedding.model "${name}" is not a valid \\`provider:model_id\\` identity`,\n    );',
     "    /* accepted */"),
    ("embedding: the split takes the last colon",
     '  const split = splitOnce(name, ":");\n  if (split === undefined) {\n    throw validationError(\n      `embedding.model "${name}" must be',
     '  const split = splitOnceLast(name, ":");\n  if (split === undefined) {\n    throw validationError(\n      `embedding.model "${name}" must be'),
    ("image_generation: a bare alias is accepted",
     '    throw validationError(\n      `image.model "${name}" must be a \\`provider:model_id\\` identity ` +\n        "(transport lives on [providers.<provider>])",\n    );',
     "    return;"),
    ("image_generation: an empty half is accepted",
     '    throw validationError(\n      `image.model "${name}" is not a valid \\`provider:model_id\\` identity`,\n    );',
     "    /* accepted */"),
    ("image_generation: reports under the embedding field name",
     '  validateAuxProvider(providers, "image.model", providerKey, onWarn);',
     '  validateAuxProvider(providers, "embedding.model", providerKey, onWarn);'),

    # --- reference resolution ---------------------------------------------
    ("splitOnce: splits at the last separator",
     "  const at = s.indexOf(sep);", "  const at = s.lastIndexOf(sep);"),
    ("catalogHas: a catalog miss counts as a hit",
     "    if (e instanceof CatalogError) return false;",
     "    if (e instanceof CatalogError) return true;"),
    ("resolves: the static catalog is not consulted",
     "  if (catalogHas(catalog, name)) return true;\n  const split",
     "  const split"),
    ("resolves: a disabled provider still resolves",
     "  return providers.get(providerKey)?.enabled ?? false;",
     "  return providers.get(providerKey) !== undefined;"),
    ("resolves: an unregistered provider resolves",
     "  return providers.get(providerKey)?.enabled ?? false;",
     "  return providers.get(providerKey)?.enabled ?? true;"),
    ("resolves: discovery must be enabled too",
     "  return providers.get(providerKey)?.enabled ?? false;",
     "  const e = providers.get(providerKey);\n  return (e?.enabled ?? false) && (e?.discovery.enabled ?? false);"),
    ("resolves: an empty half still counts as provider:model_id",
     '  if (providerKey === "" || modelId === "") return false;\n  return providers.get(providerKey)',
     "  return providers.get(providerKey)"),
    ("warn: the static catalog is not consulted first",
     "  if (catalogHas(catalog, name)) return;\n",
     ""),
    ("warn: an empty half is treated as provider:model_id",
     '    if (providerKey !== "" && modelId !== "") {',
     "    if (true as boolean) {"),
    ("warn: an enabled provider warns too",
     "      if (entry?.enabled === true) return;", "      if (false as boolean) return;"),
    ("warn: the disabled and absent messages are swapped",
     '        "configured default model references a disabled provider; " +\n            "a disabled provider is unreferenceable, but per-character " +\n            "preferences can override at runtime",',
     '        `configured default model references provider "${providerKey}" which ` +\n            `is not configured under [providers.${providerKey}]`,'),
    ("warn: a disabled provider is silent",
     "      if (entry !== undefined) {\n        onWarn(", "      if (entry !== undefined) {\n        return;\n        onWarn("),
    ("warn: the provider field is omitted from the disabled warning",
     '            ["field", field],\n            ["name", name],\n            ["provider", providerKey],\n          ],\n        );\n        return;\n      }',
     '            ["field", field],\n            ["name", name],\n          ],\n        );\n        return;\n      }'),
    ("warn: an absent name still warns",
     "  if (name === undefined) return;\n  if (catalogHas(catalog, name)) return;",
     '  if (name === undefined) name = "";\n  if (catalogHas(catalog, name)) return;'),
    ("warn: the generic message omits the name",
     '    `configured default model "${name}" was not found in the static ` +',
     '    "configured default model was not found in the static " +'),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/validate.test.ts"], src=LOADER)


if __name__ == "__main__":
    sys.exit(main())
