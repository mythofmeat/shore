#!/usr/bin/env python3
"""Mutation pass over the generation driver (#18 / #12).

The driver is ordering. Almost nothing in it computes a value — it decides what
happens before what, and which of two things a phase is handed — so a fixture
that only checked the frames would pass with the tool context wired to the
wrong directory, with the loop mutating the request the keepalive later clones,
or with `stream_end` going out before the turn was durable. That last one is
the bug the whole arrangement exists to prevent.

The mutants cover five things:

- **The order.** `stream_end` after persistence, the compaction gate last, the
  user turn recorded before the request is assembled from it.
- **The turn's inputs.** Which model, which history a regen sends, whether the
  loop runs at all, and the cap on how long it runs for.
- **The tool context's paths.** Every one of them is a string built from the
  character name and a root, and swapping two of them puts a character's
  workspace where nothing reads it.
- **The wire body.** That the loop's turns are appended to `last_request` once,
  with the provider off the request and the model off the result.
- **The failure paths.** A stream that errors persists nothing, and a retry
  starts the turn's tool record over rather than appending to it.

A mutant is KILLED if `bun test tests/generation_parity.test.ts` fails with it
applied.

This is **28/28**, from 24/29 on the first pass.

Five survivors, and the split was the usual one — three cases present with
nothing load-bearing in them, and two lines that did not need to exist:

- **Autonomy, twice.** Nothing checked that the driver seeds the tracker or
  tells it the user spoke; deleting either call changed no frame. The replay
  now asserts the whole call sequence, and says why it is not fixture-driven.
- **The sampler overlay.** No recorded case has one — the generator handed the
  Rust a model its handler had already merged — so dropping the overlay on the
  floor was invisible. There is a separate turn in the replay for it now.
- **The key name on the call labels.** Equivalent, because `callContext` set it
  from the assembly-time key and the per-attempt copy then overwrote it with
  the key that was actually used. The dead line is gone and the mutant is aimed
  at the one that does the work.
- **The `anyEnabled` gate on the tool loop.** Genuinely equivalent: the tool
  surface is built from the same config, so it is empty in exactly the cases
  the gate refuses. Removed from the list; both checks stay in the source
  because they fail differently if the surface builder ever changes.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_generation.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GEN = "src/handler/generation.ts"
CTX = "src/handler/tool_context.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the order ------------------------------------------------------------
    ("order: stream_end before persistence",
     GEN,
     "  await persistAndNotify(persistCtx, engine, {",
     "  emitPostPersistStreamEnd(turnCtx, engine, params.rid ?? undefined, result);\n"
     "  await persistAndNotify(persistCtx, engine, {"),
    ("order: stream_end is never emitted",
     GEN,
     "  emitPostPersistStreamEnd(turnCtx, engine, params.rid ?? undefined, result);\n\n  await maybeCompact(",
     "  await maybeCompact("),
    ("order: the compaction gate runs before the stream",
     GEN,
     "  const { result, intermediate } = await streamTurn(deps, {",
     "  await maybeCompact(turnCtx, engine, charName, config, deps.dataDir,\n"
     "    { usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,\n"
     "      cache_creation_tokens: 0 } } as never, undefined, deps.compaction);\n"
     "  const { result, intermediate } = await streamTurn(deps, {"),
    ("order: the request is assembled before the user turn is recorded",
     GEN,
     "  const regenAlt = await appendUserTurn(turnCtx, engine, deps.dataDir, charName, body, regen);",
     "  const regenAlt = undefined;"),
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
    ("inputs: a regen sends the whole history, the replaced turn included",
     GEN,
     "    regen,\n    mcpRegistry: deps.mcpRegistry,",
     "    regen: false,\n    mcpRegistry: deps.mcpRegistry,"),
    ("inputs: the rid is not put on the call labels",
     GEN,
     "    ...(rid === null ? {} : { rid }),\n    ...(usage === undefined ? {} : { usage }),",
     "    ...(usage === undefined ? {} : { usage }),"),
    ("inputs: every call is labelled a keepalive rather than a message",
     GEN,
     '    call_type: "message",',
     '    call_type: "keepalive",'),
    ("inputs: the key the attempt used is not stamped on the labels",
     GEN,
     "        : { context: { ...request.context, api_key_name: candidate.name } }),",
     "        : { context: { ...request.context } }),"),
    ("inputs: the loop's dispatch cap is never set",
     GEN,
     "      ...(toolCtx === undefined || resolved.maxToolIterations === undefined\n"
     "        ? {}\n"
     "        : { max_tool_iterations: resolved.maxToolIterations }),",
     ""),

    # --- whether the loop runs ------------------------------------------------
    ("loop: tools never run",
     GEN,
     "  const toolsOn = anyEnabled(config.app.tools) && (request.tools?.length ?? 0) > 0;",
     "  const toolsOn = false;"),
    ("loop: the tool phase is given a list nothing reads back",
     GEN,
     "    intermediate = messages;",
     "    intermediate = [];"),
    ("loop: the turns the loop produced are not persisted",
     GEN,
     "    toolIntermediateMessages: intermediate,",
     "    toolIntermediateMessages: [],"),

    # --- the tool context's paths --------------------------------------------
    ("context: the image dir is the character dir itself",
     CTX,
     '    imageDir: rustJoin(charDataDir, "images"),',
     "    imageDir: charDataDir,"),
    ("context: the workspace is resolved under data rather than config",
     CTX,
     "  const workspaceDir = characterWorkspaceDir(configDir, charName);",
     "  const workspaceDir = characterWorkspaceDir(dataDir, charName);"),
    ("context: the memory index is resolved under config rather than cache",
     CTX,
     "    memoryIndexPath: indexPath(config.dirs.cache, charName),",
     "    memoryIndexPath: indexPath(config.dirs.config, charName),"),
    ("context: the active-prompt snapshot is never written",
     CTX,
     "    await ensureActivePromptSnapshot(charDataDir, configDir, charName);",
     "    void ensureActivePromptSnapshot;"),
    ("context: an embedder failure fails the turn instead of degrading",
     CTX,
     "  } catch (e) {\n    console.warn(\n      `shore: embedder unavailable for ${charName}; semantic memory retrieval disabled: ${String(e)}`,\n    );\n  }",
     "  } catch (e) {\n    throw e;\n  }"),
    ("context: sub-agents are offered even when none are configured",
     CTX,
     "  const subagentsConfigured = config.app.subagents.size > 0;",
     "  const subagentsConfigured = true;"),
    ("context: the retrieval mode is hard-coded to lexical",
     CTX,
     "    retrievalMode: config.app.memory.retrieval.mode,",
     '    retrievalMode: "lexical",'),
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
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/generation_parity.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    originals = {p: (ROOT / p).read_text() for p in {GEN, CTX}}
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, path, find, replace) in enumerate(MUTANTS, 1):
        original = originals[path]
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        (ROOT / path).write_text(original.replace(find, replace, 1))
        killed = not run()
        (ROOT / path).write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    for path, text in originals.items():
        (ROOT / path).write_text(text)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
