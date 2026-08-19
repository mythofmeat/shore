#!/usr/bin/env python3
"""Mutation pass over the model command surface (#18 / #12).

#12 requires every parity fixture be mutation-checked. Three things here go
wrong quietly:

- **Resolution order.** Four sources feed "which model is this", and every one
  of them yields *a* model. Reading the wrong one hands the user a real model
  they did not choose, and the only symptom is the bill.
- **The pre-resolved selection.** A discovered model's `qualified_name` is
  display-only; feeding it back to the resolver always misses. Any path that
  re-resolves instead of reading the parked value works perfectly on a static
  catalog and fails only for users on provider discovery.
- **What gets written.** `switch_model` and `set_model_setting` persist, and a
  wrong key, wrong scope or wrong file is invisible until the next session
  loads it back.

A mutant is KILLED if `bun test tests/model_commands.test.ts` fails with
it applied.

The first pass was 55/70, the second 69/69, and the fourth is 67/67 over a
rewritten set.

Three deletions moved this surface underneath the mutants. 58338805 removed
`ProcessSessionCache` and with it `activeResolvedModel` and the writes
`switch_model` and `reset_model` made to the session object, so five mutants
over the parked model and the in-memory selection had nothing left to change.
`resolveActiveModel` and `activeName` now start from the character's saved
preference via `effectiveChatModel`, which reaches their `[defaults].model` and
first-catalog-entry fallbacks only when no character is attached. Nothing
exercised that: the one characterless scenario configured `model = "alpha"`,
which was also the first catalog entry, so "consult the default" and "take the
first entry" agreed. Four hand-written cases separate them.

beddae67 deleted the model-id rule table, and #130 deleted the parameter it
left behind, so applicability now answers from the sdk and the capabilities
alone. The live input is
`ModelCapabilities`, which reaches the table only from a discovery cache; the
recorded caches carried neither `supported_parameters` nor `effort_levels`, so
both the applicability table and the effort domain answered the same with and
without them. The setup shape accepts both now, and two cases pin them. Fourteen of the fifteen
first-pass survivors were real gaps, and the shape never varied: the case was
present and nothing in it was load-bearing.

- **No argument was ever the empty string.** The Rust reads `name = ""` as
  absent and falls through to the active model.
- **The `Ambiguous` error had no route at all.** It needs two *discovery caches*
  carrying the same bare model id — a short name shared by two static providers
  is a plain miss, which is the first thing the new scenario checks. The
  generator only supported one provider; it takes a list now.
- **The config default was also the first catalog entry**, so "the default is
  the active-name fallback" and "the first entry is" agreed on every row.
- **No session ever carried an `active_model` that resolves nowhere**, so the
  whole reporting fallback was unexercised — and it is the interesting half,
  because it reports the name rather than swallowing it.
- **No session carried a *hidden* selection without a pre-resolved copy**, which
  is the only way to reach the `include_hidden: true` on the fallback resolve.
- **`all` only ever collapsed models that shared a qualified name too**, so
  comparing identity and comparing names agreed. Two catalog aliases for one
  model id now separate them.
- **No background pin failed to resolve**, so echoing the name the user wrote
  instead of erroring was dead weight.
- **`switch_model` was never called with both a bad name and no character**, so
  which of the two checks runs first was invisible.
- **`set_model_setting` was never called without a `value` key** — which the
  Rust reads as null, i.e. clear.
- **The capability check never saw a target different from the active model in
  a way that mattered**: a gemini-sdk model targeted by name from an anthropic
  session.
- **The preferences file never held two entries at once**, so "drop the entry
  that emptied" and "clear the file" agreed.
- **No model id moved an id-sensitive capability rule** — the same gap the
  settings fixture had. `claude-opus-4-8` and `gemini-3.1-pro` are in the
  catalog now.

The fifteenth survivor was not a gap: `list_models_active_name` retried through
the plain catalog after `find_effective_model` failed, and that retry cannot
succeed — `find_effective_model` *begins* with the same lookup and only reaches
its own paths once it has failed. Dropped rather than ported.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_models.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/models.ts"

# (label, find, replace)
MUTANTS = [
    # --- argument reading ---------------------------------------------------
    ('asName: an empty name is a name', '  return s === undefined || s === "" ? undefined : s;', "  return s;"),
    ("include_hidden defaults to true",
     '  const includeHidden = asBool(args["include_hidden"]) ?? false;\n  const view = configView(ctx.config);',
     '  const includeHidden = asBool(args["include_hidden"]) ?? true;\n  const view = configView(ctx.config);'),
    ("switch_model always opts past hidden",
     '  const includeHidden = asBool(args["include_hidden"]) ?? false;\n'
     "  const resolved = resolve(ctx, name, includeHidden);\n\n"
     "  const character = requireCharacter(ctx);",
     "  const resolved = resolve(ctx, name, true);\n\n  const character = requireCharacter(ctx);"),

    # --- error mapping ------------------------------------------------------
    ("catalog errors: hidden reports invalid_request",
     '  return e.kind === "ambiguous" ? invalidRequest(e.message) : notFound(e.message);',
     '  return e.kind === "ambiguous" || e.kind === "hidden" ? invalidRequest(e.message) : notFound(e.message);'),
    ("catalog errors: everything is not_found",
     '  return e.kind === "ambiguous" ? invalidRequest(e.message) : notFound(e.message);',
     "  return notFound(e.message);"),

    # --- resolveActiveModel -------------------------------------------------
    ("active: the character's saved model is ignored, so the config default wins",
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName);\n"
     "  if (resolved !== undefined) return resolved;",
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName);\n  void resolved;"),
    ("active: the config default is never consulted",
     "  const fallback = ctx.config.app.defaults.model;\n"
     "  if (fallback !== undefined) return resolve(ctx, fallback, true);",
     "  const fallback = ctx.config.app.defaults.model;\n  void fallback;"),
    ("active: hidden models are excluded from the fallback",
     "  if (fallback !== undefined) return resolve(ctx, fallback, true);",
     "  if (fallback !== undefined) return resolve(ctx, fallback, false);"),

    # --- background tasks ---------------------------------------------------
    ("background: dreaming is still a task",
     '  if (selector === "heartbeat" || selector === "compaction") return selector;',
     '  if (selector === "heartbeat" || selector === "compaction" || selector === "dreaming")\n'
     "    return selector as BackgroundTask;"),
    ("background: the per-task pin is ignored",
     "  const pinned = ctx.config.app.defaults.background[task] ?? ctx.config.app.defaults.background.model;",
     "  const pinned = ctx.config.app.defaults.background.model;"),
    ("background: the blanket pin is ignored",
     "  const pinned = ctx.config.app.defaults.background[task] ?? ctx.config.app.defaults.background.model;",
     "  const pinned = ctx.config.app.defaults.background[task];"),
    ("background: the blanket pin beats the per-task one",
     "  const pinned = ctx.config.app.defaults.background[task] ?? ctx.config.app.defaults.background.model;",
     "  const pinned = ctx.config.app.defaults.background.model ?? ctx.config.app.defaults.background[task];"),
    ("background: the inherited model is the config default, not the character's",
     "  const inherited = resolveChatModelForCharacter(configView(ctx.config), character, findEffective);",
     "  void character;\n"
     "  const fallbackName = ctx.config.app.defaults.model;\n"
     "  const inherited = fallbackName === undefined ? undefined : resolve(ctx, fallbackName, true);"),
    ('background: "all" accepts differing models',
     "  if (same) return first;\n\n  const mapping = resolved.map(([task, m])",
     "  if (true as boolean) return first;\n\n  const mapping = resolved.map(([task, m])"),
    ('background: "all" compares qualified names rather than identity',
     "    ([, m]) => m.providerKey === first.providerKey && m.modelId === first.modelId,\n"
     "  );\n  if (same) return first;\n\n  const mapping = resolved.map(([task, m])",
     "    ([, m]) => m.qualifiedName === first.qualifiedName,\n"
     "  );\n  if (same) return first;\n\n  const mapping = resolved.map(([task, m])"),
    ("background: the mismatch message loses the mapping",
     "  const mapping = resolved.map(([task, m]) => `${task} → ${m.qualifiedName}`).join(\", \");",
     '  const mapping = "";'),

    # --- settingTarget ------------------------------------------------------
    ("target: an explicit name beats the background selector",
     '  const selector = asStr(args["background_task"]);\n'
     "  if (selector !== undefined) {\n"
     '    return { kind: "model", model: backgroundSettingTarget(ctx, selector) };\n'
     "  }\n\n"
     '  const name = asName(args["name"]);\n'
     '  if (name !== undefined) return { kind: "model", model: resolve(ctx, name, true) };',
     '  const name = asName(args["name"]);\n'
     '  if (name !== undefined) return { kind: "model", model: resolve(ctx, name, true) };\n\n'
     '  const selector = asStr(args["background_task"]);\n'
     "  if (selector !== undefined) {\n"
     '    return { kind: "model", model: backgroundSettingTarget(ctx, selector) };\n'
     "  }"),
    ("target: an explicit name is ignored",
     '  const name = asName(args["name"]);\n'
     '  if (name !== undefined) return { kind: "model", model: resolve(ctx, name, true) };',
     '  const name = asName(args["name"]);\n  void name;'),
    ("target: a sub-agent selector is ignored",
     '  const subagent = asName(args["subagent"]);\n'
     "  if (subagent !== undefined) return subagentSettingTarget(ctx, subagent);",
     '  const subagent = asName(args["subagent"]);\n  void subagent;'),

    # --- background_models --------------------------------------------------
    ("rows: an unresolvable pin errors instead of echoing the name",
     "  } catch {\n    return name;\n  }\n}",
     "  } catch (e) {\n    throw catalogError(e);\n  }\n}"),
    ("rows: the source always says blanket",
     '    return { role: task, model: qualify(ctx, perTask), source: `defaults.background.${task}` };',
     '    return { role: task, model: qualify(ctx, perTask), source: "defaults.background.model" };'),
    ("rows: the source always says per-task",
     '    return { role: task, model: qualify(ctx, bg.model), source: "defaults.background.model" };',
     '    return { role: task, model: qualify(ctx, bg.model), source: `defaults.background.${task}` };'),
    ("rows: an unresolved inherit still claims to inherit",
     '  return { role: task, model: chat.model, source: chat.model === null ? null : "inherits chat" };',
     '  return { role: task, model: chat.model, source: "inherits chat" };'),
    ("rows: a characterless session still inherits",
     "  if (character === undefined) return undefined;\n"
     "  return resolveChatModelForCharacter(configView(config), character, findEffective);",
     '  return resolveChatModelForCharacter(configView(config), character ?? "", findEffective);'),

    # --- list_models --------------------------------------------------------
    ("list: the hidden count is of what this call returned",
     "  const hiddenCount = (includeHidden\n"
     "    ? entries\n"
     "    : listEffectiveModels(view, ctx.config.dirs.cache, true)\n"
     "  ).filter((e) => e.hidden).length;",
     "  const hiddenCount = entries.filter((e) => e.hidden).length;"),
    ("list: hidden entries are dropped from the count entirely",
     "  ).filter((e) => e.hidden).length;",
     "  ).filter((e) => !e.hidden).length;"),
    ("list: the flag is not echoed back",
     "    include_hidden: includeHidden,",
     "    include_hidden: false,"),
    ("list: a row reports the provider as the sdk",
     "    sdk: m.sdk,\n    provider: m.providerKey,",
     "    sdk: m.providerKey,\n    provider: m.sdk,"),
    ("list: every row claims to be static",
     "    source: entry.source,",
     '    source: "static",'),
    ("list: the hidden marker is dropped",
     "    hidden: entry.hidden,",
     "    hidden: false,"),

    # --- activeName ---------------------------------------------------------
    ("active name: an unresolvable string becomes no active model",
     "    } catch {\n      return fallback;\n    }",
     '    } catch {\n      return "";\n    }'),
    ("active name: the config default is not a fallback",
     "  const fallback = ctx.config.app.defaults.model;\n"
     '  if (fallback !== undefined && fallback !== "") {\n    try {',
     "  const fallback = ctx.config.app.defaults.model;\n"
     "  if (false as boolean) {\n    try {"),
    ("active name: the first entry is not a fallback",
     "  return entries[0]?.resolved.qualifiedName;",
     "  return undefined;"),
    ("active name: the first entry beats the config default",
     "  const fallback = ctx.config.app.defaults.model;\n"
     '  if (fallback !== undefined && fallback !== "") {\n    try {',
     "  if (entries[0] !== undefined) return entries[0].resolved.qualifiedName;\n"
     "  const fallback = ctx.config.app.defaults.model;\n"
     '  if (fallback !== undefined && fallback !== "") {\n    try {'),

    # --- model_info ---------------------------------------------------------
    ("info: the sampler view is attached without a character",
     "  const character = ctx.characterName;\n  if (character !== undefined) {",
     "  const character = ctx.characterName;\n  if (true as boolean) {"),
    ("info: the sampler view is never attached",
     "  if (character !== undefined) {\n    const [global, charPrefs] = loadPreferencesFor(ctx.dataDir, character);",
     "  if (false as boolean) {\n    const [global, charPrefs] = loadPreferencesFor(ctx.dataDir, character!);"),
    ("info: the catalog model is not the static default for the sampler",
     "    data[\"effective_sampler\"] = samplerJson(\n"
     "      resolveSamplerSettings(global, charPrefs, resolved.providerKey, resolved.modelId, resolved),\n"
     "    );",
     "    data[\"effective_sampler\"] = samplerJson(\n"
     "      resolveSamplerSettings(global, charPrefs, resolved.providerKey, resolved.modelId, undefined),\n"
     "    );"),
    ("info: reports all fourteen scopes rather than ten",
     "    data[\"scopes\"] = scopesJson(\n"
     "      resolveSamplerScopes(global, charPrefs, resolved.providerKey, resolved.modelId, resolved),\n"
     "      INFO_SCOPE_FIELDS,\n"
     "    );",
     "    data[\"scopes\"] = scopesJson(\n"
     "      resolveSamplerScopes(global, charPrefs, resolved.providerKey, resolved.modelId, resolved),\n"
     "      SETTINGS_SCOPE_FIELDS,\n"
     "    );"),
    ("info: the character layer is passed as the global one",
     "      resolveSamplerSettings(global, charPrefs, resolved.providerKey, resolved.modelId, resolved),",
     "      resolveSamplerSettings(charPrefs, global, resolved.providerKey, resolved.modelId, resolved),"),

    # --- switch_model / reset_model -----------------------------------------
    ("switch: a missing name is an error rather than a report",
     '  const name = asStr(args["name"]);\n'
     "  if (name === undefined) {\n"
     "    return { active: effectiveChatModel(ctx.config, ctx.characterName)?.qualifiedName ?? null };\n"
     "  }",
     '  const name = asStr(args["name"]);\n'
     '  if (name === undefined) throw invalidRequest("Missing required argument: name");'),
    ("switch: the qualified name is persisted instead of the pair",
     "  prefs.selected.provider = resolved.providerKey;\n  prefs.selected.modelId = resolved.modelId;",
     "  prefs.selected.provider = resolved.providerKey;\n  prefs.selected.modelId = resolved.qualifiedName;"),
    ("switch: the report gives the canonical name, not what was typed",
     "  return {\n    active: name,\n    qualified_name: resolved.qualifiedName,",
     "  return {\n    active: resolved.qualifiedName,\n    qualified_name: resolved.qualifiedName,"),
    ("switch: preferences are written before the model resolves",
     "  const resolved = resolve(ctx, name, includeHidden);\n\n  const character = requireCharacter(ctx);",
     "  const character = requireCharacter(ctx);\n  const resolved = resolve(ctx, name, includeHidden);"),
    ("switch: the write goes to the global file",
     "  saveCharacter(ctx, character, prefs);\n\n  return {\n    active: name,",
     "  saveGlobal(ctx, prefs);\n\n  return {\n    active: name,"),
    ("reset: the selection is not cleared on disk",
     "  prefs.selected = {};\n  saveCharacter(ctx, character, prefs);",
     "  saveCharacter(ctx, character, prefs);"),
    ("reset: the saved selection survives",
     "  const previous = { ...prefs.selected };\n"
     "  prefs.selected = {};\n"
     "  saveCharacter(ctx, character, prefs);",
     "  const previous = { ...prefs.selected };\n  saveCharacter(ctx, character, prefs);"),
    ("reset: it reports the cleared selection as the previous one",
     "  const previous = { ...prefs.selected };\n  prefs.selected = {};",
     "  prefs.selected = {};\n  const previous = { ...prefs.selected };"),

    # --- set_model_setting --------------------------------------------------
    ("set: the key is not trimmed",
     "  const key = rawKey.trim();",
     "  const key = rawKey;"),
    ("set: an unknown key reaches the parser",
     "  if (!SAMPLER_KEYS.includes(key)) {\n"
     "    throw invalidRequest(`unknown setting key: ${key}; supported: ${SAMPLER_KEYS.join(\", \")}`);\n"
     "  }",
     "  if (false as boolean) {\n"
     "    throw invalidRequest(`unknown setting key: ${key}; supported: ${SAMPLER_KEYS.join(\", \")}`);\n"
     "  }"),
    ("set: a missing value is undefined rather than null",
     '  const value = "value" in args ? args["value"] : null;',
     '  const value = args["value"];'),
    ("set: the default scope is global",
     '  const scope = asStr(args["scope"]) ?? "character";',
     '  const scope = asStr(args["scope"]) ?? "global";'),
    ("set: any scope string is accepted",
     '  if (scope !== "character" && scope !== "global") {',
     "  if (false as boolean) {"),
    ("set: the capability check never runs",
     "  const failure = capabilityCheck(model.sdk, key, value, model.capabilities);\n"
     "  if (failure !== undefined) throw failure;",
     "  void capabilityCheck;"),
    ("set: the capability check runs against the active model, not the target",
     "  const failure = capabilityCheck(model.sdk, key, value, model.capabilities);",
     "  const active = resolveActiveModel(ctx);\n"
     "  const failure = capabilityCheck(active.sdk, key, value, active.capabilities);"),
    ("set: a character scope does not require a character",
     '  const character = scope === "character" ? requireCharacter(ctx) : undefined;',
     '  const character = scope === "character" ? ctx.characterName : undefined;'),
    ("set: both scopes write the character file",
     "  if (character === undefined) saveGlobal(ctx, prefs);\n  else saveCharacter(ctx, character, prefs);",
     "  saveCharacter(ctx, character ?? requireCharacter(ctx), prefs);"),
    ("set: the emptied entry is left behind",
     "  if (samplerIsEmpty(entry.sampler)) slot.delete(entryKey);\n  else slot.set(entryKey, entry);",
     "  slot.set(entryKey, entry);"),
    ("set: every entry is dropped, not just the emptied one",
     "  if (samplerIsEmpty(entry.sampler)) slot.delete(entryKey);",
     "  if (samplerIsEmpty(entry.sampler)) slot.clear();"),
    ("set: the entry is keyed by qualified name",
     '    target.kind === "subagent" ? target.subagent : preferenceKey(model.providerKey, model.modelId);',
     '    target.kind === "subagent" ? target.subagent : model.qualifiedName;'),
    ("set: an existing entry is overwritten rather than extended",
     "  const entry = slot.get(entryKey) ?? { sampler: {} };",
     "  const entry = { sampler: {} };"),
    ("set: a sub-agent setting lands in the model slot",
     '      ? prefs.subagents\n      : target.kind === "subagent_model"',
     '      ? prefs.models\n      : target.kind === "subagent_model"'),

    # --- model_settings -----------------------------------------------------
    ("settings: a characterless session still reads the global file",
     "    character === undefined\n"
     "      ? [emptyPreferences(), undefined]\n"
     "      : loadPreferencesFor(ctx.dataDir, character);",
     "    character === undefined\n"
     "      ? [loadGlobalPreferences(ctx), undefined]\n"
     "      : loadPreferencesFor(ctx.dataDir, character);"),
    ("settings: saved_global and saved_character are swapped",
     "    saved_global: saved(global),\n    saved_character: saved(charPrefs),",
     "    saved_global: saved(charPrefs),\n    saved_character: saved(global),"),
    ("settings: an absent saved entry is an empty sampler",
     "    return entry === undefined ? null : samplerJson(entry.sampler);",
     "    return samplerJson(entry?.sampler ?? {});"),
    ("settings: reports the ten info scopes rather than fourteen",
     "    scopes: scopesJson(scopes, SETTINGS_SCOPE_FIELDS),",
     "    scopes: scopesJson(scopes, INFO_SCOPE_FIELDS),"),
    ("settings: the applicability table ignores the model's capabilities",
     "    applicability: keyApplicability(model.sdk, model.capabilities),",
     '    applicability: keyApplicability(model.sdk, undefined),'),
    ("settings: the effort domain ignores the model's capabilities",
     "    reasoning_effort_domain: reasoningDomain(model.sdk, model.capabilities),",
     "    reasoning_effort_domain: reasoningDomain(model.sdk, undefined),"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/model_commands.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
