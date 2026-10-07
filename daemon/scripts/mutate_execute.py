#!/usr/bin/env python3
"""Mutation pass over `tools/execute.ts`: how a result or failure reaches the
model, the result cap and deadline, the frames a running tool emits, tool
media and attached images, and the turns it records.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXECUTE = "src/tools/execute.ts"

MUTANTS = [
    # ── the result string ───────────────────────────────────────────────
    ("a string result is serialized like everything else",
     'rawOutput = joinLines([formatToolOutput(toolUse.name, okValue), ...(payload?.extra ?? [])]);',
     'rawOutput = joinLines([JSON.stringify(okValue) ?? "", ...(payload?.extra ?? [])]);'),
    ("a non-string result is stringified rather than serialized",
     'rawOutput = joinLines([formatToolOutput(toolUse.name, okValue), ...(payload?.extra ?? [])]);',
     'rawOutput = joinLines([typeof okValue === "string" ? okValue : String(okValue),\n'
     '      ...(payload?.extra ?? [])]);'),
    ("a media payload is read as its own wrapper rather than unwrapped",
     "    okValue = payload === undefined ? value : payload.value;",
     "    okValue = value;"),
    ("the media payload's extra lines never reach the model",
     'rawOutput = joinLines([formatToolOutput(toolUse.name, okValue), ...(payload?.extra ?? [])]);',
     'rawOutput = formatToolOutput(toolUse.name, okValue);'),
    ("a failure reports String(e), keeping the `Error: ` prefix",
     "rawOutput = e instanceof Error ? e.message : String(e);",
     "rawOutput = String(e);"),
    ("a failure is rethrown instead of becoming a result",
     "    rawOutput = e instanceof Error ? e.message : String(e);",
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
     "  const content = toolResultContent(windowed, [...(payload?.notes ?? []), ...attached.notes], attached.placed);",
     "  const content = toolResultContent({ ...windowed, output: rawOutput }, [...(payload?.notes ?? []), ...attached.notes], attached.placed);"),
    ("the frame carries the uncapped result",
     "  emitToolResult(exec, toolUse, output, isError, attached.images);",
     "  emitToolResult(exec, toolUse, rawOutput, isError, attached.images);"),
    ("the deadline is ignored",
     "      timeoutFor(exec.limits, toolUse.name),",
     "      undefined,"),

    # ── the frames ──────────────────────────────────────────────────────
    ("the tool_call frame is not sent",
     '  exec.sendDirect({\n    type: "tool_call",',
     '  ((_: unknown) => {})({\n    type: "tool_call",'),
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
      ("  emitToolResult(exec, toolUse, output, isError, attached.images);",
       "  exec.sendDirect({\n"
       '    type: "tool_call",\n'
       "    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),\n"
       "    tool_id: toolUse.id,\n"
       "    tool_name: toolUse.name,\n"
       "    input: toolUse.input,\n"
       "  });\n"
       "  emitToolResult(exec, toolUse, output, isError, attached.images);")]),
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
     "    ...(images.length > 0 ? { images } : {}),\n    is_error: isError,",
     "    ...(images.length > 0 ? { images } : {}),\n    is_error: false,"),
    ("the returned block defaults is_error to false",
     "      content,\n      is_error: isError,",
     "      content,\n      is_error: false,"),
    ("the returned block echoes the tool name as the tool_use_id",
     "      tool_use_id: toolUse.id,\n      content,",
     "      tool_use_id: toolUse.name,\n      content,"),

    # ── tool media ──────────────────────────────────────────────────────
    ("the tool result drops the media it attached",
     "  const content = toolResultContent(windowed, [...(payload?.notes ?? []), ...attached.notes], attached.placed);",
     "  const content = toolResultContent(windowed, [...(payload?.notes ?? []), ...attached.notes], []);"),
    ("the attachment notes never reach the model",
     "  const content = toolResultContent(windowed, [...(payload?.notes ?? []), ...attached.notes], attached.placed);",
     "  const content = toolResultContent(windowed, [...(payload?.notes ?? [])], attached.placed);"),
    ("the tool's own media notes never reach the model",
     "  const content = toolResultContent(windowed, [...(payload?.notes ?? []), ...attached.notes], attached.placed);",
     "  const content = toolResultContent(windowed, [...attached.notes], attached.placed);"),
    ("attached images do not consume the cumulative byte budget",
     "      inlinedBytes += bytes;",
     "      inlinedBytes += 0;"),
    ("the count cap on inlined images is not applied",
     "    if (attached.placed.length >= MAX_INLINE_TOOL_IMAGES || inlinedBytes >= maxBytes) {",
     "    if (inlinedBytes >= maxBytes) {"),
    ("the size cap on inlined images is not applied",
     "      if (bytes > maxBytes - inlinedBytes) {",
     "      if (false) {"),
    ("the budget counts source bytes instead of the prepared bytes the model receives",
     "      const bytes = base64Bytes(block.source.data);",
     "      const bytes = base64Bytes(item.data);"),
    ("skipped images are not reported",
     "  if (skipped.length > 0) attached.notes.push(skippedNote(skipped, maxBytes));",
     "  if (false) attached.notes.push(skippedNote(skipped, maxBytes));"),
    ("attached media is never written to disk",
     "    await writeFile(target, bytes);",
     "    await Promise.resolve();"),
    ("a failed media save is reported as a successful saved-image delivery",
     "    const unsaved = saved === undefined ? [",
     "    const unsaved = false ? ["),
    ("an image's own notes are left with the general notes instead of beside it",
     "    const caption = joinLines([...text, ...image.notes]);",
     "    const caption = joinLines(text);"),
    ("a placed image goes to the end instead of after its line",
     "  const fits = (at: number | undefined): at is number => !windowed.truncated && at !== undefined && at <= windowed.output.length;",
     "  const fits = (at: number | undefined): at is number => false;"),
    ("a placed image stays mid-text in a truncated result",
     "  const fits = (at: number | undefined): at is number => !windowed.truncated && at !== undefined && at <= windowed.output.length;",
     "  const fits = (at: number | undefined): at is number => at !== undefined && at <= windowed.output.length;"),
    ("the text after a placed image starts over from the top",
     "    cursor = at;",
     "    cursor = 0;"),
    ("the line before a placed image keeps its newline",
     '    text.push(windowed.output.slice(cursor, at).replace(/\\n$/, ""));',
     "    text.push(windowed.output.slice(cursor, at));"),
    ("the client is never told about a tool's image",
     '      exec.sendDirect({\n        type: "send_image",',
     '      ((_: unknown) => {})({\n        type: "send_image",'),
    ("an attached image loses the media type the server gave it",
     "  const source = { type: \"base64\" as const, media_type: item.mime_type, data: item.data };",
     "  const source = { type: \"base64\" as const, media_type: \"application/octet-stream\", data: item.data };"),

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


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(
        MUTANTS, ["tests/execute.test.ts", "tests/mcp_media.test.ts"], src=ROOT / EXECUTE
    )


if __name__ == "__main__":
    sys.exit(main())
