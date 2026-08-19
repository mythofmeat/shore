#!/usr/bin/env python3
"""Mutation pass over tool execution (#18 / #12).

Covers `src/tools/execute.ts` — the frames a running tool emits, the cap on
what the model reads, the diagnostics row, and the generated-image side
channel.

Four things the mutants attack:

- **The result string.** That a string value goes through verbatim and
  everything else is serialized, that a failure reports `ToolError`'s `Display`
  and not `Error: <that>`, and that a failure is a *result* rather than a thrown
  turn.
- **The cap.** That it is applied at all, that the per-tool override outranks
  the global, and — the one that matters — that it is applied *before* the
  frame, the diagnostics row and the returned block, rather than to one of them
  and not the others. A cap applied late is invisible until a provider rejects
  an over-long turn.
- **The two frames.** Their order, their field spellings, and that `rid` is
  omitted rather than sent as null. A client correlates on `rid` and renders on
  `tool_id`; either being wrong is a UI that silently shows nothing.
- **The image side channel.** Both gates (`generate_image` by name, success by
  `is_error`), that the ref lands on the last *assistant* turn rather than the
  last message, that the bytes go on the frame and not on the stored ref, and
  that an unreadable path costs the bytes rather than the frame.

A mutant is KILLED if `bun test tests/execute.test.ts` fails with it
applied.

This is **36/39**, from 33/39 on the first pass.

The three that lived the first time were the shape #12 keeps naming — the case
existed and nothing in it was load-bearing:

- **An absent `rid` sent as null on the `send_image` frame.** Every attach case
  carried an rid, so the `skip_serializing_if` branch was never taken on that
  frame. `with no rid the frame leaves the field off` is that case.
- **The scan not stopping at the last assistant turn.** No case had two
  assistant turns, so attaching to *every* one of them looked identical to
  attaching to the last. It is not a hypothetical: a multi-round loop
  accumulates one assistant turn per round, and by round two the mutant would
  hang the image off both. `only the last assistant turn takes the image` is
  that case.
- **The frame announced after the tool ran.** The mutant was broken, not the
  fixture — it relocated the send past the dispatch but not past the image
  attach, so no frame changed places. It now relocates past everything the tool
  does, and dies on the `generate_image` group's frame order.

Three survivors remain, all equivalent, and all kept in the list so a later
reader does not "fix" them:

- **`JSON.stringify(value) ?? ""` losing its fallback.** `dispatchTool` never
  resolves to `undefined` — every handler returns a value or throws — so the
  `??` arm is unreachable from here. Kept because it is what
  `unwrap_or_default()` said, and because the type is `unknown`.
- **The success gate on the image attach.** `!isError` and "there is a value"
  are the same condition: `okValue` is assigned only on the success path, so a
  failed tool reaches `attachGeneratedImage` with `undefined` and returns at the
  first line. The Rust had both guards too, for the same reason and with the
  same redundancy.
- **The `value === null` guard in the attach path.** `typeof null` is
  `"object"`, so without it the next line reads `path` off null and throws
  rather than returning — but nothing that calls through `executeToolUse` can
  produce null. Kept because `attachGeneratedImage` is exported and the fixture
  drives it with exactly those malformed shapes.

Run from the repository root:
    python3 daemon/scripts/mutate_execute.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXECUTE = "src/tools/execute.ts"

# (label, find, replace)
MUTANTS = [
    # ── the result string ───────────────────────────────────────────────
    ("a string result is serialized like everything else",
     'rawOutput = typeof value === "string" ? value : (JSON.stringify(value) ?? "");',
     'rawOutput = JSON.stringify(value) ?? "";'),
    ("a non-string result is stringified rather than serialized",
     'rawOutput = typeof value === "string" ? value : (JSON.stringify(value) ?? "");',
     'rawOutput = typeof value === "string" ? value : String(value);'),
    ("the JSON.stringify fallback is dropped (EQUIVALENT — dispatch never resolves undefined)",
     'rawOutput = typeof value === "string" ? value : (JSON.stringify(value) ?? "");',
     'rawOutput = typeof value === "string" ? value : (JSON.stringify(value) as string);'),
    ("a failure reports String(e), keeping the `Error: ` prefix",
     "rawOutput = e instanceof Error ? e.message : String(e);",
     "rawOutput = String(e);"),
    ("a failure is rethrown instead of becoming a result",
     "    rawOutput = e instanceof Error ? e.message : String(e);\n    isError = true;",
     "    throw e;"),
    ("a failure is reported as a success",
     "    isError = true;\n  }",
     "    isError = false;\n  }"),

    # ── the cap ─────────────────────────────────────────────────────────
    ("the result is not capped at all",
     "  const windowed = windowToolResult(rawOutput, resultCharsFor(exec.limits, toolUse.name));",
     "  const windowed = windowToolResult(rawOutput, 0);"),
    ("the cap ignores the per-tool override",
     "  const windowed = windowToolResult(rawOutput, resultCharsFor(exec.limits, toolUse.name));",
     "  const windowed = windowToolResult(rawOutput, exec.limits.max_result_chars);"),
    ("the block carries the uncapped result",
     'block: { type: "tool_result", tool_use_id: toolUse.id, content: output, is_error: isError },',
     'block: { type: "tool_result", tool_use_id: toolUse.id, content: rawOutput, is_error: isError },'),
    ("the frame carries the uncapped result",
     "  emitToolResult(exec, toolUse, output, isError);",
     "  emitToolResult(exec, toolUse, rawOutput, isError);"),
    ("the block carries the uncapped result, so the next turn resends it in full",
     "    block: { type: \"tool_result\", tool_use_id: toolUse.id, content: output, is_error: isError },",
     "    block: { type: \"tool_result\", tool_use_id: toolUse.id, content: rawOutput, is_error: isError },"),
    ("the deadline is ignored",
     "      timeoutFor(exec.limits, toolUse.name),",
     "      undefined,"),

    # ── the frames ──────────────────────────────────────────────────────
    ("the tool_call frame is not sent",
     '  exec.sendDirect({\n    type: "tool_call",',
     '  ((_: unknown) => {})({\n    type: "tool_call",'),
    # The one long pattern in the list, and it has to be: proving the frame is
    # announced *before* the tool runs means relocating it past the dispatch,
    # and the dispatch is what sits between the two positions.
    # The one long pattern in the list, and it has to be: proving the frame is
    # announced *before* the tool runs means relocating it past everything the
    # tool does, and that is the span between the two positions.
    ("the tool_call frame is sent after the tool ran, not before",
     [("  exec.sendDirect({\n"
       '    type: "tool_call",\n'
       "    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),\n"
       "    tool_id: toolUse.id,\n"
       "    tool_name: toolUse.name,\n"
       "    input: toolUse.input,\n"
       "  });\n\n"
       "  const clock = exec.monotonicMs ?? Date.now;",
       "  const clock = exec.monotonicMs ?? Date.now;"),
      ("  emitToolResult(exec, toolUse, output, isError);",
       "  exec.sendDirect({\n"
       '    type: "tool_call",\n'
       "    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),\n"
       "    tool_id: toolUse.id,\n"
       "    tool_name: toolUse.name,\n"
       "    input: toolUse.input,\n"
       "  });\n"
       "  emitToolResult(exec, toolUse, output, isError);")]),
    ("an absent rid is sent as null on the tool_call frame",
     "    type: \"tool_call\",\n    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),",
     "    type: \"tool_call\",\n    rid: exec.rid ?? null,"),
    ("an absent rid is sent as null on the tool_result frame",
     "    type: \"tool_result\",\n    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),",
     "    type: \"tool_result\",\n    rid: exec.rid ?? null,"),
    ("an absent rid is sent as null on the send_image frame",
     "    type: \"send_image\",\n    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),",
     "    type: \"send_image\",\n    rid: exec.rid ?? null,"),
    ("the tool_result frame carries the tool id as its name",
     "    tool_id: toolUse.id,\n    tool_name: toolUse.name,\n    output,",
     "    tool_id: toolUse.id,\n    tool_name: toolUse.id,\n    output,"),
    ("the tool_result frame reports is_error as false",
     "    output,\n    is_error: isError,",
     "    output,\n    is_error: false,"),
    ("the returned block defaults is_error to false",
     'content: output, is_error: isError },',
     'content: output, is_error: false },'),
    ("the returned block echoes the tool name as the tool_use_id",
     'block: { type: "tool_result", tool_use_id: toolUse.id, content: output,',
     'block: { type: "tool_result", tool_use_id: toolUse.name, content: output,'),

    # ── the diagnostics row ─────────────────────────────────────────────

    # ── the image side channel ──────────────────────────────────────────
    ("any successful tool can attach an image",
     'if (!isError && toolUse.name === "generate_image") {',
     "if (!isError) {"),
    ("a failed generate_image still attaches (EQUIVALENT — the two guards are one "
     "guard: okValue is assigned only on the success path)",
     'if (!isError && toolUse.name === "generate_image") {',
     'if (toolUse.name === "generate_image") {'),
    ("the image lands on the last message, not the last assistant turn",
     '    if (message?.role === "assistant") {\n      message.images.push(image);\n      break;\n    }',
     "    if (message !== undefined) {\n      message.images.push(image);\n      break;\n    }"),
    ("the scan does not stop at the last assistant turn",
     '    if (message?.role === "assistant") {\n      message.images.push(image);\n      break;\n    }',
     '    if (message?.role === "assistant") {\n      message.images.push(image);\n    }'),
    ("the stored ref carries the bytes too",
     "  const image: ImageRef = { path, ...(caption !== undefined ? { caption } : {}) };",
     "  const image: ImageRef = { path, ...(caption !== undefined ? { caption } : {}),\n"
     "    ...(imageDataForPath(path) !== undefined ? { data: imageDataForPath(path) } : {}) };"),
    ("an unreadable path suppresses the frame",
     "  const data = imageDataForPath(path);\n  exec.sendDirect({",
     "  const data = imageDataForPath(path);\n  if (data === undefined) return;\n  exec.sendDirect({"),
    ("a non-string caption is stringified rather than dropped",
     'const caption = typeof fields["caption"] === "string" ? fields["caption"] : undefined;',
     'const caption = fields["caption"] === undefined ? undefined : String(fields["caption"]);'),
    ("a non-string path is accepted",
     'if (typeof path !== "string") return;',
     "if (path === undefined) return;"),
    ("a null value is not guarded (EQUIVALENT — unreachable from executeToolUse)",
     'if (typeof value !== "object" || value === null) return;',
     'if (typeof value !== "object") return;'),

    # ── record_reported_message ─────────────────────────────────────────
    ("the recorded turn takes the role it was not given",
     "    msg_id: exec.newMessageId(),\n    role,",
     '    msg_id: exec.newMessageId(),\n    role: "assistant" as Role,'),
    ("the recorded turn's content excludes tool results",
     "content: deriveContentFromBlocks(blocks, true),",
     "content: deriveContentFromBlocks(blocks, false),"),
    ("the recorded turn's content is left empty",
     "content: deriveContentFromBlocks(blocks, true),",
     'content: "",'),
    ("the recorded turn drops its blocks",
     "    content_blocks: blocks,",
     "    content_blocks: [],"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/execute.test.ts"], src=ROOT / EXECUTE)


if __name__ == "__main__":
    sys.exit(main())
