#!/usr/bin/env python3
"""Mutation pass over the cached last request the keepalive pings: which body
is cached, rebuilds and reprimes, invalidation, and ping outcomes.
"""
import sys

B = "src/cache/rebuild.ts"
L = "src/cache/last_request.ts"
K = "src/commands/keepalive.ts"

MUTANTS = [
    # --- the selection --------------------------------------------------------
    ("selection: between-turns reads the first message, not the last",
     B,
     '  return messages.at(-1)?.role === "assistant";',
     '  return messages.at(0)?.role === "assistant";'),
    ("selection: a user message counts as a boundary too",
     B,
     '  return messages.at(-1)?.role === "assistant";',
     '  return messages.at(-1)?.role !== undefined;'),
    ("selection: a tool-result-only message counts as the user turn",
     B,
     '  const hasUserTurn = messages.some((m) => m.role === "user" && !isToolResultOnly(m));',
     '  const hasUserTurn = messages.some((m) => m.role === "user");'),
    ("selection: an empty conversation is nothing to do",
     B,
     "  if (messages.length > 0 && !historyIsBetweenTurns(messages)) {",
     "  if (!historyIsBetweenTurns(messages)) {"),
    ("selection: a mid-turn conversation with a user turn is rebuilt anyway",
     B,
     "  if (hasUserTurn) {\n    if (!historyIsBetweenTurns(messages)) {",
     "  if (hasUserTurn) {\n    if (false) {"),
    ("selection: the anchor goes after the retained tail",
     B,
     "  return [anchor(), ...messages];",
     "  return [...messages, anchor()];"),
    ("selection: the retained tail is dropped and only the anchor survives",
     B,
     "  return [anchor(), ...messages];",
     "  return [anchor()];"),
    ("selection: the conversation is returned by reference, not copied",
     B,
     "    return [...messages];",
     "    return messages as Message[];"),

    # --- the anchor -----------------------------------------------------------
    ("anchor: no content block, so the turn is empty and anchors nothing",
     B,
     "    content_blocks: [{ type: \"text\", text: IDLE_ANCHOR_TEXT }],",
     "    content_blocks: [],"),
    ("anchor: the block text drifts from the content",
     B,
     "    content_blocks: [{ type: \"text\", text: IDLE_ANCHOR_TEXT }],",
     "    content_blocks: [{ type: \"text\", text: \"[resuming]\" }],"),
    ("anchor: an assistant turn, which is not something to merge into",
     B,
     '    role: "user",\n    content: IDLE_ANCHOR_TEXT,',
     '    role: "assistant",\n    content: IDLE_ANCHOR_TEXT,'),
    ("anchor: the same id every time",
     B,
     "  newId: () => string = () => `m_${randomUUID()}`,",
     '  newId: () => string = () => "m_fixed",'),
    ("anchor: marked autonomous, which would put it in the archive",
     B,
     "    alternatives: [],\n    timestamp: now(),",
     '    alternatives: [],\n    origin: "autonomous",\n    timestamp: now(),'),

    # --- the rebuild ----------------------------------------------------------
    ("rebuild: the MCP tool surface is dropped — the strictly-negative keepalive",
     B,
     "  const mcpToolDefs = deps.mcpRegistry.toolDefsFiltered(toolGrants(config.app.tools));",
     "  const mcpToolDefs: never[] = [];"),
    ("rebuild: prior context is assumed rather than counted",
     B,
     "  const hasPriorContext = (await segmentCount(conversationRef(dataDir, character, thread, false))) > 0;",
     "  const hasPriorContext = true;"),
    ("rebuild: prior context is never assumed",
     B,
     "  const hasPriorContext = (await segmentCount(conversationRef(dataDir, character, thread, false))) > 0;",
     "  const hasPriorContext = false;"),
    ("rebuild: a missing chat model builds on whatever resolves anyway",
     B,
     "  if (resolved === undefined) return undefined;",
     "  if (resolved === undefined) return { model: \"guessed\" } as never;"),
    ("rebuild: the selection's chosen messages are ignored for the raw store",
     B,
     "      selected,\n      hasPriorContext,",
     "      [...store.messages()],\n      hasPriorContext,"),

    # --- the reprime ----------------------------------------------------------
    ("reprime: a failed rebuild leaves the old body armed",
     L,
     '  return rebuilt === undefined\n    ? { kind: "disarm" }',
     '  return false\n    ? { kind: "disarm" }'),
    ("reprime: a successful rebuild disarms",
     L,
     '  return rebuilt === undefined\n    ? { kind: "disarm" }\n    : {',
     '  return true\n    ? { kind: "disarm" }\n    : {'),
    ("reprime: the rebuilt body is not re-cached",
     L,
     "      this.#bodies.set(character, decision.request);\n"
     "      this.#keepalive?.arm(toPrefix(character, decision.request, decision.keepalive, thread));",
     "      this.#keepalive?.arm(toPrefix(character, decision.request, decision.keepalive, thread));"),
    ("reprime: the prefix is armed on main rather than on the thread it rebuilt",
     L,
     "    const thread = deps.thread ?? (await homeThreadOf(dataDir, character));",
     '    const thread = "main";'),
    ("reprime: the caller's thread is ignored in favour of home",
     L,
     "    const thread = deps.thread ?? (await homeThreadOf(dataDir, character));",
     "    const thread = await homeThreadOf(dataDir, character);"),
    ("reprime: the body is rebuilt from a different thread than the prefix names "
     "(EQUIVALENT — rebuildRequestFromDisk falls back to the same homeThreadOf when deps.thread "
     "is absent, so both spellings resolve identically today; the explicit pass-through is kept "
     "so the thread is resolved once and the prefix and the body cannot drift apart if either "
     "fallback ever changes)",
     L,
     "      await rebuildRequestFromDisk(character, dataDir, config, { ...deps, thread }),",
     "      await rebuildRequestFromDisk(character, dataDir, config, deps),"),

    ("rebuild: the warm body ignores the thread's pinned model",
     B,
     "    await threadChatModel(dataDir, character, thread),\n",
     ""),
    ("rebuild: the pin is read for home rather than the thread being rebuilt",
     B,
     "    await threadChatModel(dataDir, character, thread),",
     "    await threadChatModel(dataDir, character),"),

    # --- the cache ------------------------------------------------------------
    ("cache: invalidating also disarms, collapsing the two decisions",
     L,
     "    const had = this.#bodies.delete(character);",
     "    const had = this.#bodies.delete(character);\n    this.#keepalive?.disarm(character);"),
    ("cache: an absent cadence is armed as zero, which spins the loop",
     L,
     "    ...(keepalive.intervalMs === undefined\n"
     "      ? {}\n"
     "      : { keepalive_interval_ms: keepalive.intervalMs }),",
     "    keepalive_interval_ms: keepalive.intervalMs ?? 0,"),
    ("cache: the ping count is dropped, so every model gets the default one",
     L,
     "    ...(keepalive.pings === undefined ? {} : { keepalive_pings: keepalive.pings }),\n",
     ""),
    ("cache: the window is not stamped, so the tracker never learns what keepalive covers",
     L,
     "    context: { ...base, keepalive_window_secs: keepaliveWindowSecs(keepalive.intervalMs, keepalive.pings) },",
     "    context: base,"),
    ("cache: the character is not stamped onto the context",
     L,
     "      : { ...context, character };",
     "      : { ...context };"),
    ("cache: the body is stamped keepalive here as well as on the ping",
     L,
     "      : { ...context, character };",
     '      : { ...context, character, call_type: "keepalive" };'),
    ("cache: the map is shared between instances",
     L,
     "  readonly #bodies = new Map<string, SidecarRequest>();",
     "  readonly #bodies = SHARED;"),

    # --- the ping -------------------------------------------------------------
    ("ping: a budget skip is retried as though it were no_prefix",
     K,
     '  if (outcome.reason === "no_prefix") {',
     "  if (outcome.status === \"skipped\") {"),
    ("ping: the retry is unconditional, so a warm ping fires twice",
     K,
     '  if (outcome.reason === "no_prefix") {',
     "  if (true) {"),
    ("ping: a rebuild that produced nothing asks again anyway",
     K,
     '    if (decision.kind === "disarm") {\n      return { kind: "skipped", detail: "no cached or rebuildable request" };\n    }',
     "    if (false) {\n      return { kind: \"skipped\", detail: \"no cached or rebuildable request\" };\n    }"),
    ("ping: source always reports the cached body",
     K,
     "  let fromCachedRequest = true;",
     "  const fromCachedRequest = true;"),
    ("ping: a zero read with no write is reported as a cold prefix",
     K,
     "    note: ping.cold\n      ? ping.usage.cacheCreationTokens > 0",
     "    note: ping.cold || ping.usage.cacheReadTokens === 0\n      ? ping.usage.cacheCreationTokens > 0"),
    ("ping: an implicit-cache miss claims a write it never paid for",
     K,
     "    note: ping.cold\n      ? ping.usage.cacheCreationTokens > 0",
     "    note: ping.cold\n      ? true"),
    ("ping: an unrecognised status is a failure rather than a skip",
     K,
     '  if (outcome.status === "failed") return { kind: "failed", detail };\n  return { kind: "skipped", detail };',
     '  if (outcome.status === "sent") return { kind: "skipped", detail };\n  return { kind: "failed", detail };'),
    ("ping: missing usage becomes undefined rather than zero",
     K,
     "        inputTokens: usage?.input_tokens ?? 0,",
     "        inputTokens: usage?.input_tokens as number,"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/last_request.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
