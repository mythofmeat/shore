#!/usr/bin/env python3
"""Mutation pass over the sub-agent's nested loop driver (#18, step 5).

`subagent.ts` decides what the sub-agent is *told* and is pinned by its own
fixture. This covers the driving, where four kinds of mistake are all silent.

**The recursion cap.** It is not a depth counter; it is an absent field. The
nested loop runs against the parent context with `runSubagent` removed, and the
offered tool subset never contains `ask_*` because sub-agent tools are not in
the static registry. Either one alone holds the cap — which is the point, since
a spread that reintroduces the field is one character's difference.

**The model chain.** Spec → `defaults.subagent_model` → `defaults.model`, and
it stops. Chaining on to the active chat model would invert the feature's whole
purpose — delegation exists to land on something cheap — while looking exactly
like it worked, on the expensive model, in the bill.

**The request shape.** The system prompt goes top-level, before the query, with
the system role intact. The call is typed `subagent` so its spend is
attributable rather than folded into the turn that delegated.

**The tag.** Every frame the nested loop emits carries the sub-agent's name. An
untagged frame is rendered by the client as the *primary* model's output, so a
sub-agent's working notes would read as the character talking.

A mutant is KILLED if `bun test tests/subagent_loop.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_subagent_loop.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = "src/tools/subagent_loop.ts"

TESTS = ["tests/subagent_loop.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the recursion cap ----------------------------------------------------
    ("cap: the nested context keeps runSubagent, so a sub-agent can delegate",
     S,
     "  const { runSubagent: _dropped, ...rest } = ctx;\n  return { ...rest,",
     "  return { ...ctx,"),
    ("cap: runSubagent is present but undefined, which is not the same absence",
     S,
     "  const { runSubagent: _dropped, ...rest } = ctx;\n  return { ...rest,",
     "  return { ...ctx, runSubagent: undefined,"),
    ("cap: an unknown tool name is offered rather than skipped, so ask_* gets through",
     S,
     "  const subset = subagentToolSubset(\n    spec.tools,\n    ALL_TOOLS,",
     "  const subset = subagentToolSubset(\n    spec.tools,\n"
     "    [...ALL_TOOLS, ...spec.tools.map((n) => ({ name: n, description: n, parameters: {} }))],"),

    # --- the model chain ------------------------------------------------------
    ("model: no model anywhere is not an error, so it falls through to a default",
     S,
     "  if (modelName === undefined) throw new InvalidArgs(missingModelMessage(name));",
     '  if (modelName === undefined) throw new InvalidArgs("no model");'),
    ("model: the spec's own model is ignored in favour of the defaults",
     S,
     "  const modelName = resolveSubagentModel(spec.model, {",
     "  const modelName = resolveSubagentModel(undefined, {"),
    ("model: defaults.subagent_model is dropped from the chain",
     S,
     "    ...(config.app.defaults.subagent_model === undefined\n"
     "      ? {}\n"
     "      : { subagent_model: config.app.defaults.subagent_model }),",
     "    // dropped"),

    # --- the request ----------------------------------------------------------
    ("request: the system prompt is inlined after the query instead of top-level",
     S,
     '      system: [{ text: systemText, label: "system" }],',
     "      // dropped"),
    ("request: the prompt is not rendered, so {{char}} reaches the model literally",
     S,
     "  const systemText = expandPromptMacros(renderTemplate(spec.prompt, vars), {",
     "  const systemText = expandPromptMacros(spec.prompt, {"),
    ("request: the macros are expanded before the var pass, reopening the file-read hole",
     S,
     "  const systemText = expandPromptMacros(renderTemplate(spec.prompt, vars), {",
     "  const systemText = renderTemplate(expandPromptMacros(spec.prompt, {"),
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
     "      TAGGED_FRAMES.has(message.type)\n"
     "        ? ({ ...message, subagent: name } as ServerMessage)\n"
     "        : message,",
     "      message,"),
    ("tag: every frame type is tagged, including those the field means nothing for",
     S,
     "      TAGGED_FRAMES.has(message.type)",
     "      true"),
    ("tag: the tag is the wrong name, so two sub-agents in one turn are indistinguishable",
     S,
     "        ? ({ ...message, subagent: name } as ServerMessage)",
     '        ? ({ ...message, subagent: "subagent" } as ServerMessage)'),
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


def run_tests() -> bool:
    """True when the suite passes."""
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=180,
    )
    return proc.returncode == 0


def main() -> int:
    if not run_tests():
        print("baseline is red — fix the suite before mutating", file=sys.stderr)
        return 2

    survivors = []
    for i, (label, rel, find, replace) in enumerate(MUTANTS, start=1):
        path = ROOT / rel
        original = path.read_text()
        if find not in original:
            print(f"{i:3}. ERROR mutant does not apply: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        if original.count(find) != 1:
            print(f"{i:3}. ERROR mutant is ambiguous: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        path.write_text(original.replace(find, replace))
        try:
            killed = not run_tests()
        except subprocess.TimeoutExpired:
            killed = True
        finally:
            path.write_text(original)
        print(f"{i:3}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append(label)

    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} killed")
    for label in survivors:
        print(f"  SURVIVOR: {label}")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
