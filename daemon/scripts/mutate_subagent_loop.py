#!/usr/bin/env python3
"""Mutation pass over the sub-agent's nested loop driver: its tool cap, model
resolution, request shape, and frame tags.
"""
import sys

S = "src/tools/subagent_loop.ts"

TESTS = ["tests/subagent_loop.test.ts"]

MACRO_INPUT = (
    "  const systemText = await expandPromptMacros(renderTemplate(spec.prompt, vars), {\n"
    "    thread: deps.ctx.thread ?? MAIN_THREAD,\n"
    "    characterDataDir: deps.ctx.characterDataDir,\n"
    "    workspaceDir: deps.ctx.workspaceDir,\n"
    "    history: (deps.conversation ?? deps.ctx.conversation ?? []).slice(-MAX_HISTORY_MESSAGES),\n"
    "    charName,\n"
    "    userName: displayName,\n"
    "  });"
)

MUTANTS = [
    # --- the recursion cap ----------------------------------------------------
    ("cap: the nested context keeps runSubagent, so a sub-agent can delegate",
     S,
     "  const { runSubagent: _dropped, scheduleNextWake: _unscheduled, ...rest } = ctx;\n  return { ...rest,",
     "  return { ...ctx,"),
    ("cap: runSubagent is present but undefined, which is not the same absence",
     S,
     "  const { runSubagent: _dropped, scheduleNextWake: _unscheduled, ...rest } = ctx;\n  return { ...rest,",
     "  return { ...ctx, runSubagent: undefined,"),
    ("cap: the nested context keeps the heartbeat schedule, so a sub-agent moves its parent's wake",
     S,
     "runSubagent: _dropped, scheduleNextWake: _unscheduled, ...rest",
     "runSubagent: _dropped, ...rest"),
    ("cap: an unknown tool name is offered rather than skipped, so ask_* gets through",
     S,
     "  const subset = subagentToolSubset(\n    spec.tools,\n    ALL_TOOLS,",
     "  const subset = subagentToolSubset(\n    spec.tools,\n"
     "    [...ALL_TOOLS, ...spec.tools.map((n) => ({ name: n, description: n, parameters: {} }))],"),

    # --- the model chain ------------------------------------------------------
    ("model: no model anywhere is not an error, so it falls through to a default",
     S,
     "  if (catalogModel === undefined) throw new InvalidArgs(missingModelMessage(name, charName));",
     '  if (catalogModel === undefined) throw new InvalidArgs("no model");'),
    ("model: the spec's own model is ignored in favour of the defaults",
     S,
     "      configView(config),\n      charName,\n      spec.model,",
     "      configView(config),\n      charName,\n      undefined,"),
    ("model: defaults.subagent_model is dropped from the chain",
     "src/config/preferences.ts",
     "  const configured = specModel ?? config.app.defaults.subagent_model;",
     "  const configured = specModel;"),

    # --- the request ----------------------------------------------------------
    ("request: the system prompt is inlined after the query instead of top-level",
     S,
     '      system: [{ text: systemText, label: "system" }],',
     "      // dropped"),
    ("request: the prompt is not rendered, so {{char}} reaches the model literally",
     S,
     "  const systemText = await expandPromptMacros(renderTemplate(spec.prompt, vars), {",
     "  const systemText = await expandPromptMacros(spec.prompt, {"),
    ("request: file and history contents are reinterpreted as template variables",
     S, MACRO_INPUT,
     MACRO_INPUT.replace("await expandPromptMacros(renderTemplate(spec.prompt, vars), {",
                         "renderTemplate(await expandPromptMacros(spec.prompt, {")
                .replace("  });", "  }), vars);")),
    ("request: the query is not the message, so the sub-agent is asked nothing",
     S,
     '      messages: [{ role: "user", content: [{ type: "text", text: query }] }],',
     '      messages: [{ role: "user", content: [{ type: "text", text: "" }] }],'),
    ("request: the call is typed as an ordinary message, hiding sub-agent spend",
     S,
     '      call_type: "subagent",',
     '      call_type: "message",'),
    ("request: the ledger row is attributed to no character",
     S,
     "      character: charName,",
     '      character: "",'),
    ("request: the iteration cap is dropped, so a sub-agent loops to the model's own bound",
     S,
     "  const maxIterations = spec.max_iterations ?? resolved.maxToolIterations;",
     "  const maxIterations = resolved.maxToolIterations;"),

    # --- the tag --------------------------------------------------------------
    ("tag: frames go out untagged and read as the character talking",
     S,
     "    if (!TAGGED_FRAMES.has(message.type)) {",
     "    if (true as boolean) {"),
    ("tag: every frame type is tagged, including those the field means nothing for",
     S,
     "    if (!TAGGED_FRAMES.has(message.type)) {",
     "    if (false as boolean) {"),
    ("tag: the tag is the wrong name, so two sub-agents in one turn are indistinguishable",
     S,
     "      subagent: name,\n      ...(taskId === undefined ? {} : { task_id: taskId }),",
     '      subagent: "subagent",\n      ...(taskId === undefined ? {} : { task_id: taskId }),'),
    ("tag: a background context forwards to nothing, throwing instead of dropping",
     S,
     "  if (sendDirect === undefined) return () => {};",
     "  if (sendDirect === undefined) return () => { throw new Error('no channel'); };"),

    # --- resolution failures --------------------------------------------------
    ("resolve: an unconfigured sub-agent runs anyway rather than reporting NotImplemented",
     S,
     "  if (spec === undefined) throw new NotImplemented(`ask_${name}`);",
     "  if (spec === undefined) return '';"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
