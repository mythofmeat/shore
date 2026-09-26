#!/usr/bin/env python3
"""Exercise shared manual-tool media, correlation and browser activity ownership."""
import sys
from mutation import run

T = "src/commands/run_tool.ts"
O = "src/browser/operations.ts"
W = "src/browser/workspace.ts"
MUTANTS = [
    ("manual tool frames not forwarded", T, 'ctx.emit?.(message);', ''),
    ("manual image result omitted", T, '...(images.length === 0 ? {} : { images })', '...{}'),
    ("prepared bytes replace live original", T, 'data: original?.data ?? image.data ?? null', 'data: image.data ?? null'),
    ("byte-free image update loses data", T, 'data: frame.data ?? images.get(frame.path)?.data ?? null', 'data: frame.data ?? null'),
    ("byte-free image update loses caption", T, 'caption: frame.caption ?? images.get(frame.path)?.caption ?? null', 'caption: frame.caption ?? null'),
    ("image frames lose request correlation", 'src/handler/commands.ts', '    case "send_image":\n      return { ...frame, rid };', '      return { ...frame, rid };'),
    ("progress callback gets another request", O, ' || update.message.rid !== rid', ''),
    ("progress callback omitted", O, 'options.observe?.(update.message);', ''),
    ("completed operation remains active", O, 'if (rid !== undefined) this.#requests.delete(rid);', ''),
    ("manual tools create phantom chat", W, 'manual && next.subagent === null ? this.#state.streams :', ''),
    ("manual subagent remains live after completion", W, ' || this.actions.pendingOperation(message.rid) === "run_tool"', ''),
    ("manual image adopted by chat history", 'src/browser/media.ts', 'image.manual === true || ', ''),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/run_tool_command.test.ts", "tests/command_path.test.ts", "tests/web_transport.test.ts", "tests/browser_media.test.ts"]))
