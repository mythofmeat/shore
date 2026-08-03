/**
 * The shared "build the chat-shaped request inputs" pipeline.
 *
 * Ported from `crates/daemon/src/handler/context.rs`, pinned by
 * `tests/handler_fixtures/context_parity.json`.
 *
 * Two sites need to take a character plus its conversation history and produce
 * the message list, the system blocks, and the tool definitions an outgoing
 * request is built from: chat generation, and the heartbeat's cold rebuild.
 * They had nearly byte-identical thirty-line stretches doing it, and that
 * duplication was load-bearing in the worst way — a drift as small as one
 * forgotten step silently broke cache reuse between chat and heartbeat, which
 * shows up as a bill rather than as a failure.
 *
 * This module is the one place those steps live.
 */

import type { LoadedConfig } from "../config/loader.ts";
import { resolveDisplayName } from "../config/app.ts";
import { anyToolEnabled } from "../config/app.ts";
import { AGENTS_FILE, SOUL_FILE, TOOLS_FILE, USER_FILE } from "../config/dirs.ts";
import {
  resolvedReplayPriorThinking,
  toRequestModel,
  type ResolvedModel,
} from "../config/models.ts";
import { assemblePrompt, type AssembledPrompt } from "../engine/prompt.ts";
import type { Message } from "../engine/types.ts";
import {
  ensureActivePromptSnapshot,
  loadActivePromptFile,
  loadMemoryIndex,
} from "../memory/deferred_edits.ts";
import { buildRequestWithProviderKeys, type BuiltRequest } from "../llm/request.ts";
import type { SystemBlock, ToolDefinition, WireMessage } from "../llm/types.ts";
import { toCredentialsEntry } from "../config/providers.ts";
import { assembleToolSurface, renderToolDefs, subagentToolDefs } from "../tools/registry.ts";
import type { CachedResize } from "./images.ts";
import { assistantImageModeForRequest, buildLlmMessages } from "./wire_messages.ts";

export interface PrepareChatContextParams {
  character: string;
  characterDataDir: string;
  config: LoadedConfig;
  resolved: ResolvedModel;
  messages: Message[];
  hasPriorContext: boolean;
  /**
   * Pre-filtered MCP tool defs, already in the registry's pinned sort. The
   * caller builds these from the live registry, filtered by `enabled_tools`;
   * pass `[]` when no registry is wired, as background rebuilds do.
   * {@link assembleToolSurface} decides where they land.
   */
  mcpToolDefs: readonly ToolDefinition[];
  /** The image-resize ladder. Omitted means encode images at stored size. */
  resize?: CachedResize;
  /**
   * The zone time markers render in. Defaults to the host's, which is what the
   * Rust's `chrono::Local` resolved to. A parameter only because the Rust's
   * implicit host lookup is untestable — the parity replay has to pin a zone
   * or it passes on the generator's machine and nowhere else.
   */
  timeZone?: string;
}

/**
 * The three pieces every chat-shaped request needs, plus the assembled prompt
 * for callers that want to do more work before building the request — warming
 * the image cache, most of all, which needs the prompt's own `messages`.
 */
export interface PreparedChatContext {
  llmMessages: WireMessage[];
  system: SystemBlock[];
  toolDefs: ToolDefinition[] | undefined;
  prompt: AssembledPrompt;
}

/**
 * Load the four active-prompt files plus the memory index, assemble the prompt,
 * convert it to wire messages, and render the tool surface.
 *
 * A prompt file that will not load is not fatal — the slot goes empty, which is
 * what the Rust did, and is the difference between a character with a missing
 * USER.md and a character that cannot talk. The snapshot-ensure step is
 * best-effort for the same reason: it is warned about and stepped over.
 */
export async function prepareChatContext(
  params: PrepareChatContextParams,
): Promise<PreparedChatContext> {
  const { character, characterDataDir, config, resolved, messages, mcpToolDefs } = params;
  const displayName = resolveDisplayName(config.app.defaults);

  try {
    await ensureActivePromptSnapshot(characterDataDir, config.dirs.config, character);
  } catch (e) {
    console.warn(`shore: failed to prepare active prompt snapshot for ${character}: ${String(e)}`);
  }

  const characterDefinition = await loadActivePromptFile(characterDataDir, SOUL_FILE);
  const userDefinition = await loadActivePromptFile(characterDataDir, USER_FILE);
  const systemPrompt = await loadActivePromptFile(characterDataDir, AGENTS_FILE);
  const toolsGuidance = await loadActivePromptFile(characterDataDir, TOOLS_FILE);
  const memoryIndex = await loadMemoryIndex(characterDataDir, config.dirs.config, character);

  const promptParams = {
    character_name: character,
    display_name: displayName,
    system_prompt: systemPrompt,
    tools_guidance: toolsGuidance,
    character_definition: characterDefinition,
    user_definition: userDefinition,
    memory_index: memoryIndex,
    has_prior_context: params.hasPriorContext,
    messages,
    max_context_tokens: resolved.maxContextTokens,
    max_output_tokens: resolved.maxOutputTokens,
    user_timestamp_mode: config.app.behavior.user_message_timestamps,
  };
  const prompt =
    params.timeZone === undefined
      ? assemblePrompt(promptParams)
      : assemblePrompt(promptParams, params.timeZone);

  // MCP alone is enough: a character with no `enabled_tools` still has a
  // non-empty surface if a server is connected, and `tools: []` is not the same
  // request as no `tools` param at all.
  const toolsAvailable = anyToolEnabled(config.app.tools) || mcpToolDefs.length > 0;

  const { messages: llmMessages, system } = await buildLlmMessages(
    prompt,
    config.app.advanced.max_image_size,
    config.dirs.cache,
    assistantImageModeForRequest(resolved.sdk, toolsAvailable),
    params.resize,
  );

  // Offer order is cache-load-bearing; `assembleToolSurface` owns it.
  //
  // `displayName` reaches `renderToolDefs` for `{{user}}` substitution, and no
  // registered tool description currently contains one — so passing the wrong
  // name there is unobservable today, and the mutation pass records it as an
  // equivalent rather than a gap. The subagent path below does template it.
  const toolDefs = toolsAvailable
    ? assembleToolSurface(
        renderToolDefs(config.app.tools, character, displayName),
        subagentToolDefs(
          config.app.subagents,
          config.app.tools.enabled_subagents,
          character,
          displayName,
        ),
        mcpToolDefs,
      )
    : undefined;

  return { llmMessages, system, toolDefs, prompt };
}

/**
 * Build the chat-shape request from disk — the request chat's handler would
 * build for its next turn.
 *
 * The fallback for when an in-memory `last_request` is unavailable: a daemon
 * restart, a post-compaction invalidation, a manual compact before any chat has
 * run. Both the heartbeat's cold rebuild and the compaction tail builder lean on
 * it, and the reason is the cache rather than convenience — whatever chat would
 * have sent is what they send, so the prefix lines up across all three.
 *
 * `resolved` is the model the request is anchored on: system, tools and the
 * provider key all flow from it. Compaction passes the *chat* model here on
 * purpose, because its own tool loop rebuilds against the compaction model
 * later; this call only establishes the wire shape.
 */
export async function buildChatShapeRequestFromDisk(
  character: string,
  characterDataDir: string,
  config: LoadedConfig,
  resolved: ResolvedModel,
  messages: Message[],
  hasPriorContext: boolean,
  resize?: CachedResize,
): Promise<BuiltRequest> {
  const prepared = await prepareChatContext({
    character,
    characterDataDir,
    config,
    resolved,
    messages,
    hasPriorContext,
    // Background disk rebuild: MCP tools are not wired on this path.
    mcpToolDefs: [],
    ...(resize === undefined ? {} : { resize }),
  });

  const entry = config.providers.get(resolved.providerKey);
  return buildRequestWithProviderKeys(
    toRequestModel(resolved),
    entry === undefined ? undefined : toCredentialsEntry(entry),
    {
      messages: prepared.llmMessages,
      system: prepared.system,
      ...(prepared.toolDefs === undefined ? {} : { tools: prepared.toolDefs }),
      replay: resolvedReplayPriorThinking(
        resolved,
        config.app.memory.thinking.replay_prior_thinking,
      ),
    },
  );
}
