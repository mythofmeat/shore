#!/usr/bin/env python3
"""Mutation pass over `prepareChatContext` and the wire-message builder:
images, captions and stand-ins, which turns and blocks ship, provenance, and
system blocks.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WIRE = ROOT / "src/handler/wire_messages.ts"
CONTEXT = ROOT / "src/handler/context.ts"

MUTANTS = [
    # --- mode selection ---------------------------------------------------
    ("mode: the sdk alone is enough, tool defs are not required", WIRE,
     'return TOOL_PAIR_SDKS.includes(sdk) && hasToolDefs ? "tool_pair" : "text_standin";',
     'return TOOL_PAIR_SDKS.includes(sdk) ? "tool_pair" : "text_standin";'),
    ("mode: tool defs alone are enough, the sdk is not checked", WIRE,
     'return TOOL_PAIR_SDKS.includes(sdk) && hasToolDefs ? "tool_pair" : "text_standin";',
     'return hasToolDefs ? "tool_pair" : "text_standin";'),
    ("mode: only the Anthropic API pairs images with a tool call", WIRE,
     'const TOOL_PAIR_SDKS: readonly Sdk[] = ["anthropic", "claude_agent"];',
     'const TOOL_PAIR_SDKS: readonly Sdk[] = ["anthropic"];'),
    ("mode: every sdk pairs images with a tool call", WIRE,
     'const TOOL_PAIR_SDKS: readonly Sdk[] = ["anthropic", "claude_agent"];',
     'const TOOL_PAIR_SDKS: readonly Sdk[] = ["anthropic", "claude_agent", "openai", "gemini"];'),
    ("mode: always the tool pair", WIRE,
     'return TOOL_PAIR_SDKS.includes(sdk) && hasToolDefs ? "tool_pair" : "text_standin";',
     'return "tool_pair";'),
    ("mode: always the stand-in", WIRE,
     'return TOOL_PAIR_SDKS.includes(sdk) && hasToolDefs ? "tool_pair" : "text_standin";',
     'return "text_standin";'),

    # --- synthetic ids ----------------------------------------------------
    ("id: the index is dropped, so two images collide", WIRE,
     "return `toolu_gen_${index}_${safe}`;",
     "return `toolu_gen_${safe}`;"),
    ("id: the stem is not sanitized", WIRE,
     '  const safe = Array.from(stem, (c) => (/[0-9A-Za-z]/.test(c) ? c : "_"))',
     "  const safe = Array.from(stem)"),
    ("id: the stem is not truncated", WIRE,
     "    .slice(0, 48)",
     "    .slice(0, 64)"),
    ("id: the truncation is off by one", WIRE,
     "    .slice(0, 48)",
     "    .slice(0, 47)"),
    ("id: a dotfile stems to the empty string", WIRE,
     "  return dot <= 0 ? name : name.slice(0, dot);",
     "  return dot < 0 ? name : name.slice(0, dot);"),
    ("id: the stem is the whole file name, extension included", WIRE,
     "  return dot <= 0 ? name : name.slice(0, dot);",
     "  return name;"),
    ("id: the stem is the whole path, not the basename", WIRE,
     "  const name = basename(path);",
     "  const name = path;"),

    # --- captions ---------------------------------------------------------
    ("caption: not trimmed, so a whitespace caption renders", WIRE,
     "  const caption = img.caption?.trim();",
     "  const caption = img.caption;"),
    ("caption: an empty caption is kept rather than treated as absent", WIRE,
     '  return caption === undefined || caption === "" ? undefined : caption;',
     "  return caption;"),
    ("caption: the stand-in never names the image", WIRE,
     '        text: caption === undefined ? "[sent an image]" : `[sent an image: ${caption}]`,',
     '        text: "[sent an image]",'),
    ("caption: the stand-in always names it, empty or not", WIRE,
     '        text: caption === undefined ? "[sent an image]" : `[sent an image: ${caption}]`,',
     "        text: `[sent an image: ${caption}]`,"),
    ("caption: the tool_use input always carries a caption key", WIRE,
     "      input: caption === undefined ? {} : { caption },",
     "      input: { caption },"),
    ("caption: the tool_use input never carries one", WIRE,
     "      input: caption === undefined ? {} : { caption },",
     "      input: {},"),
    ("caption: the result's text block is emitted even when absent", WIRE,
     '    if (caption !== undefined) content.push({ type: "text", text: caption });',
     '    content.push({ type: "text", text: caption ?? "" });'),
    ("caption: the result's text block precedes the image", WIRE,
     '    const content: ContentBlock[] = [{ type: "image", source }];\n'
     '    if (caption !== undefined) content.push({ type: "text", text: caption });',
     '    const content: ContentBlock[] = [];\n'
     '    if (caption !== undefined) content.push({ type: "text", text: caption });\n'
     '    content.push({ type: "image", source });'),

    # --- assistant image rerouting ----------------------------------------
    ("reroute: user turns reroute their images too", WIRE,
     '  const reroute = m.role === "assistant" && m.images.length > 0;',
     "  const reroute = m.images.length > 0;"),
    ("reroute: assistant turns never reroute", WIRE,
     '  const reroute = m.role === "assistant" && m.images.length > 0;',
     "  const reroute = false as boolean;"),
    ("reroute: the rerouted images are ALSO rendered as raw image blocks", WIRE,
     "  const turnImages = reroute ? [] : m.images;",
     "  const turnImages = m.images;"),
    ("reroute: the assistant blocks land before the turn's own content", WIRE,
     "  if (imageRender !== undefined) content = [...content, ...imageRender.assistantBlocks];",
     "  if (imageRender !== undefined) content = [...imageRender.assistantBlocks, ...content];"),
    ("reroute: the assistant blocks are dropped", WIRE,
     "  if (imageRender !== undefined) content = [...content, ...imageRender.assistantBlocks];",
     "  if (imageRender !== undefined) content = [...content];"),
    ("standin: the tool pair is used even when the image failed to encode", WIRE,
     "    if (source === undefined) {",
     "    if (false as boolean) {"),
    ("standin: the image is never encoded in tool_pair mode", WIRE,
     '      mode === "tool_pair"\n        ? await encodeImageBlock(img)\n        : undefined;',
     "      undefined;"),
    ("standin: the image IS encoded in text_standin mode", WIRE,
     '      mode === "tool_pair"\n        ? await encodeImageBlock(img)\n        : undefined;',
     "      await encodeImageBlock(img);"),

    # --- empty-block filtering --------------------------------------------
    ('filter: empty text blocks ship',
     WIRE,
     '  content.push(...m.content_blocks.filter((block) => !(block.type === "text" && block.text.trim() === "")));',
     '  content.push(...m.content_blocks);'),
    ('filter: whitespace is not trimmed before the emptiness test',
     WIRE,
     '  content.push(...m.content_blocks.filter((block) => !(block.type === "text" && block.text.trim() === "")));',
     '  content.push(...m.content_blocks.filter((block) => !(block.type === "text" && block.text === "")));'),
    ('filter: every block type is filtered, not just text (EQUIVALENT — `text` is declared on exactly one arm of ContentBlock, so `"text" in b` and `b.type === "text"` select the same blocks)',
     WIRE,
     '  content.push(...m.content_blocks.filter((block) => !(block.type === "text" && block.text.trim() === "")));',
     '  content.push(...m.content_blocks.filter((block) => !("text" in block && block.text.trim() === "")));'),


    ("drop: an empty turn ships instead of being dropped", WIRE,
     "  if (content.length === 0) return undefined;",
     "  if (false as boolean) return undefined;"),

    # --- pending tool_results ---------------------------------------------
    ("pending: a dropped turn takes its predecessor's owed results with it", WIRE,
     "    if (rendered === undefined) {\n      continue;\n    }",
     "    if (rendered === undefined) {\n      pending = [];\n      continue;\n    }"),
    ("pending: owed results are appended to the next user turn, not prepended", WIRE,
     "        content = [...owed, ...content];",
     "        content = [...content, ...owed];"),
    ("pending: owed results merge into an assistant turn rather than getting one", WIRE,
     '      if (m.role === "user") {\n'
     "        content = [...owed, ...content];\n"
     "      } else {\n"
     '        messages.push({ role: "user", content: owed });\n'
     "      }",
     "      content = [...owed, ...content];"),
    ("pending: the injected turn is an assistant turn", WIRE,
     '        messages.push({ role: "user", content: owed });',
     '        messages.push({ role: "assistant", content: owed });'),
    ("pending: the injected turn lands after the message that forced it", WIRE,
     '      if (m.role === "user") {\n'
     "        content = [...owed, ...content];\n"
     "      } else {\n"
     '        messages.push({ role: "user", content: owed });\n'
     "      }",
     '      if (m.role === "user") {\n'
     "        content = [...owed, ...content];\n"
     "      } else {\n"
     "        pending = owed;\n"
     "      }"),
    ("pending: a trailing owed result is never flushed", WIRE,
     '  if (pending.length > 0) messages.push({ role: "user", content: pending });',
     "  /* not flushed */"),
    ("pending: the trailing flush is an assistant turn", WIRE,
     '  if (pending.length > 0) messages.push({ role: "user", content: pending });',
     '  if (pending.length > 0) messages.push({ role: "assistant", content: pending });'),

    # --- provenance and system blocks -------------------------------------
    ("provenance: the provider key is dropped", WIRE,
     "      ...(m.provider_key === undefined ? {} : { provider_key: m.provider_key }),",
     "      ...{},"),
    ("provenance: the model is dropped", WIRE,
     "      ...(m.model === undefined ? {} : { model: m.model }),",
     "      ...{},"),
    ("system: the label is dropped", WIRE,
     "  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));",
     '  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: "system" }));'),
    ("system: text and label are swapped", WIRE,
     "  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));",
     "  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.label, label: b.content }));"),
    ("system: a lone block loses its label", WIRE,
     "  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));",
     "  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));\n"
     '  if (system.length === 1 && system[0] !== undefined) system[0] = { text: system[0].text, label: "" };'),
    ("system: block order is reversed", WIRE,
     "  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));",
     "  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label })).reverse();"),
    ("role: every turn ships as a user turn", WIRE,
     "      role: m.role,",
     '      role: "user",'),

    # --- prepareChatContext: which file lands in which slot ---------------
    ("context: SOUL and USER are swapped", CONTEXT,
     "  const characterDefinition = await promptFile(SOUL_FILE);\n"
     "  const userDefinition = await promptFile(USER_FILE);",
     "  const characterDefinition = await promptFile(USER_FILE);\n"
     "  const userDefinition = await promptFile(SOUL_FILE);"),
    ("context: AGENTS and TOOLS are swapped", CONTEXT,
     "  const systemPrompt = await promptFile(AGENTS_FILE);\n"
     "  const toolsGuidance = await promptFile(TOOLS_FILE);",
     "  const systemPrompt = await promptFile(TOOLS_FILE);\n"
     "  const toolsGuidance = await promptFile(AGENTS_FILE);"),
    ("context: the memory index is not loaded", CONTEXT,
     "  const memoryIndex = await loadMemoryIndex(\n"
     "    characterDataDir,\n    config.dirs.config,\n    character,\n    config.dirs.workspace,\n    params.thread,\n  );",
     "  const memoryIndex = undefined as string | undefined;"),
    ("context: the memory index reads the data dir as its config dir", CONTEXT,
     "  const memoryIndex = await loadMemoryIndex(\n    characterDataDir,\n    config.dirs.config,",
     "  const memoryIndex = await loadMemoryIndex(\n    characterDataDir,\n    characterDataDir,"),
    ("context: the snapshot is never ensured", CONTEXT,
     "      await ensureActivePromptSnapshot(\n"
     "        characterDataDir,\n        config.dirs.config,\n        character,\n        config.dirs.workspace,\n        params.thread,\n      );",
     "      void ensureActivePromptSnapshot;"),
    ("context: a failed snapshot is fatal", CONTEXT,
     "    } catch (e) {\n"
     "      shoreLog.warn(`shore: failed to prepare active prompt snapshot for ${character}: ${String(e)}`);\n"
     "    }",
     "    } catch (e) {\n      throw e;\n    }"),

    # --- prepareChatContext: the snapshot belongs to the conversation ------
    ("context: an empty conversation keeps the snapshot it inherited", CONTEXT,
     "      await resetActivePromptSnapshot(characterDataDir, params.thread);\n",
     ""),
    ("context: the snapshot is prepared before the conversation has anything in it", CONTEXT,
     "  const activeConversation = params.activeConversation ?? messages.length > 0;",
     "  const activeConversation = true as boolean;"),
    ("context: every conversation is treated as empty, so no turn ever holds a snapshot", CONTEXT,
     "  const activeConversation = params.activeConversation ?? messages.length > 0;",
     "  const activeConversation = false as boolean;"),

    # --- prepareChatContext: the tools fork -------------------------------
    ("context: MCP defs alone do not make tools available", CONTEXT,
     "  const toolsAvailable = anyToolEnabled(config.app.tools) || mcpToolDefs.length > 0;",
     "  const toolsAvailable = anyToolEnabled(config.app.tools);"),
    ("context: enabled tools alone do not make them available", CONTEXT,
     "  const toolsAvailable = anyToolEnabled(config.app.tools) || mcpToolDefs.length > 0;",
     "  const toolsAvailable = mcpToolDefs.length > 0;"),
    ("context: tools are always available", CONTEXT,
     "  const toolsAvailable = anyToolEnabled(config.app.tools) || mcpToolDefs.length > 0;",
     "  const toolsAvailable = true as boolean;"),
    ("context: an empty surface is Some([]) rather than None", CONTEXT,
     "    : undefined;",
     "    : [];"),
    ("context: MCP defs are dropped from the surface", CONTEXT,
     "        mcpToolDefs,\n      )",
     "        [],\n      )"),
    ("context: subagent defs are dropped from the surface", CONTEXT,
     "        subagentToolDefs(\n"
     "          config.app.subagents,\n"
     "          config.app.tools.enabled_subagents,\n"
     "          character,\n"
     "          displayName,\n"
     "        ),",
     "        [],"),
    ("context: static and subagent defs are swapped in the surface", CONTEXT,
     "        renderToolDefs(config.app.tools, character, displayName),\n"
     "        subagentToolDefs(\n"
     "          config.app.subagents,\n"
     "          config.app.tools.enabled_subagents,\n"
     "          character,\n"
     "          displayName,\n"
     "        ),",
     "        subagentToolDefs(\n"
     "          config.app.subagents,\n"
     "          config.app.tools.enabled_subagents,\n"
     "          character,\n"
     "          displayName,\n"
     "        ),\n"
     "        renderToolDefs(config.app.tools, character, displayName),"),
    ("context: the character name is passed where the display name goes (EQUIVALENT "
     "— no description in ALL_TOOLS references {{user}}, so the second argument to "
     "renderToolDefs reaches no template; the day one does, this starts failing)", CONTEXT,
     "        renderToolDefs(config.app.tools, character, displayName),",
     "        renderToolDefs(config.app.tools, character, character),"),

    # --- prepareChatContext: what reaches the builder ---------------------
    ("context: the mode is computed before the tools fork is known", CONTEXT,
     "    assistantImageModeForRequest(resolved.sdk, toolsAvailable),",
     "    assistantImageModeForRequest(resolved.sdk, true),"),
    ("context: the context and output token caps are swapped", CONTEXT,
     "    max_context_tokens: resolved.maxContextTokens,\n"
     "    max_output_tokens: resolved.maxOutputTokens,",
     "    max_context_tokens: resolved.maxOutputTokens,\n"
     "    max_output_tokens: resolved.maxContextTokens,"),
    ("context: has_prior_context is always false", CONTEXT,
     "    has_prior_context: params.hasPriorContext,",
     "    has_prior_context: false,"),
    ("context: the display name is not resolved from config", CONTEXT,
     "  const displayName = resolveDisplayName(config.app.defaults);",
     '  const displayName = "User";'),
    ("context: the timestamp mode is hardcoded", CONTEXT,
     "    user_timestamp_mode: config.app.behavior.user_message_timestamps,",
     '    user_timestamp_mode: "always",'),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/context.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
