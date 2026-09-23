#!/usr/bin/env python3
"""Mutation pass over the heartbeat's request preparation (#18 / #12).

Two groups, and they fail in different currencies.

**The override** decides which model a heartbeat costs money on. Every mutant
here still produces a request that runs — what changes is *which* model runs it,
and the failure mode is a user who configured a background model, sees ticks
happening, and is billed on their chat model all along. The pre-check mutants
matter most: `resolveBackgroundModel` falls back silently by design, and this is
the one caller that must not let it.

**The preparation** decides what the request contains. The expensive one is the
copy — the cached body is chat's own history and the object every keepalive ping
refreshes, so a tick that appends to it in place leaves the cache holding a
prefix no real turn extends. Nothing throws, nothing logs; the provider just
starts charging cache-write prices.

A mutant is KILLED if `bun test tests/heartbeat_request.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_heartbeat_request.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
H = "src/autonomy/heartbeat_request.ts"

TESTS = ["tests/heartbeat_request.test.ts"]

PRECHECK = (
    "  try {\n"
    "    findEffectiveModel(view, config.dirs.cache, configuredName, true);\n"
    "  } catch (e) {\n"
    "    shoreLog.warn(\n"
    '      `shore: heartbeat model "${configuredName}" not found in catalog for ${character}; ` +\n'
    "        `keeping chat model: ${String(e)}`,\n"
    "    );\n"
    "    return { request, override: undefined };\n"
    "  }"
)

BUILD_INPUTS = (
    "        messages: request.messages,\n"
    "        ...(request.system === undefined ? {} : { system: request.system }),\n"
    "        ...(request.tools === undefined ? {} : { tools: request.tools }),\n"
    "        replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),"
)

CAP = (
    "    override !== undefined\n"
    "      ? override.maxToolIterations\n"
    "      : resolveChatModelForCharacter(\n"
    "          configView(config),\n"
    "          character,\n"
    "          (v, c, n, h) => findEffectiveModel(v, c, n, h),\n"
    "          await threadChatModel(config.dirs.data, character, thread),\n"
    "        )?.maxToolIterations;"
)

# (label, file, find, replace)
MUTANTS = [
    # --- the override ---------------------------------------------------------
    ("override: no pre-check, so a typo'd pin silently resolves to the chat model",
     H, PRECHECK, "  void configuredName;"),
    ("override: the pre-check uses the static catalog, rejecting every modern pin",
     H, PRECHECK,
     "  try {\n"
     "    findModel(config.models, configuredName);\n"
     "  } catch (e) {\n"
     "    shoreLog.warn(`shore: heartbeat model not found: ${String(e)}`);\n"
     "    return { request, override: undefined };\n"
     "  }"),
    ("override: a same-ID alias silently loses its configured settings",
     H,
     "  if (resolved === undefined) return { request, override: undefined };",
     "  if (resolved === undefined || resolved.modelId === request.model) return { request, override: undefined };"),
    ("override: a missing key ends the tick instead of falling back to chat",
     H,
     "  } catch (e) {\n"
     "    shoreLog.warn(\n"
     "      `shore: heartbeat could not build a request on ${resolved.name} for ${character}, ` +\n"
     "        `falling back to the chat model: ${String(e)}`,\n"
     "    );\n"
     "    return { request, override: undefined };\n"
     "  }",
     "  } catch (e) {\n"
     "    throw e;\n"
     "  }"),
    ("override: the swapped body drops chat's messages, losing the cache prefix",
     H, BUILD_INPUTS,
     "        messages: [],\n"
     "        ...(request.system === undefined ? {} : { system: request.system }),\n"
     "        ...(request.tools === undefined ? {} : { tools: request.tools }),\n"
     "        replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),"),
    ("override: the swapped body drops the system prefix",
     H, BUILD_INPUTS,
     "        messages: request.messages,\n"
     "        ...(request.tools === undefined ? {} : { tools: request.tools }),\n"
     "        replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),"),
    ("override: the swapped body drops the tool definitions",
     H, BUILD_INPUTS,
     "        messages: request.messages,\n"
     "        ...(request.system === undefined ? {} : { system: request.system }),\n"
     "        replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),"),
    ("override: the provider entry is dropped, so `[providers].keys` is ignored",
     H,
     "      entry === undefined ? undefined : credentialEntry(entry),",
     "      undefined,"),

    # --- preparing the body ---------------------------------------------------
    ("prepare: the cached body is appended to in place, rewriting chat's history",
     H,
     "  const copy: SidecarRequest = { ...request, messages: [...request.messages] };",
     "  const copy: SidecarRequest = request;"),
    ("prepare: the copy shares its messages array, so the prompt lands in the cache",
     H,
     "  const copy: SidecarRequest = { ...request, messages: [...request.messages] };",
     "  const copy: SidecarRequest = { ...request };"),
    ("prepare: the stale chat request id rides along into every heartbeat round",
     H,
     "  request.context = {\n    ...request.context,",
     '  request.context = {\n    ...request.context,\n    rid: deps.cache.get(character)?.context?.rid,'),
    ("prepare: the tick is not labelled a heartbeat in the ledger",
     H,
     '    call_type: "heartbeat",',
     '    call_type: "message",'),
    ("prepare: a cold rebuild is not cached, so keepalive pings no-op until a user speaks",
     H,
     "    deps.cache.set(character, source, {\n"
     "      intervalMs: rebuilt.keepalive_interval_ms,\n"
     "      pings: rebuilt.keepalive_pings,\n"
     "    }, false);",
     "    void rebuilt.keepalive_interval_ms;"),
    ("prepare: the rebuilt body is armed without the model's ping count",
     H,
     "      pings: rebuilt.keepalive_pings,",
     "      pings: undefined,"),
    ("prepare: the body carrying the heartbeat prompt is what gets cached",
     H,
     "  pushInlineSystem(request, prompt);",
     "  pushInlineSystem(request, prompt);\n"
     "  deps.cache.set(character, request, undefined);"),
    ("prepare: a mid-turn conversation ticks anyway on an empty body",
     H,
     "  if (rebuilt === undefined) {\n"
     "    shoreLog.info(\n"
     "      `shore: heartbeat skipping tick for ${character} (conversation mid-turn or model unresolved)`,\n"
     "    );\n"
     "    return undefined;\n"
     "  }",
     "  if (rebuilt === undefined) return { request: { messages: [] } as never, maxToolIterations: undefined, override: undefined, thread, conversation: [] };"),
    ("prepare: the round cap always comes from the chat model, not the one running",
     H, CAP,
     "    resolveChatModelForCharacter(\n"
     "      configView(config),\n"
     "      character,\n"
     "      (v, c, n, h) => findEffectiveModel(v, c, n, h),\n"
     "      await threadChatModel(config.dirs.data, character, thread),\n"
     "    )?.maxToolIterations;"),
    ("prepare: the round cap ignores the home thread's pinned model",
     H,
     "          await threadChatModel(config.dirs.data, character, thread),\n",
     ""),
    ("prepare: the round cap is unlimited whenever no override applies",
     H, CAP, "    override?.maxToolIterations;"),
    ("prepare: the prompt is never pinned, so the tick is an ordinary chat turn",
     H,
     "  pushInlineSystem(request, prompt);",
     "  void prompt;"),
    # --- how the interval is said ---------------------------------------------
    ("interval: whole hours are said in minutes",
     H,
     "  if (secs >= SECONDS_PER_HOUR && secs % SECONDS_PER_HOUR === 0n) {",
     "  if (false as boolean) {"),
    ("interval: a single hour is said as '1 hours'",
     H,
     "    return hours === 1n ? \"1 hour\" : `${hours} hours`;",
     "    return `${hours} hours`;"),
    ("interval: a non-whole hour count is rounded up rather than truncated",
     H,
     "  return `${secs / SECONDS_PER_MINUTE} minutes`;",
     "  return `${(secs + SECONDS_PER_MINUTE - 1n) / SECONDS_PER_MINUTE} minutes`;"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
