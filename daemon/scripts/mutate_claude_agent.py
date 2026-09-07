#!/usr/bin/env python3
"""Mutation pass over what the Agent SDK provider considers "the same message".

The Agent SDK owns conversation history; shore only remembers a hash per message
so it can tell, next turn, whether the incoming history still extends what the
session was given. Everything downstream rests on that comparison: an exact
prefix resumes the session, a divergence forks it at an assistant uuid, and no
common prefix cold starts and replays the whole conversation as text.

So a hash that is too coarse does not throw — it silently claims two different
conversations are one. The original hash was taken over text blocks only, which
meant a turn was identified by its words and nothing else: two messages differing
only by the image attached were the same message, and once tool calls exist, an
assistant turn is identified by prose it may not even have.

That is the shape of every mutant in the first group. Each removes one field from
the fingerprint, and the evidence a test can hold is only that two messages
differing in exactly that field stay told apart.

The whitespace mutant is the subtle one. A block list is hashed twice at
different moments — once when the turn is recorded, once when it comes back on
the wire — and `handler/wire_messages.ts` drops whitespace-only text blocks in
between. Hashing without the same filter makes the two disagree, and the symptom
is not a wrong answer but an unexplained cold start.

The version mutants guard the upgrade itself: a book written under the old hash
must not be read under the new one, because its entries would never match and
the mismatch would look like a divergence rather than a stale book.

The second half of the pass covers the turn itself. The provider reads a stream
it does not own: the SDK emits raw Anthropic events for the model's own output,
assistant frames that are one content block each, frames belonging to agents the
SDK ran by itself, and a final result. Each mutant here confuses one of those for
another, and none of them throws — a dropped signature, a stop reason read from
the wrong place, or a nested agent's words taken for the reply all produce a turn
that looks finished.

The options group is the one that fails open. Turning a built-in tool surface
back on, or letting the harness compact the history behind shore's back, costs
tokens and correctness on every turn while every test still passes unless the
options themselves are asserted.

The last group is the tool name table. The CLI namespaces every MCP tool as
`mcp__<server>__<tool>` and there is no way to advertise a bare one, so a shore
tool is known by two names at once: the one the model calls and the one
`tools/dispatch.ts` switches on. Getting the translation wrong is quiet in a
particular way — `runToolUse` looks up a tool's schema, its result cap and its
timeout by name and falls back to defaults on a miss, so a leaked prefix means a
subagent runs with no argument validation and the global timeout rather than its
configured hour, and nothing is logged.

The loop group is about the shape of what a tool-using turn writes down.
`engine/merge.ts` folds an assistant turn holding tool_use blocks, a user turn
holding their results, and a final assistant turn back into one logical turn, and
regeneration and alt-switching both rest on that grouping. Recording the pair out
of order, recording the final reply twice, or letting an earlier round's prose
into the finished turn each produce a conversation that reads correctly once and
comes apart when it is edited.

A mutant is KILLED if the tests listed in TESTS fail with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_claude_agent.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
AGENT = "src/llm/providers/claude_agent.ts"
SESSIONS = "src/llm/providers/agent_sessions.ts"
TOOLS = "src/llm/providers/claude_agent_tools.ts"
CREDENTIALS = "src/llm/credentials.ts"
REQUEST = "src/llm/request.ts"

TESTS = [
    "tests/claude_agent_sessions.test.ts",
    "tests/claude_agent_stream.test.ts",
    "tests/claude_agent_tools.test.ts",
    "tests/claude_agent_loop.test.ts",
    "tests/request.test.ts",
]

# (label, file, find, replace)
MUTANTS = [
    # --- what identifies a message -------------------------------------------
    ("hash: an image contributes nothing, so two different pictures are one turn",
     AGENT,
     "      return `image:${block.source.media_type}:${digest(block.source.data)}`;",
     "      return `image:${block.source.media_type}`;"),
    ("hash: the image's type is dropped, so a png and a jpeg of it are one turn",
     AGENT,
     "      return `image:${block.source.media_type}:${digest(block.source.data)}`;",
     "      return `image:${digest(block.source.data)}`;"),
    ("hash: a tool call is identified by its name alone, whatever it was asked to do",
     AGENT,
     "      return `tool_use:${block.id}:${block.name}:${canonicalJson(block.input)}`;",
     "      return `tool_use:${block.id}:${block.name}`;"),
    ("hash: a tool result is identified by which call it answers, not by what it said",
     AGENT,
     "      return `tool_result:${block.tool_use_id}:${block.is_error === true ? \"1\" : \"0\"}:${digest(body)}`;",
     "      return `tool_result:${block.tool_use_id}:${digest(body)}`;"),
    ("hash: a failed tool call reads the same as one that succeeded",
     AGENT,
     "      return `tool_result:${block.tool_use_id}:${block.is_error === true ? \"1\" : \"0\"}:${digest(body)}`;",
     "      return `tool_result:${block.tool_use_id}:${block.is_error === true ? \"1\" : \"0\"}`;"),
    ("hash: the role is dropped, so a question and its echo back are one message",
     AGENT,
     "  return digest([msg.role, ...hashableBlocks(msg).map(blockFingerprint)].join(SESSION_KEY_SEPARATOR));",
     "  return digest(hashableBlocks(msg).map(blockFingerprint).join(SESSION_KEY_SEPARATOR));"),
    ("hash: only the first block counts, so anything after the caption is invisible",
     AGENT,
     "  return digest([msg.role, ...hashableBlocks(msg).map(blockFingerprint)].join(SESSION_KEY_SEPARATOR));",
     "  return digest([msg.role, hashableBlocks(msg).map(blockFingerprint)[0] ?? \"\"].join(SESSION_KEY_SEPARATOR));"),

    # --- the same arguments written two ways ---------------------------------
    ("canonical: object keys keep their insertion order, so re-serialising a call diverges",
     AGENT,
     "  const entries = Object.entries(value as Record<string, unknown>)\n"
     "    .filter(([, v]) => v !== undefined)\n"
     "    .sort(([a], [b]) => compareByCodePoint(a, b));",
     "  const entries = Object.entries(value as Record<string, unknown>)\n"
     "    .filter(([, v]) => v !== undefined);"),

    # --- recording and replay must agree -------------------------------------
    ("whitespace: a blank text block is hashed, so recording and replay disagree",
     AGENT,
     "  return msg.content.filter((b) => !(b.type === \"text\" && b.text.trim() === \"\"));",
     "  return [...msg.content];"),

    # --- a book from before the hash changed ---------------------------------
    ("version: a book written under the old hash is read as if it were current",
     AGENT,
     "  if (record === undefined || record.version !== SESSION_BOOK_VERSION) return coldStart(msgs);",
     "  if (record === undefined) return coldStart(msgs);"),
    ("version: any version is accepted as long as one is present",
     AGENT,
     "  if (record === undefined || record.version !== SESSION_BOOK_VERSION) return coldStart(msgs);",
     "  if (record === undefined || record.version === undefined) return coldStart(msgs);"),
    ("version: the book is stamped with the version it is not",
     SESSIONS,
     "export const SESSION_BOOK_VERSION = 5;",
     "export const SESSION_BOOK_VERSION = 4;"),

    # --- reading a stream the provider does not own ---------------------------
    ("stream: the model's own events are ignored, so nothing streams at all",
     AGENT,
     "      if (event.type === \"message_start\" && onRoundStart !== undefined) await onRoundStart();\n"
     "      yield event;\n",
     "      if (event.type === \"message_start\" && onRoundStart !== undefined) await onRoundStart();\n"),
    ("stream: an agent the SDK ran on its own is read as part of the reply",
     AGENT,
     "  const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;\n  return typeof parent === \"string\";",
     "  return false;"),
    ("stream: the SDK compacting mid-turn is absorbed rather than raised",
     AGENT,
     "    if (msg.type === \"system\" && msg.subtype === \"compact_boundary\") {\n"
     "      throw new Error(\n"
     "        \"claude_agent: the SDK compacted mid-turn, so its history no longer matches shore's\",\n"
     "      );\n"
     "    }",
     ""),

    # --- how the turn says it ended -------------------------------------------
    ("finish: a failed run still reports a stop reason, so the failure is hidden",
     AGENT,
     "  if (seen.subtype !== \"success\") return seen.subtype;\n  if (seen.sawStopReason === true) return streamed;",
     "  if (seen.sawStopReason === true) return streamed;"),
    ("finish: a stream that never said how it ended is called a clean stop anyway",
     AGENT,
     "  if (seen.sawStopReason === true) return streamed;\n  return seen.stopReason ?? streamed;",
     "  return streamed;"),
    ("finish: the run's word overrides the model's, so a later frame rewrites the turn",
     AGENT,
     "  if (seen.sawStopReason === true) return streamed;\n  return seen.stopReason ?? streamed;",
     "  return seen.stopReason ?? streamed;"),
    ("finish: a message that stopped for no reason counts as having said how it ended",
     AGENT,
     "  return event.type === \"message_delta\" && event.delta.stop_reason !== null;",
     "  return event.type === \"message_delta\";"),

    # --- what gets billed ------------------------------------------------------
    ("usage: the cache columns are dropped, so a cached turn bills as a cold one",
     AGENT,
     "    cache_read_tokens: u.cache_read_input_tokens ?? 0,\n    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,",
     "    cache_read_tokens: 0,\n    cache_creation_tokens: 0,"),

    # --- options that fail open ------------------------------------------------
    ("options: the built-in tool surface comes back, at roughly 12.8k tokens a turn",
     AGENT,
     "    tools: [],\n    skills: [],",
     "    skills: [],"),
    ("options: skills are left to the CLI's own defaults rather than turned off",
     AGENT,
     "    tools: [],\n    skills: [],",
     "    tools: [],"),
    ("options: the harness may compact behind shore's back",
     AGENT,
     "    settings: { autoCompactEnabled: false },\n",
     ""),
    ("options: the tools that spawn a loop of their own are allowed again",
     AGENT,
     'const NESTED_LOOP_TOOLS = ["Task", "Agent", "Skill"];',
     "const NESTED_LOOP_TOOLS: string[] = [];"),
    ("options: the run is not given a controller, so an abort cannot reach it",
     AGENT,
     "    abortController: abort,\n",
     ""),

    # --- what the turn leaves behind -------------------------------------------
    ("book: every frame of a round opens a new anchor, so a turn has more than it made",
     AGENT,
     "  if (seen.lastMessageId === messageId && last >= 0) {\n"
     "    seen.assistantUuids[last] = uuid;\n"
     "    return;\n"
     "  }\n",
     ""),
    ("book: a round is anchored on its first frame rather than where it ended",
     AGENT,
     "    seen.assistantUuids[last] = uuid;\n    return;",
     "    return;"),
    ("book: every assistant turn is anchored on the same frame",
     AGENT,
     "    if (m.role === \"assistant\") {\n"
     "      const uuid = pending.shift();\n"
     "      if (uuid !== undefined) entry.uuid = uuid;\n"
     "    }",
     "    if (m.role === \"assistant\" && pending[0] !== undefined) entry.uuid = pending[0];"),
    ("book: an assistant turn with no frame is anchored on nothing at all "
     "(EQUIVALENT — assigning undefined and leaving the key off read the same everywhere, "
     "including through JSON)",
     AGENT,
     "      const uuid = pending.shift();\n      if (uuid !== undefined) entry.uuid = uuid;",
     "      entry.uuid = pending.shift() as string;"),

    # --- replaying a history that used tools ---------------------------------
    ("replay: what the assistant did is dropped, leaving only what it said",
     AGENT,
     "    case \"tool_use\":\n"
     "      return (\n"
     "        `<prior_tool_call name=\"${block.name}\">\\n` +\n"
     "        `${JSON.stringify(block.input)}\\n</prior_tool_call>`\n"
     "      );",
     "    case \"tool_use\":\n      return \"\";"),
    ("replay: a tool call is named but not what it was asked for",
     AGENT,
     "        `${JSON.stringify(block.input)}\\n</prior_tool_call>`",
     "        `</prior_tool_call>`"),
    ("replay: what came back from a tool is dropped",
     AGENT,
     "    case \"tool_result\":\n"
     "      return (\n"
     "        `<prior_tool_result${block.is_error === true ? ' failed=\"true\"' : \"\"}>\\n` +\n"
     "        `${resultText(block.content)}\\n</prior_tool_result>`\n"
     "      );",
     "    case \"tool_result\":\n      return \"\";"),
    ("replay: a call that failed is replayed as one that worked",
     AGENT,
     "        `<prior_tool_result${block.is_error === true ? ' failed=\"true\"' : \"\"}>\\n` +",
     "        `<prior_tool_result>\\n` +"),


    # --- the two names every tool has ----------------------------------------
    ("names: tools are advertised bare, under names the CLI cannot route",
     TOOLS,
     "      const wire = `mcp__${SHORE_MCP_SERVER}__${sanitize(def.name)}`;",
     "      const wire = sanitize(def.name);"),
    ("names: a call arrives under the name the model used, not the one shore dispatches",
     TOOLS,
     "  bareOf(wire: string): string | undefined {\n    return this.#bareOf.get(wire);\n  }",
     "  bareOf(wire: string): string | undefined {\n    return wire;\n  }"),
    ("names: the prefix is stripped by hand, so shore's own MCP tools lose theirs too",
     TOOLS,
     "  bareOf(wire: string): string | undefined {\n    return this.#bareOf.get(wire);\n  }",
     "  bareOf(wire: string): string | undefined {\n"
     "    return wire.replace(`mcp__${SHORE_MCP_SERVER}__`, \"\");\n  }"),
    ("names: two tools that sanitize alike are merged, so one runs in the other's place",
     TOOLS,
     "      const clash = this.#bareOf.get(wire);\n"
     "      if (clash !== undefined) throw new DuplicateToolName(wire, clash, def.name);\n",
     ""),
    ("names: a name too long to advertise is sent anyway",
     TOOLS,
     "      if (wire.length > MAX_MCP_NAME) throw new ToolNameTooLong(def.name, wire);\n",
     ""),
    # --- what the model is shown of a tool -----------------------------------
    ("surface: the schema is replaced by an empty one, so arguments are unexplained",
     TOOLS,
     "      inputSchema: def.input_schema as { type: \"object\" },",
     "      inputSchema: { type: \"object\" } as { type: \"object\" },"),
    ("surface: descriptions are dropped, so the model is told only the names",
     TOOLS,
     "      description: def.description,",
     '      description: "",'),

    # --- what comes back from a tool -----------------------------------------
    ("result: a failed tool reads to the model as one that succeeded",
     TOOLS,
     "      ...(block.is_error === true ? { isError: true } : {}),\n    };\n  }\n\n  const content",
     "    };\n  }\n\n  const content"),
    ("result: an image a tool produced never reaches the model",
     TOOLS,
     "    } else if (inner.type === \"image\") {\n"
     "      content.push({ type: \"image\", data: inner.source.data, mimeType: inner.source.media_type });\n"
     "    }",
     "    }"),

    # --- the shape a tool round is written down in ---------------------------
    ("loop: the tool call is written down under the name the SDK advertised it as",
     AGENT,
     "  const bare = names.bareOf(event.name);\n  return bare === undefined ? event : { ...event, name: bare };",
     "  return event;"),
    ('loop: the result is recorded before the call it answers', 'src/llm/providers/claude_agent.ts', '        await this.#phase.recordTurn("assistant", this.#turn.content_blocks);', '        await this.#phase.recordTurn("user", this.#turn.content_blocks);'),
    ('loop: the final reply is recorded as a round as well, so the turn says it twice', 'src/llm/providers/claude_agent.ts', 'if (this.#turn.content_blocks.some((block) => block.type === "tool_use"))', 'if (true)'),
    ('loop: prose from an earlier round is carried into the finished turn', 'src/llm/providers/claude_agent.ts', '    acc.text = "";', ''),
    ("loop: a round is not counted, so the tool budget is never spent",
     AGENT,
     "    this.iterations += 1;\n",
     ""),
    ("loop: every result is given a fresh id rather than the call's own", 'src/llm/providers/claude_agent.ts', 'const result = await this.#phase.runTool({ id: use.id, name: bare, input });', 'const result = await this.#phase.runTool({ id: crypto.randomUUID(), name: bare, input });'),
    ("loop: a spent tool budget still allows the call",
     AGENT,
     "    if (cap !== undefined && round.iterations >= cap) {\n"
     "      return Promise.resolve({ behavior: \"deny\", message: TOOL_BUDGET_SPENT });\n"
     "    }",
     ""),
    ("loop: the budget denial interrupts, so the turn ends without an answer",
     AGENT,
     "      return Promise.resolve({ behavior: \"deny\", message: TOOL_BUDGET_SPENT });",
     "      return Promise.resolve({ behavior: \"deny\", message: TOOL_BUDGET_SPENT, interrupt: true });"),
    ("loop: a tool shore never advertised is allowed through to the dispatcher",
     AGENT,
     "    if (names.bareOf(toolName) === undefined) {\n"
     "      return Promise.resolve({\n"
     "        behavior: \"deny\",\n"
     "        message: `${toolName} is not one of shore's tools`,\n"
     "      });\n"
     "    }",
     ""),
    ("loop: the tool surface is never handed over, so a tool turn has no tools",
     AGENT,
     "  const defs = req.tools ?? [];\n  if (defs.length === 0) {",
     "  const defs = req.tools ?? [];\n  if (true) {"),

    # --- what a text-only replay says about the rest -------------------------
    ("replay: an image-only turn is dropped again, so the history skips it in silence",
     AGENT,
     "      attached.push(block);\n"
     "      return `[image attached: ${block.source.media_type}]`;",
     '      return "";'),
    ("images: the picture is described but never sent",
     AGENT,
     "      attached.push(block);\n",
     ""),
    # --- the name at each boundary -------------------------------------------
    ("names: the namespaced name is advertised, so the CLI prefixes it twice",
     TOOLS,
     "      name: def.name,",
     "      name: names.wireOf(def.name) ?? def.name,"),
    ("names: a call is looked up as though the CLI namespaced it",
     TOOLS,
     "    const bare = request.params.name;\n    if (names.wireOf(bare) === undefined) throw new UnknownShoreTool(bare);",
     "    const bare = names.bareOf(request.params.name) ?? request.params.name;"),
    ("names: any name at all is dispatched, advertised or not",
     TOOLS,
     "    if (names.wireOf(bare) === undefined) throw new UnknownShoreTool(bare);\n",
     ""),

    # --- what the CLI is allowed to do to a result ----------------------------
    ("size: a result goes out whole, so the CLI spills it to a file instead",
     TOOLS,
     "  let budget = MCP_RESULT_CEILING_BYTES;",
     "  return text;\n  let budget = MCP_RESULT_CEILING_BYTES;"),
    ("size: the ceiling is raised past what the CLI will inline",
     TOOLS,
     "export const MCP_RESULT_CEILING_BYTES = 48_000;",
     "export const MCP_RESULT_CEILING_BYTES = 480_000;"),
    ("size: width is counted in characters, so multi-byte text still overflows",
     TOOLS,
     "    const bytes = Buffer.byteLength(windowed, \"utf8\");",
     "    const bytes = windowed.length;"),
    ("size: the CLI keeps its own token ceiling, which truncates twice",
     AGENT,
     "  if (surface !== undefined) env.MAX_MCP_OUTPUT_TOKENS = String(MCP_OUTPUT_CEILING_TOKENS);\n",
     ""),

    # --- what the finished turn contains --------------------------------------
    ("rounds: the whole turn is returned as the final blocks, repeating each call",
     AGENT,
     "      content_blocks: round.finalBlocks(),\n",
     ""),

    # --- what the turn is billed to ------------------------------------------
    ("billing: the subprocess inherits the daemon's environment, key included",
     AGENT,
     "  const env: Record<string, string> = {\n    PATH: process.env.PATH ?? \"\",",
     "  const env: Record<string, string> = {\n    ...(process.env as Record<string, string>),\n    PATH: process.env.PATH ?? \"\","),
    ("billing: a key is forwarded even when the turn asked for none",
     AGENT,
     "  if (req.api_key !== \"\") env.ANTHROPIC_API_KEY = req.api_key;",
     "  env.ANTHROPIC_API_KEY = req.api_key;"),
    ("billing: no sdk runs on a subscription, so the key is spent instead",
     CREDENTIALS,
     "const KEYLESS_SDKS = new Set<string>([\"claude_agent\"]);",
     "const KEYLESS_SDKS = new Set<string>([]);"),
    ("billing: the subscription sdk is routed through the key lookup anyway",
     REQUEST,
     "  if (isKeylessSdk(model.sdk)) {",
     "  if (false as boolean) {"),

    ("images: every turn is sent in the streaming form, not only the ones with pictures",
     AGENT,
     "  if (plan.images.length === 0) return plan.prompt;\n",
     ""),
    ("images: the text is dropped when a picture rides along",
     AGENT,
     "  return oneUserTurn(plan.replayContent ?? [{ type: \"text\", text: plan.prompt }, ...plan.images]);",
     "  return oneUserTurn(plan.images);"),
    ("images: the pictures are dropped when the text rides along",
     AGENT,
     "  return oneUserTurn(plan.replayContent ?? [{ type: \"text\", text: plan.prompt }, ...plan.images]);",
     "  return oneUserTurn([{ type: \"text\", text: plan.prompt }]);"),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
