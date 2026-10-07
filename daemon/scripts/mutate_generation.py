#!/usr/bin/env python3
"""Mutation pass over the generation driver: the order of its phases, the
inputs each is handed, the tool loop, last_request, and the budget gate.
"""
import sys

GEN = "src/handler/generation.ts"
CTX = "src/handler/tool_context.ts"
GENERATE = "src/llm/generate.ts"
RETRY = "src/llm/retry.ts"
CREDS = "src/llm/credentials.ts"

MUTANTS = [
    # --- the order ------------------------------------------------------------
    ("order: stream_end before persistence",
     GEN,
     "  await persistAndNotify(persistCtx, engine, {",
     "  emitPostPersistStreamEnd(turnCtx, engine, params.rid ?? undefined, result);\n"
     "  await persistAndNotify(persistCtx, engine, {"),
    ("order: stream_end is never emitted",
     GEN,
     "  emitPostPersistStreamEnd(turnCtx, engine, params.rid ?? undefined, result);\n",
     ""),
    ("order: the compaction gate runs before the stream",
     GEN,
     "  const { result, intermediate } = await streamTurn(deps, {",
     "  await maybeCompact(turnCtx, engine, charName, config, deps.dataDir,\n"
     "    { usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,\n"
     "      cache_creation_tokens: 0 } } as never, undefined, deps.compaction);\n"
     "  const { result, intermediate } = await streamTurn(deps, {"),
    ("order: the request is assembled before the user turn is recorded",
     GEN,
     "  const regenAlt = await appendUserTurn(turnCtx, engine, config.dirs.cache, charName, body, regen, params.rid, imageSettingsFor(config.app.images, \"upload\"));",
     "  const regenAlt = undefined;"),
    ("order: the user echo loses the request that sent it",
     GEN,
     "  const regenAlt = await appendUserTurn(turnCtx, engine, config.dirs.cache, charName, body, regen, params.rid, imageSettingsFor(config.app.images, \"upload\"));",
     "  const regenAlt = await appendUserTurn(turnCtx, engine, config.dirs.cache, charName, body, regen, null, imageSettingsFor(config.app.images, \"upload\"));"),
    ("order: autonomy is seeded after the request rather than before",
     GEN,
     "  await ensureAndBackfillAutonomy(turnCtx, engine, charName, config);\n",
     ""),
    ("order: a fresh user message never reaches autonomy",
     GEN,
     "  notifyUserMessageIfFresh(turnCtx, engine, charName, body, regen);",
     "  void notifyUserMessageIfFresh;"),

    # --- the turn's inputs ----------------------------------------------------
    ("inputs: the overlay is dropped and the catalog model used raw",
     GEN,
     "  const resolved = resolveGenerationModel(activeModel, config, overlay);",
     "  const resolved = resolveGenerationModel(activeModel, config, {});"),
    ("inputs: the thread's pinned model never reaches the turn",
     GEN,
     "    threadModelOf(deps.registry.listThreads(charName), engine.thread),",
     "    undefined,"),
    ("inputs: the pin is read for home rather than the thread this turn is in",
     GEN,
     "    threadModelOf(deps.registry.listThreads(charName), engine.thread),",
     '    threadModelOf(deps.registry.listThreads(charName), "main"),'),
    ("inputs: a regen sends the whole history, the replaced turn included",
     GEN,
     "    regen,\n    mcpRegistry: deps.mcpRegistry,",
     "    regen: false,\n    mcpRegistry: deps.mcpRegistry,"),
    ("inputs: the rid is not put on the call labels",
     GEN,
     "    ...(rid === null ? {} : { rid }),\n"
     "    ...((usage.budgets ?? []).length === 0 ? {} : { usage }),",
     "    ...((usage.budgets ?? []).length === 0 ? {} : { usage }),"),
    ("inputs: every call is labelled a keepalive rather than a message",
     GEN,
     '    call_type: "message",',
     '    call_type: "keepalive",'),
    ("inputs: the key the attempt used is not stamped on the labels",
     GENERATE,
     "      context: { ...required(request.context), api_key_name: name },",
     "      context: { ...required(request.context), api_key_name: undefined },"),
    ("inputs: the loop's dispatch cap is never set",
     GEN,
     "        call.max_tool_iterations = resolved.maxToolIterations;",
     ""),

    # --- whether the loop runs ------------------------------------------------
    ("loop: tools never run",
     GEN,
     "  const toolsOn = anyToolEnabled(config.app.tools) && (request.tools?.length ?? 0) > 0;",
     "  const toolsOn = false;"),
    ("loop: the tool phase is given a list nothing reads back",
     GEN,
     "      }, intermediate);",
     "      }, []);"),
    ("loop: the turns the loop produced are not persisted",
     GEN,
     "    toolIntermediateMessages: intermediate,",
     "    toolIntermediateMessages: [],"),

    # --- the tool context's paths --------------------------------------------
    ("context: the image dir is the character dir itself",
     CTX,
     '    imageDir: characterMediaDir(dataDir, charName),',
     "    imageDir: charDataDir,"),
    ("context: the workspace is resolved under data rather than config",
     CTX,
     "  const workspaceDir = characterWorkspaceDir(configDir, charName, config.dirs.workspace);",
     "  const workspaceDir = characterWorkspaceDir(dataDir, charName, config.dirs.workspace);"),
    ("context: building the tool context writes the snapshot, ahead of the first message",
     CTX,
     "  const mcp = deps.mcpRegistry;",
     '  await (await import("node:fs/promises")).mkdir(rustJoin(charDataDir, "active_prompt"), {\n'
     "    recursive: true,\n"
     "  });\n"
     "  const mcp = deps.mcpRegistry;"),
    ("context: sub-agents are offered even when none are configured",
     CTX,
     "  const subagentsConfigured = config.app.subagents.size > 0;",
     "  const subagentsConfigured = true;"),
    ("context: image generation resolves but is not wired",
     CTX,
     '    ...("ok" in imageGen ? { imageGenConfig: imageGen.ok } : {}),',
     ""),

    # --- the wire body --------------------------------------------------------
    ("body: the loop's turns are not appended to last_request",
     GEN,
     "  applyIntermediateMessages(request, intermediate, result.model);",
     "  void applyIntermediateMessages;"),
    ("body: the loop's turns are appended twice",
     GEN,
     "  applyIntermediateMessages(request, intermediate, result.model);",
     "  applyIntermediateMessages(request, intermediate, result.model);\n"
     "  applyIntermediateMessages(request, intermediate, result.model);"),
    ("body: an assistant turn from the loop is sent as a user turn",
     GEN,
     '      role: message.role === "assistant" ? "assistant" : "user",',
     '      role: "user",'),
    ("body: an empty reported model is recorded as an empty string",
     GEN,
     '  const mintedModel = resultModel === "" ? undefined : resultModel;',
     "  const mintedModel = resultModel;"),
    ("body: last_request keeps the per-call labels",
     GEN,
     "  const { context: _perCall, ...sentBody } = request;",
     "  const sentBody = request;"),

    # --- the budget gate ------------------------------------------------------
    ("gate: a chat turn is not budget-checked at all",
     GENERATE,
     "    const blocked = budgetBlockFor(call);\n"
     "    if (blocked) throw BudgetBlocked.from(blocked);",
     "    void budgetBlockFor;"),
    ("gate: the check is hoisted above the rotation, before the key is known",
     GENERATE,
     "    const blocked = budgetBlockFor(call);",
     "    const blocked = budgetBlockFor(request);"),
    ("gate: a refusal carries no kind, so rotation burns every key",
     GENERATE,
     '  readonly kind = "budget_blocked" as const;\n',
     ""),
    ("gate: a refusal is retried until the attempt ceiling",
     RETRY,
     '    case "budget_blocked":\n      return FAIL;',
     '    case "budget_blocked":\n      return RETRY;'),
    ("gate: a refusal is treated as a credential failure",
     CREDS,
     '    case "budget_blocked":\n    case "aborted":\n      return "not_credential_failure";',
     '    case "budget_blocked":\n      return "quota_exhausted";\n'
     '    case "aborted":\n      return "not_credential_failure";'),

    # --- which conversation the turn says it belongs to ------------------------
    ("context: the turn is stamped with main rather than the engine's thread",
     GEN,
     "    context: callContext(deps, config, charName, engine.thread, params.rid,",
     '    context: callContext(deps, config, charName, "main", params.rid,'),
    ("context: the thread never reaches the provider",
     GEN,
     '    character: charName,\n    thread,\n    call_type: "message",',
     '    character: charName,\n    call_type: "message",'),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/generation.test.ts", "tests/budget_gate.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
