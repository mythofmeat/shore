#!/usr/bin/env python3
"""Mutation pass over the dispatcher's after-effects (#18 / #12).

Covers `src/handler/command_dispatch.ts`, `restartRequiredChanges` in
`src/config/restart.ts`, and the `historyMessage` extraction in
`src/swp/connection.ts`. Three things these mutants attack:

- **The gates.** Which command each post-processor runs for, and — the one the
  Rust spells out in a sub-expression — that a `config` *read* publishes
  nothing. Also `applied`, which decides between two entirely different reload
  paths.
- **The effects and their order.** The registry before the schedulers, the
  session moved before its history is taken, and `restart_required` computed
  before adoption rather than after, when every comparison is empty.
- **The annotations.** Which keys, from which summary field, merged into what
  the command already wrote rather than replacing it.

A mutant is KILLED if `bun test tests/handler_command_dispatch.test.ts
tests/swp.test.ts tests/swp_transport.test.ts` fails with it applied.
The two SWP files are in because `historyMessage` is now shared with the
handshake, whose wire shape those pin.

This is **27/27**, from 27/28 on the first full pass.

The one survivor is equivalent and was removed:

- **`equal` ignoring a key the right side has and the left does not.** No input
  reaching it can have mismatched key sets. `readStruct` builds every section
  from `make()` and rejects any field it does not know, none of these three
  sections holds a map, and `serializeConfigValue` writes a `None` as `null`
  rather than dropping the key — so both sides always carry exactly the fields
  the defaults declare. The check stays in the source, with that reasoning, on
  the grounds that `equal` is a general comparison.

One more mutant was written, tried and removed for the same reason: returning
`{}` rather than `undefined` from the `config_reload` branch whose file no
longer parses. `afterCommand` spreads an empty object over `data`, which
produces a copy that is structurally the same answer. Only object identity
tells them apart, and no caller has one to compare against.

Run from the repository root:
    python3 daemon/scripts/mutate_command_dispatch.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DISPATCH = "src/handler/command_dispatch.ts"
RESTART = "src/config/restart.ts"
CONNECTION = "src/swp/connection.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- which sections need a restart ----------------------------------------
    ("restart: the listener is not startup-owned", RESTART,
     '  "daemon",\n  "notifications",',
     '  "notifications",'),
    ("restart: notifications are not startup-owned", RESTART,
     '  "notifications",\n  "connections",',
     '  "connections",'),
    ("restart: the connections table is not startup-owned", RESTART,
     '  "connections",\n  "cache.forensics",',
     '  "cache.forensics",'),
    ("restart: the forensics switch is not reported", RESTART,
     '  "cache.forensics",\n] as const;',
     "] as const;"),
    ("restart: a nested key under a restart-owned path does not count", RESTART,
     "  return RESTART_REQUIRED_PATHS.some((path) => key === path || key.startsWith(`${path}.`));",
     "  return RESTART_REQUIRED_PATHS.some((path) => key === path);"),
    ("restart: the fresh config is compared against itself", RESTART,
     "  return RESTART_REQUIRED_PATHS.filter((path) => !same(at(old, path), at(fresh, path))).map(",
     "  return RESTART_REQUIRED_PATHS.filter((path) => !same(at(fresh, path), at(fresh, path))).map("),

    # --- the structural comparison --------------------------------------------
    ("equal: sections are compared by identity, so a duration never matches", RESTART,
     "function same(a: unknown, b: unknown): boolean {\n"
     "  return equal(serializeConfigValue(a), serializeConfigValue(b));",
     "function same(a: unknown, b: unknown): boolean {\n"
     "  return a === b;"),
    ("equal: arrays of different length can match (EQUIVALENT — no field under a "
     "restart-owned path holds a sequence, so the array arm is unreachable from "
     "restartRequiredChanges; it is there because `equal` is generic)", RESTART,
     "      a.length === b.length &&\n      a.every((v, i) => equal(v, b[i]))",
     "      a.every((v, i) => equal(v, b[i]))"),
    # --- the gates -------------------------------------------------------------
    ("gate: a `config` read republishes the config too", DISPATCH,
     'name === "config" && isRecord(args) && typeof args["key"] === "string" && typeof args["value"] === "string"',
     'name === "config" && isRecord(args) && typeof args["key"] === "string"' ),
    ("gate: `switch_character` reads the requested name, not the accepted one", DISPATCH,
     '  const selected = isRecord(data) ? data["character"] : undefined;',
     '  const selected = isRecord(data) ? data["name"] : undefined;'),
    ("gate: any `applied` field counts as an apply", DISPATCH,
     '  const applied = isRecord(data) && data["applied"] === true;',
     '  const applied = isRecord(data) && data["applied"] !== undefined;'),
    ("gate: an answer that is not an object skips its effects", DISPATCH,
     "  const extra = await annotations(name, args, data, ctx);\n"
     "  if (extra === undefined || !isRecord(data)) return data;",
     "  if (!isRecord(data)) return data;\n"
     "  const extra = await annotations(name, args, data, ctx);\n"
     "  if (extra === undefined) return data;"),
    ("gate: an answer that is not an object is annotated anyway", DISPATCH,
     "  if (extra === undefined || !isRecord(data)) return data;",
     "  if (extra === undefined) return data;"),

    # --- the effects, and their order ------------------------------------------
    ("effects: a runtime set never reaches the registry", DISPATCH,
     "  if (ctx.character !== undefined) await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);\n",
     ""),
    ("effects: a runtime set never reaches the schedulers", DISPATCH,
     "  ctx.runtime.reloadRuntimeConfig(ctx.config);\n  return invalidated",
     "  return invalidated"),
    ("effects: the schedulers are updated before the registry", DISPATCH,
     "  if (ctx.character !== undefined) await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);\n"
     "  ctx.runtime.reloadRuntimeConfig(ctx.config);",
     "  ctx.runtime.reloadRuntimeConfig(ctx.config);\n"
     "  if (ctx.character !== undefined) await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);"),
    ("effects: a reset adopts the daemon's config instead of the command's", DISPATCH,
     "  const summary = await ctx.runtime.applyReloadedConfig(fresh);",
     "  const summary = await ctx.runtime.applyReloadedConfig(ctx.runtime.globalConfig());"),
    ("effects: restart_required is computed after the adoption", DISPATCH,
     "  const restart = { restart_required: isRecord(data) && Object.hasOwn(data, \"restart_required\") ? data[\"restart_required\"] : restartRequiredChanges(ctx.runtime.globalConfig(), fresh) };\n"
     "  if (!applied) return restart;\n\n"
     "  const summary = await ctx.runtime.applyReloadedConfig(fresh);",
     "  if (!applied) {\n"
     "    return { restart_required: restartRequiredChanges(ctx.runtime.globalConfig(), fresh) };\n"
     "  }\n\n"
     "  const summary = await ctx.runtime.applyReloadedConfig(fresh);\n"
     "  const restart = { restart_required: isRecord(data) && Object.hasOwn(data, \"restart_required\") ? data[\"restart_required\"] : restartRequiredChanges(ctx.runtime.globalConfig(), fresh) };"),
    ("effects: the check phase compares against the merged config, not the file", DISPATCH,
     "  const fresh = applied ? ctx.config : ctx.runtime.reloadGlobalConfig();",
     "  const fresh = ctx.config;"),
    ("effects: the session is moved after its history is taken", DISPATCH,
     "  ctx.router.setSelectedCharacter(ctx.sessionId, selected);\n\n  let snapshot: HistorySnapshot;",
     "  let snapshot: HistorySnapshot;"),
    ("effects: a history that will not load leaves the session moved anyway", DISPATCH,
     "    ctx.router.setSelectedCharacter(ctx.sessionId, previous);\n    throw e;",
     "    throw e;"),
    ("effects: the switched-to history is never pushed", DISPATCH,
     "  await ctx.router.sendToSession(ctx.sessionId, historyMessage(snapshot, ctx.rid));\n"
     "\n  const config = snapshot.config;",
     "\n  const config = snapshot.config;"),
    ("effects: a thread switch never pushes the new thread's history", DISPATCH,
     "  await ctx.router.sendToSession(ctx.sessionId, historyMessage(snapshot, ctx.rid));\n"
     "  if (!changed) return undefined;\n"
     '  await ctx.runtime.refreshCachedRequest(ctx.character, "thread_change", selected);',
     "  if (!changed) return undefined;\n"
     '  await ctx.runtime.refreshCachedRequest(ctx.character, "thread_change", selected);'),
    ("effects: a thread switch leaves the cached request pointed at the old thread", DISPATCH,
     '  await ctx.runtime.refreshCachedRequest(ctx.character, "thread_change", selected);\n',
     ""),
    ("effects: the cache is repointed but not told which thread", DISPATCH,
     '  await ctx.runtime.refreshCachedRequest(ctx.character, "thread_change", selected);',
     '  await ctx.runtime.refreshCachedRequest(ctx.character, "thread_change");'),
    ("effects: a no-op thread switch still pushes history and reprimes", DISPATCH,
     '  if (!changed && !resync) return undefined;\n',
     ""),
    ("effects: explicit resync still skips the current thread's history", DISPATCH,
     '  if (!changed && !resync) return undefined;',
     '  if (!changed) return undefined;'),
    ("effects: resync reprimes the cache without a thread change", DISPATCH,
     '  if (!changed) return undefined;\n',
     ""),
    ("effects: a failed thread snapshot leaves the session on the new thread", DISPATCH,
     "  } catch (e) {\n    ctx.router.setSelectedThread(ctx.sessionId, previous);\n    throw e;\n  }",
     "  } catch (e) {\n    throw e;\n  }"),

    ("effects: pinning a thread's model leaves the warm request on the old one", DISPATCH,
     '  await ctx.runtime.refreshCachedRequest(ctx.character, "model_change", pinned);\n',
     ""),
    ("effects: pinning any thread reprimes, even one nobody is in", DISPATCH,
     "  const live =\n"
     "    ctx.router.threadFor(ctx.sessionId) ?? ctx.runtime.homeThread(ctx.character);\n"
     "  if (pinned !== live) return undefined;\n",
     ""),
    ("effects: a session that never chose a thread is treated as being nowhere", DISPATCH,
     "    ctx.router.threadFor(ctx.sessionId) ?? ctx.runtime.homeThread(ctx.character);",
     "    ctx.router.threadFor(ctx.sessionId);"),
    ("effects: the pin always reprimes home, not the thread that was pinned", DISPATCH,
     '  await ctx.runtime.refreshCachedRequest(ctx.character, "model_change", pinned);',
     '  await ctx.runtime.refreshCachedRequest(ctx.character, "model_change");'),

    # --- the annotations -------------------------------------------------------
    ("annotate: `invalidated` replaces what the command wrote", DISPATCH,
     '  const prev = isRecord(data) && isRecord(data["invalidated"]) ? data["invalidated"] : {};',
     "  const prev = {};"),
    ("annotate: discovery is always reported as changed", DISPATCH,
     "      character_discovery: summary.characterDiscoveryChanged,",
     "      character_discovery: true,"),
    ("annotate: a missing active_model comes back absent rather than null", DISPATCH,
     '    active_model: (isRecord(config) ? config["active_model"] : undefined) ?? null,',
     '    active_model: isRecord(config) ? config["active_model"] : undefined,'),

    # --- the history frame -----------------------------------------------------
    ("frame: the pushed history always carries a rid", CONNECTION,
     "    ...(rid === undefined ? {} : { rid }),",
     "    rid: rid ?? null,"),
    ("frame: active_start is on the wire at zero", CONNECTION,
     "    ...(history.activeStart === 0 ? {} : { active_start: history.activeStart }),",
     "    active_start: history.activeStart,"),
]

TESTS = [
    "tests/command_path.test.ts",
    "tests/handler_command_dispatch.test.ts",
    "tests/swp.test.ts",
    "tests/swp_transport.test.ts",
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
