#!/usr/bin/env python3
"""Mutation pass over the configuration commands (#18 / #12).

#12 requires every parity fixture be mutation-checked. The failure modes here
are unusually quiet even by this phase's standards, because four of the five
commands are *diagnostics* — the things people run to find out why something
else is broken:

- **A reload that half-applies.** `config_reload` validates, refreshes prompts,
  then adopts. Reorder those and a broken config on disk can leave the daemon
  running with a new prompt snapshot and an old config, or a fresh config and a
  stale snapshot. Nothing errors; the next background call just uses the wrong
  bytes.
- **A validation that skips the overlays.** A typo in one character's
  `config.toml` has to abort the whole reload. Skip that loop and it instead
  falls back silently at merge time, and that character quietly loses every
  setting it thought it had.
- **A tool surface that lies.** `tools` exists to explain why a tool is not
  firing. If the warnings are dropped, a typo in `enabled_tools` produces a
  report that looks completely healthy and answers nothing.
- **A reload that moves the data directory.** The loader takes the environment
  as an argument here where the Rust read the process environment. Drop it on
  the reload path and the daemon re-resolves XDG mid-run and starts writing
  somewhere else. This one was a real bug, found by this fixture and not by the
  replay passing.

A mutant is KILLED if `bun test tests/config_commands.test.ts` fails
with it applied.

The original pass reached **45/45**, from 36/41 on the first pass. The current
typed configuration boundary has 42 applicable mutants. One original survivor was an
equivalent mutant and is gone: removing the sort from the sub-agent roster
changes nothing, because the loader already stores the map sorted. The source
says why the sort stays anyway.

The other four were real gaps, and all four needed the *fixture* to grow — the
recorded cases could not tell the pairs apart:

- **The one sub-agent that was not enabled owned a tool that did not exist**, so
  "owners are the enabled sub-agents" and "owners are every sub-agent" agreed on
  every row. It owns a real tool now, *and* a dangling one, because the second
  loop needs the dangling reference to stay observable — fixing the first gap
  with only a real tool opened a new survivor in the warnings loop.
- **No api key env var was set to a blank value**, so "blank counts as unset"
  and "any value counts as set" agreed. `std::env::var` gives `Ok("")` for a
  blank, which is not an error, so a blank counts as *set*.
- **`active_resolved_model` was `None` in every case**, so dropping it on a
  model change was invisible. One case now seeds the pre-resolved selection the
  dispatcher would have supplied.
- **`apply` was only ever `true` or absent**, so boolean coercion semantics went
  unpinned. The canonical input now rejects non-boolean values; explicit null
  remains false and has its own mutation probe.

Two rules are pinned structurally rather than by the fixture, and both are noted
at the assertion. The Rust harness had no observer on `CommandContext`, so it
could not record which runtime hooks fired or in what order — and the order is
exactly what makes a failed reload safe, since prompts are refreshed before the
config is adopted. The fixture's `state_after` and `changed_after` carry
everything the Rust could see; the call-order assertions carry the rest.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_config.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/config.ts"

# (label, find, replace)
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
    ("read: an unknown key returns null instead of failing",
     "  const found = walkConfigKey(app, canonical);\n  if (found === undefined) throw notFound(notFoundMessage(key));",
     "  const found = walkConfigKey(app, canonical) ?? { value: null };"),
    ("read: a settable-only alias is reported as a plain miss",
     "  const readable = KEY_ALIASES.get(key);\n"
     "  if (readable === undefined || readable === key) return `Config section not found: ${key}`;",
     "  const readable = KEY_ALIASES.get(key);\n"
     "  if (true as boolean) return `Config section not found: ${key}`;\n  void readable;"),
    ("read: the defaults baseline is the effective config",
     "  const out = serializeConfigValue(defaultAppConfig()) as Record<string, unknown>;",
     "  const out = serializeConfigValue(defaultAppConfig()) as Record<string, unknown>;\n"
     "  return out;"),
    ("read: the key read returns the whole default baseline",
     "  return { key: canonical, config: found.value, defaults: walkConfigKey(defaults, canonical)?.value ?? null, ...(canonical === key ? {} : { deprecated_key: key }) };",
     "  return { key, config: found.value, defaults };"),
    ("read: the key read returns the default in place of the effective value",
     "  return { key: canonical, config: found.value, defaults: walkConfigKey(defaults, canonical)?.value ?? null, ...(canonical === key ? {} : { deprecated_key: key }) };",
     "  return {\n"
     "    key,\n"
     "    config: walkConfigKey(defaults, key)?.value ?? null,\n"
     "    defaults: walkConfigKey(defaults, key)?.value ?? null,\n"
     "  };"),
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


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/config_commands.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
