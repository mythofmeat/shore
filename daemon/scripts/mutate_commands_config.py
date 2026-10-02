#!/usr/bin/env python3
"""Mutation pass over the configuration commands: the tool roster, config
checks, reading and setting values, and reload.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/config.ts"

MUTANTS = [
    # --- tools ----------------------------------------------------------------
    ("tools: the roster is the config's enabled list rather than the registry",
     "  const toolRows = ALL_TOOLS.map((def) => ({",
     "  const toolRows = ALL_TOOLS.filter((d) => toolEnabled(cfg, d.name)).map((def) => ({"),
    ("tools: main is always true",
     "    main: toolEnabled(cfg, def.name),",
     "    main: true as boolean,"),
    ("tools: owners are every subagent, not only the enabled ones",
     "    subagents: cfg.enabled_subagents.filter((s) =>",
     "    subagents: [...subagents.keys()].sort().filter((s) =>"),
    ("tools: a subagent owns every tool it is enabled for",
     "      (subagents.get(s)?.tools ?? []).some((t) => t === def.name),",
     "      subagents.has(s),"),
    ("tools: the subagent roster reports enablement from the tool config only",
     "      enabled: cfg.enabled_subagents.includes(name),",
     "      enabled: true as boolean,"),
    ("tools: a subagent with no model reports undefined rather than null",
     "      model: sa.model ?? null,",
     "      model: sa.model,"),
    ("tools: unknown tools in enabled_tools are not reported",
     "    if (!known.has(t)) warnings.push(`enabled_tools references unknown tool '${t}'`);",
     "    if (false) warnings.push(`enabled_tools references unknown tool '${t}'`);"),
    ("tools: an MCP server granted by name with no definition is not reported",
     "    if (!ctx.config.app.mcp.has(server)) warnings.push(",
     "    if (false) warnings.push("),
    ("tools: undefined subagents in enabled_subagents are not reported",
     "    if (!subagents.has(s)) {\n"
     "      warnings.push(`enabled_subagents references undefined subagent '${s}'`);\n"
     "    }",
     "    if (false) {\n"
     "      warnings.push(`enabled_subagents references undefined subagent '${s}'`);\n"
     "    }"),
    ("tools: a subagent's dangling tool references are not reported",
     "      if (!known.has(t)) warnings.push(`subagent '${name}' references unknown tool '${t}'`);",
     "      if (false) warnings.push(`subagent '${name}' references unknown tool '${t}'`);"),
    ("tools: only enabled subagents are checked for dangling tools",
     "  for (const name of [...subagents.keys()].sort()) {\n"
     "    for (const t of required(subagents.get(name)).tools) {",
     "  for (const name of cfg.enabled_subagents) {\n"
     "    for (const t of subagents.get(name)?.tools ?? []) {"),

    # --- config_check ---------------------------------------------------------
    ("check: valid ignores the warnings",
     "    valid: warnings.length === 0,",
     "    valid: true as boolean,"),
    ("check: the no-models warning is info instead",
     "    warnings.push(NO_CHAT_MODELS_MESSAGE);",
     "    info.push(NO_CHAT_MODELS_MESSAGE);"),
    ("check: a resolvable default model warns rather than informs",
     "    if (defaultResolves) info.push(`Default model: ${defaultModel}`);\n    else {\n"
     '      warnings.push(`Default model "${defaultModel}" not found in catalog`);',
     "    if (defaultResolves) warnings.push(`Default model: ${defaultModel}`);\n    else {\n"
     '      info.push(`Default model "${defaultModel}" not found in catalog`);'),
    ("check: an unset default warns even with an empty catalog",
     "  } else if (ctx.config.models.chat.size > 0) {",
     "  } else if (true) {"),
    ("check: the api-key probe treats a blank value as unset",
     "    if (keyEnv !== undefined && env[keyEnv] === undefined) {",
     '    if (keyEnv !== undefined && (env[keyEnv] ?? "") === "") {'),
    ("check: the api key is never checked",
     "    if (keyEnv !== undefined && env[keyEnv] === undefined) {",
     "    if (false) {"),
    ("check: chat_models counts the warnings",
     "    chat_models: ctx.config.models.chat.size,",
     "    chat_models: warnings.length,"),
    ("check: the data directory is reported as the config directory",
     "    data_dir: ctx.config.dirs.data,",
     "    data_dir: ctx.config.dirs.config,"),

    # --- config read ----------------------------------------------------------
    ("read: a value with no key is treated as a set",
     "  if (key !== undefined && value !== undefined) return configSet(ctx, key, value);",
     '  if (value !== undefined) return configSet(ctx, key ?? "model", value);'),
    ("read: the selected setting is ignored",
     '  const key = args.key ?? undefined;',
     '  const key = undefined;'),
    ('read: an unknown key returns null instead of failing',
     '  const found = walkConfigKey(app, canonical);\n  if (found === undefined) throw notFound(`Config section not found: ${key}`);',
     '  const found = walkConfigKey(app, canonical) ?? { value: null };'),

    ("read: the defaults baseline is the effective config",
     "  const out = serializeConfigValue(defaultAppConfig()) as Record<string, unknown>;",
     "  const out = serializeConfigValue(defaultAppConfig()) as Record<string, unknown>;\n"
     "  return out;"),
    ('read: the key read returns the whole default baseline',
     '  return { key: canonical, config: found.value, defaults: walkConfigKey(defaults, canonical)?.value ?? null };',
     '  return { key, config: found.value, defaults };'),
    ('read: the key read returns the default in place of the effective value',
     '  return { key: canonical, config: found.value, defaults: walkConfigKey(defaults, canonical)?.value ?? null };',
     '  return {\n    key,\n    config: walkConfigKey(defaults, key)?.value ?? null,\n    defaults: walkConfigKey(defaults, key)?.value ?? null,\n  };'),
    ("read: the walk accepts a prefix of the key it was asked for",
     "    if (!(segment in table)) return undefined;\n    current = table[segment];",
     "    if (!(segment in table)) return { value: current };\n    current = table[segment];"),

    # --- config set -----------------------------------------------------------
    ("set: the model is not validated against the catalog",
     "  if (entry.source === \"chat_models\") {\n    try {\n      findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, trimmed, true);",
     "  if (false as boolean) {\n    try {\n      findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, trimmed, true);"),
    ("set: nothing is checked against its source at all",
     "  checkAgainstSource(ctx, entry, value);",
     "  void checkAgainstSource;"),
    ("set: a list value is checked against its source item by item",
     '  if (entry.source === undefined || entry.kind === "list") return;',
     "  if (entry.source === undefined) return;"),
    ("set: a bad model reports invalid_request rather than not_found",
     "      findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, trimmed, true);\n    } catch (e) {\n      throw notFound(message(e));",
     "      findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, trimmed, true);\n    } catch (e) {\n      throw invalidRequest(message(e));"),
    ("set: a value the schema rejects is a not_found rather than a bad request",
     "    if (e instanceof SchemaValueError) throw invalidRequest(`${key}: ${e.message}`);",
     "    if (e instanceof SchemaValueError) throw notFound(`${key}: ${e.message}`);"),
    ("set: the echo is the spelling that was sent, not the canonical key",
     "  const key = canonicalKey(rawKey);\n  const entry = findSchemaEntry(schemaOf(ctx), key);",
     "  const key = rawKey;\n  const entry = findSchemaEntry(schemaOf(ctx), canonicalKey(rawKey));"),

    # --- config_reload --------------------------------------------------------
    ("reload: apply defaults to true rather than false",
     '  const apply = args.apply === true;',
     '  const apply = args["apply"] !== false;'),
    ("reload: explicit null applies configuration",
     "  const apply = args.apply === true;",
     "  const apply = args.apply === null || args.apply === true;"),
    ("reload: the character overlays are not validated",
     "  for (const name of discoverCharacters(fresh.dirs.config, fresh.dirs.workspace)) {",
     "  for (const name of [] as string[]) {"),
    ("reload: the environment is not threaded, so the dirs re-resolve",
     "const loaderOptions = (ctx: ConfigContext): { env?: Env; deferEnvironment: boolean } =>\n"
     "  ({ ...(ctx.env === undefined ? {} : { env: ctx.env }), deferEnvironment: true });",
     "const loaderOptions = (ctx: ConfigContext): { env?: Env } => {\n"
     "  void ctx;\n"
     "  return {};\n"
     "};"),
    ("reload: the config is adopted before the prompts are refreshed",
     "  let promptsRefreshed = false;\n"
     "  if (refreshPrompts) {",
     "  adopt(ctx, fresh);\n"
     "  let promptsRefreshed = false;\n"
     "  if (refreshPrompts) {"),
    ("reload: check mode adopts the config anyway",
     "  if (!apply) {\n    return {\n      applied: false,",
     "  if (!apply) {\n    adopt(ctx, fresh);\n    return {\n      applied: false,"),
    ("reload: prompts are refreshed whether or not they were asked for",
     "  if (refreshPrompts) {",
     "  if (true) {"),
    ("reload: the snapshot refresh does not notify the scheduler",
     "    ctx.runtime.notifyPromptSnapshotRefreshed(character);",
     "    void character;"),

    ("adopt: the fresh config is never handed to the live readers",
     "  ctx.runtime.adoptGlobalConfig(fresh);\n",
     ""),
    ("adopt: the fresh config is adopted after the reload, not before",
     "  ctx.runtime.adoptGlobalConfig(fresh);\n  ctx.runtime.reloadRuntimeConfig(fresh);",
     "  ctx.runtime.reloadRuntimeConfig(fresh);\n  ctx.runtime.adoptGlobalConfig(fresh);"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/config_commands.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
