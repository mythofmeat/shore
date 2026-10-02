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
`DiscoveredModelSupport`, which reaches the table only from a discovery cache; the
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

#117 unified the target flags, so `switch_model` and `reset_model` now write
sub-agent keys the way they already wrote background ones, `model_info` follows
a role instead of a name, and a bare `model_settings` answers with the overview
of every role. Twenty-five mutants cover that. Four were real gaps on the first
run: pinning one sub-agent by name never proved it left another's pin alone; the
one erroring role in the overview was also non-inherited, so the error branch of
the filter was dead; and no sub-agent shared a model with chat, so keying its
settings by name and keying them by model agreed.

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
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel, ctx.preferences);\n"
     "  if (resolved !== undefined) return resolved;",
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel, ctx.preferences);\n"
     "  void resolved;"),
    ("active: the thread's pin is dropped, so a side thread reports the character's model",
     "function resolveActiveModel(ctx: ModelsContext): ResolvedModel {\n"
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel, ctx.preferences);",
     "function resolveActiveModel(ctx: ModelsContext): ResolvedModel {\n"
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName, undefined, ctx.preferences);"),
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
    ('background: the per-task pin is ignored',
     '  const pinned = ctx.config.app.defaults.background[task];',
     '  const pinned = undefined;'),
    ('background: the inherited model ignores the character preference',
     "    : resolveChatModelForCharacter(\n"
     "      configView(ctx.config), ctx.characterName, findEffective,\n"
     "      task === \"compaction\" ? ctx.threadModel : ctx.homeThreadModel, ctx.preferences,\n"
     "    );",
     '    : resolve(ctx, ctx.config.app.defaults.model ?? "", true);'),
    ("background: the heartbeat target ignores the home thread's pin",
     '      task === "compaction" ? ctx.threadModel : ctx.homeThreadModel, ctx.preferences,',
     '      task === "compaction" ? ctx.threadModel : undefined, ctx.preferences,'),
    ("background: the heartbeat role ignores the home thread's pin",
     "  if (ctx.homeThreadModel === undefined) return character ?? inheritedChatRole(ctx);",
     "  if (true as boolean) return character ?? inheritedChatRole(ctx);"),
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
     '    return { role: task, model: qualify(ctx, perTask), source: `${task}.model` };',
     '    return { role: task, model: qualify(ctx, perTask), source: "defaults.background.model" };'),
    ("rows: the chat row hides the pin, so a side thread reads as the character's",
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel, ctx.preferences);\n"
     "  if (resolved !== undefined) {\n"
     "    return {\n"
     "      role: \"chat\",",
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName, undefined, ctx.preferences);\n"
     "  if (resolved !== undefined) {\n"
     "    return {\n"
     "      role: \"chat\","),
    ("rows: the chat row credits the character even when a thread pinned it",
     "      source: ctx.threadModel === undefined ? \"character\" : `thread ${ctx.thread ?? \"\"}`.trim(),",
     "      source: \"character\","),
    ("active: the listing's active name ignores the thread's pin",
     "function activeName(ctx: ModelsContext): string | undefined {\n"
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel, ctx.preferences);",
     "function activeName(ctx: ModelsContext): string | undefined {\n"
     "  const resolved = effectiveChatModel(ctx.config, ctx.characterName, undefined, ctx.preferences);"),
    ("switch: a shadowed switch is reported as if it took effect",
     "    ...(ctx.threadModel === undefined ? {} : { shadowed_by_thread: ctx.thread ?? null }),",
     "    ...{},"),

    ("rows: an unresolved inherit still claims to inherit",
     '  return { role: task, model: chat.model, source: chat.model === null ? null : "inherits chat" };',
     '  return { role: task, model: chat.model, source: "inherits chat" };'),
    ("rows: a characterless session still inherits",
     "  if (character === undefined) return undefined;\n"
     "  return resolveChatModelForCharacter(configView(config), character, findEffective, threadModel, preferences);",
     '  return resolveChatModelForCharacter(configView(config), character ?? "", findEffective, threadModel, preferences);'),
    ("rows: the pin never reaches the resolver, so it can only ever be the character's",
     "  return resolveChatModelForCharacter(configView(config), character, findEffective, threadModel, preferences);",
     "  return resolveChatModelForCharacter(configView(config), character, findEffective);"),

    # --- list_models --------------------------------------------------------
    ("list: the hidden count is of what this call returned",
     "  const hiddenCount = all.filter(\n"
     "    (e) => e.hidden && !favorites.has(e.resolved.qualifiedName),\n"
     "  ).length;",
     "  const hiddenCount = shown.filter((e) => e.hidden).length;"),
    ("list: hidden entries are dropped from the count entirely",
     "    (e) => e.hidden && !favorites.has(e.resolved.qualifiedName),",
     "    (e) => !e.hidden && !favorites.has(e.resolved.qualifiedName),"),
    ("list: the flag is not echoed back",
     "    include_hidden: includeHidden,",
     "    include_hidden: false,"),
    ("list: a row reports the provider as the sdk",
     "    sdk: m.sdk,",
     "    sdk: m.providerKey,"),
    ("list: rows are grouped under the sdk rather than the provider",
     "    (out[entry.resolved.providerKey] ??= []).push(effectiveModelToJson(entry, favorites));",
     "    (out[entry.resolved.sdk] ??= []).push(effectiveModelToJson(entry, favorites));"),
    ("list: every row claims to be static",
     "    source: entry.source,",
     '    source: "static",'),
    ("list: the hidden marker is dropped",
     "    hidden: entry.hidden,",
     "    hidden: false,"),

    # --- activeName ---------------------------------------------------------
    ("active name: an unresolvable string becomes no active model",
     "  } catch {\n    return fallback;\n  }",
     '  } catch {\n    return "";\n  }'),
    ("active name: the config default is not a fallback",
     "  const fallback = ctx.config.app.defaults.model;\n"
     '  if (fallback === undefined || fallback === "") {',
     "  const fallback = ctx.config.app.defaults.model;\n"
     "  if (true as boolean) {"),
    ("active name: the first catalog entry is not a fallback",
     "    return firstChatModel(ctx.config.models)?.qualifiedName;",
     "    return undefined;"),
    ("active name: the first catalog entry beats the config default",
     "  const fallback = ctx.config.app.defaults.model;\n"
     '  if (fallback === undefined || fallback === "") {',
     "  const first = firstChatModel(ctx.config.models);\n"
     "  if (first !== undefined) return first.qualifiedName;\n"
     "  const fallback = ctx.config.app.defaults.model;\n"
     '  if (fallback === undefined || fallback === "") {'),

    # --- favorites ----------------------------------------------------------
    ("favorites: the mark is never set on a row",
     "    favorite: favorites.has(m.qualifiedName),",
     "    favorite: false,"),
    ("favorites: every row is marked",
     "    favorite: favorites.has(m.qualifiedName),",
     "    favorite: true,"),
    ("favorites: --favorites is ignored and lists everything",
     "    if (favoritesOnly) return favorite;",
     "    if (false as boolean) return favorite;"),
    ("favorites: the narrowed view keeps everything but favorites",
     "    if (favoritesOnly) return favorite;",
     "    if (favoritesOnly) return !favorite;"),
    ("favorites: an ignore glob buries a favorite again",
     "    return includeHidden || !e.hidden || favorite;",
     "    return includeHidden || !e.hidden;"),
    ("favorites: the flag is not echoed back",
     "    favorites_only: favoritesOnly,",
     "    favorites_only: false,"),
    ("favorites: the count is of the rows shown rather than what is saved",
     "    favorite_count: favorites.size,",
     "    favorite_count: shown.length,"),
    ("favorites: a provider with discovery off loses its favorites",
     "  const all = [...walked, ...favoritesOutsideTheWalk(ctx, view, favorites, walked)];",
     "  const all = [...walked];"),
    ("favorites: a favorite in the walk is listed a second time",
     "      if (seen.has(resolved.qualifiedName)) continue;",
     "      if (false as boolean) continue;"),
    ("favorites: a favorite that resolves nowhere is surfaced as a ghost",
     "    } catch {\n      continue;\n    }\n  }\n  return out;",
     "    } catch {\n      out.push({ source: \"favorite\", resolved: { qualifiedName: favorite } as ResolvedModel, hidden: false });\n    }\n  }\n  return out;"),
    ("favorites: a favorite is written to the character rather than globally",
     "  if (changed) saveGlobal(ctx, prefs);",
     "  if (changed) saveCharacter(ctx, requireCharacter(ctx), prefs);"),
    ("favorites: the direction the caller asked for is ignored",
     '  const want = asBool(args["favorite"]) ?? !isFavorite(prefs, resolved.qualifiedName);',
     "  const want = !isFavorite(prefs, resolved.qualifiedName);"),
    ("favorites: an already-favorited model reports a write that did not happen",
     "  const changed = want\n"
     "    ? addFavorite(prefs, resolved.qualifiedName)\n"
     "    : removeFavorite(prefs, resolved.qualifiedName);",
     "  const changed = true;\n"
     "  if (want) addFavorite(prefs, resolved.qualifiedName);\n"
     "  else removeFavorite(prefs, resolved.qualifiedName);"),
    ("favorites: a hidden model cannot be favorited",
     '  const resolved = resolve(ctx, name, true);\n  const prefs = loadGlobalPreferences(ctx);',
     '  const resolved = resolve(ctx, name, false);\n  const prefs = loadGlobalPreferences(ctx);'),

    # --- model_info ---------------------------------------------------------
    ('info: global sampler preferences are hidden without a character',
     '  data["effective_sampler"] = settings.effective_sampler;',
     '  data["effective_sampler"] = ctx.characterName === undefined ? {} : settings.effective_sampler;'),
    ('info: the sampler view is never attached',
     '  data["effective_sampler"] = settings.effective_sampler;',
     '  data["effective_sampler"] = {};'),
    ('info: a role is inspected as a plain model',
     '  const settings = modelSettingsDetail(ctx, args, target);',
     '  const settings = modelSettingsDetail(ctx, { name: target.model.qualifiedName });'),
    ('roles: background and subagent inheritance follows a thread pin',
     '  const inherited = inheritedChatRole(ctx);',
     '  const inherited = chatRole(ctx);'),
    ('info: scope annotations are discarded',
     '  data["scopes"] = Object.fromEntries(INFO_SCOPE_FIELDS.map(([key]) => [key, settings.scopes[key] ?? null]));',
     '  data["scopes"] = {};'),

    # --- switch_model / reset_model -----------------------------------------
    ('switch: a missing name is an error rather than a report',
     '  const name = asStr(args["name"]);\n'
     '  if (name === undefined) {\n'
     '    return {\n'
     '      target: "current",\n'
     '      active:\n'
     '        effectiveChatModel(ctx.config, ctx.characterName, ctx.threadModel, ctx.preferences)?.qualifiedName ?? null,\n'
     '    };\n'
     '  }',
     '  const name = asStr(args["name"]);\n'
     '  if (name === undefined) throw invalidRequest("Missing required argument: name");'),
    ("switch: the qualified name is persisted instead of the pair",
     "  prefs.selected.provider = resolved.providerKey;\n  prefs.selected.modelId = resolved.modelId;",
     "  prefs.selected.provider = resolved.providerKey;\n  prefs.selected.modelId = resolved.qualifiedName;"),
    ('switch: the report gives the canonical name, not what was typed',
     '  return {\n'
     '    target: "character",\n'
     '    active: name,',
     '  return {\n'
     '    target: "character",\n'
     '    active: resolved.qualifiedName,'),
    ("switch: preferences are written before the model resolves",
     "  const resolved = resolve(ctx, name, includeHidden);\n\n  const character = requireCharacter(ctx);",
     "  const character = requireCharacter(ctx);\n  const resolved = resolve(ctx, name, includeHidden);"),
    ('switch: the write goes to the global file',
     '  saveCharacter(ctx, character, prefs);\n'
     '\n'
     '  return {\n'
     '    target: "character",\n'
     '    active: name,',
     '  saveGlobal(ctx, prefs);\n'
     '\n'
     '  return {\n'
     '    target: "character",\n'
     '    active: name,'),
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
     "  const key = canonicalSettingKey(rawKey.trim());",
     "  const key = canonicalSettingKey(rawKey);"),
    ("set: an unknown key reaches the parser",
     "  if (!SAMPLER_KEYS.includes(key)) {\n"
     "    throw invalidRequest(`unknown setting key: ${key}; supported: ${SAMPLER_KEYS.join(\", \")}`);\n"
     "  }",
     "  if (false as boolean) {\n"
     "    throw invalidRequest(`unknown setting key: ${key}; supported: ${SAMPLER_KEYS.join(\", \")}`);\n"
     "  }"),
    ("set: a missing value is undefined rather than null",
     '  const rawValue = args.value ?? null;',
     '  const rawValue = args.value;'),
    ("set: the default scope is global",
     '  const scope = asStr(args["scope"]) ?? "character";',
     '  const scope = asStr(args["scope"]) ?? "global";'),
    ("set: any scope string is accepted",
     '  if (scope !== "character" && scope !== "global") {',
     "  if (false as boolean) {"),
    ("set: the capability check never runs",
     "  const failure = capabilityCheck(sdk, key, value, model.support, model.modelId);\n"
     "  if (failure !== undefined) throw failure;",
     "  void capabilityCheck;"),
    ("set: the capability check runs against the active model, not the target",
     "  const failure = capabilityCheck(sdk, key, value, model.support, model.modelId);",
     "  const active = resolveActiveModel(ctx);\n"
     "  const failure = capabilityCheck(active.sdk, key, value, active.support);"),
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
    ("settings: global model preferences disappear without a character",
     "  const [global, savedCharacter] = prepared.preferences;",
     "  const [global, savedCharacter] = prepared.preferences;\n  if (ctx.characterName === undefined) global.models.clear();"),
    ("overview: global model preferences disappear without a character",
     "      : loadPreferencesFor(ctx.dataDir, character);\n"
     "\n"
     "  const claimed =",
     "      : loadPreferencesFor(ctx.dataDir, character);\n"
     "\n"
     "  if (character === undefined) global.models.clear();\n"
     "  const claimed ="),
    ("settings: saved_global and saved_character are swapped",
     "    saved_global: saved(global),\n    saved_character: saved(charPrefs),",
     "    saved_global: saved(charPrefs),\n    saved_character: saved(global),"),
    ("settings: an absent saved entry is an empty sampler",
     "    return entry === undefined ? null : samplerJson(entry.sampler);",
     "    return samplerJson(entry?.sampler ?? {});"),
    ("settings: reports the ten info scopes rather than fourteen",
     "    scopes: scopesJson(scopes, SETTINGS_SCOPE_FIELDS),",
     "    scopes: scopesJson(scopes, INFO_SCOPE_FIELDS),"),
    ("settings: the schema ignores discovered model support",
     "    setting_schema: settingSchema(sdkFromWire(sampler.sdk ?? model.sdk) ?? model.sdk, model.support, model.modelId),",
     "    setting_schema: settingSchema(sdkFromWire(sampler.sdk ?? model.sdk) ?? model.sdk, undefined, model.modelId),"),

    # --- sub-agent pins (#117) ----------------------------------------------
    ("sub-agent pin: a named sub-agent writes the shared default",
     '  const key = selector === ALL_SUBAGENTS ? SUBAGENT_MODEL_KEY : subagentModelKey(selector);',
     "  const key = SUBAGENT_MODEL_KEY;"),
    ("sub-agent pin: `all` writes one sub-agent's own key",
     '  const key = selector === ALL_SUBAGENTS ? SUBAGENT_MODEL_KEY : subagentModelKey(selector);',
     "  const key = subagentModelKey(selector);"),
    ("sub-agent pin: an unknown name is accepted",
     "  if (selector !== ALL_SUBAGENTS) requireSubagent(ctx, selector);\n"
     '  const includeHidden = asBool(args["include_hidden"]) ?? false;',
     '  const includeHidden = asBool(args["include_hidden"]) ?? false;'),
    ("sub-agent pin: `all` leaves the per-sub-agent overrides in place",
     "  const overridden = selector === ALL_SUBAGENTS ? subagentsWithOwnModel(ctx) : [];",
     "  const overridden: string[] = [];"),
    ("sub-agent pin: a named target also clears the overrides",
     "  const overridden = selector === ALL_SUBAGENTS ? subagentsWithOwnModel(ctx) : [];",
     "  const overridden = subagentsWithOwnModel(ctx);"),
    ("sub-agent pin: sub-agents without their own model are cleared too",
     "  return [...ctx.config.app.subagents.entries()]\n"
     "    .filter(([, spec]) => spec.model !== undefined)\n"
     "    .map(([name]) => name)",
     "  return [...ctx.config.app.subagents.entries()]\n"
     "    .map(([name]) => name)"),
    ("sub-agent unpin: `all` clears only the shared default",
     "      ? [SUBAGENT_MODEL_KEY, ...subagentsWithOwnModel(ctx).map(subagentModelKey)]",
     "      ? [SUBAGENT_MODEL_KEY]"),
    ("sub-agent unpin: `all` misses the shared default",
     "      ? [SUBAGENT_MODEL_KEY, ...subagentsWithOwnModel(ctx).map(subagentModelKey)]",
     "      ? subagentsWithOwnModel(ctx).map(subagentModelKey)"),
    ("sub-agent unpin: an unknown name is accepted",
     "  if (selector !== ALL_SUBAGENTS) requireSubagent(ctx, selector);\n"
     "  const config = configContext(ctx);",
     "  const config = configContext(ctx);"),
    ("sub-agent role: every selector reads as the shared one",
     "  return selector === ALL_SUBAGENTS ? \"sub-agents\" : `sub-agent: ${selector}`;",
     '  return "sub-agents";'),

    # --- info by role (#117) -------------------------------------------------
    ("info: a role flag is ignored in favour of the active model",
     "  return asName(args[\"subagent\"]) !== undefined || asStr(args[\"background_task\"]) !== undefined;",
     "  return false;"),
    ("info: naming both a model and a role is allowed",
     "  if (name !== undefined && byRole) {\n"
     '    throw invalidRequest("name a model or name a role, not both");\n'
     "  }",
     "  void byRole;"),

    # --- the settings overview (#117) ---------------------------------------
    ("overview: a role that only inherits is listed anyway",
     '    row.role === "chat" || row.error !== null || !row.inherited || row.settings.length > 0;',
     "    true;"),
    ("overview: a tuned role is hidden because it inherits its model",
     '    row.role === "chat" || row.error !== null || !row.inherited || row.settings.length > 0;',
     '    row.role === "chat" || row.error !== null || !row.inherited;'),
    ("overview: a role that cannot resolve is dropped silently",
     '    row.role === "chat" || row.error !== null || !row.inherited || row.settings.length > 0;',
     '    row.role === "chat" || !row.inherited || row.settings.length > 0;'),
    ("overview: an inherited model reads as its own",
     '      inherited: slot.source === null || slot.source.startsWith("inherits"),',
     "      inherited: slot.source === null,"),
    ("overview: the global file wins over the character's",
     '  collect(global, "global");\n  collect(charPrefs, "character");',
     '  collect(charPrefs, "character");\n  collect(global, "global");'),
    ("overview: only the character's own settings are reported",
     '  collect(global, "global");\n  collect(charPrefs, "character");',
     '  collect(charPrefs, "character");'),
    ("overview: a sub-agent reads the settings of the model it runs on",
     "    case \"subagent\":\n      return subagentPreference(prefs, target.subagent);",
     "    case \"subagent\":\n"
     "      return modelPreference(prefs, target.model.providerKey, target.model.modelId);"),
    ("overview: two roles on one model are never told they share it",
     "    const sharesWith = identity === undefined ? null : (claimed.get(identity) ?? null);",
     "    const sharesWith = null;\n    void identity;"),
    ("overview: a sub-agent shares its identity with its model",
     "    case \"subagent\":\n      return `subagent:${target.subagent}`;",
     "    case \"subagent\":\n      return `model:${key}`;"),

    # --- naming one setting (#117) ------------------------------------------
    ("show: an unknown key is accepted",
     "  if (SAMPLER_KEYS.includes(key)) return key;",
     "  return key;"),
    ("show: a sub-agent's name in the key slot gets the generic error",
     "  if (ctx.config.app.subagents.has(key)) {\n"
     "    throw invalidRequest(\n"
     "      `${key} is a sub-agent, not a setting; write --subagent=${key} to target it`,\n"
     "    );\n"
     "  }\n",
     ""),
    ("show: the requested key never reaches the response",
     "    ...(only === undefined ? {} : { key: only }),",
     "    ...{},"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(
        MUTANTS,
        [
            "tests/model_commands.test.ts",
            "tests/subagent_model_pin.test.ts",
            "tests/background_model_pin.test.ts",
            "tests/model_favorites.test.ts",
        ],
        src=SRC,
    )


if __name__ == "__main__":
    sys.exit(main())
