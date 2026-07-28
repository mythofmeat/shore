//! Shared "build the chat-shaped request inputs" pipeline.
//!
//! Both the chat handler ([`crate::handler::task::handle_generation`]) and
//! the heartbeat cold rebuild ([`crate::autonomy::manager`]) need to take a
//! character + conversation history and produce the message JSON, system
//! block, and tool definitions that an `LlmRequest` is built from. The two
//! sites had nearly byte-identical 30-line stretches doing this; that
//! duplication was load-bearing because subtle drifts (a forgotten
//! `maybe_strip_prior_thinking`, a stale tool-def list) silently broke
//! cache reuse between chat and heartbeat.
//!
//! This module is the one place those steps live. Both sites pass a
//! [`PrepareChatContextParams`] and consume the [`PreparedChatContext`].

use std::path::Path;

use tracing::warn;

use crate::ledger::LedgerClient;
use crate::llm::types::LlmRequest;
use crate::llm::LlmError;
use shore_common::config::{LoadedConfig, AGENTS_FILE, SOUL_FILE, TOOLS_FILE, USER_FILE};
use shore_common::protocol::types::Message;

use crate::engine::prompt::{self, AssembledPrompt, PromptParams};

/// Inputs for [`prepare_chat_context`]. Callers fill this in instead of
/// passing seven parallel arguments.
#[derive(Clone, Copy)]
pub(crate) struct PrepareChatContextParams<'ctx> {
    pub character: &'ctx str,
    pub character_data_dir: &'ctx Path,
    pub config: &'ctx LoadedConfig,
    pub resolved: &'ctx shore_common::config::models::ResolvedModel,
    pub messages: &'ctx [Message],
    pub has_prior_context: bool,
    /// Pre-filtered MCP tool defs, already in the registry's pinned sort. The
    /// caller builds these from the live registry (filtered by `enabled_tools`);
    /// pass `&[]` when no registry is wired (background rebuilds).
    /// `tools::assemble_tool_surface` decides where they land.
    pub mcp_tool_defs: &'ctx [crate::llm::types::ToolDefinition],
}

/// Output of [`prepare_chat_context`]: the three pieces every chat-shaped
/// request needs, plus the assembled prompt for callers that want to do
/// additional work (e.g., image cache warming) before building the
/// request.
pub(crate) struct PreparedChatContext {
    pub llm_messages: Vec<crate::llm::types::WireMessage>,
    pub system: Vec<crate::llm::types::SystemBlock>,
    pub tool_defs: Option<Vec<crate::llm::types::ToolDefinition>>,
    pub prompt: AssembledPrompt,
}

/// Load the four active-prompt files (SOUL/USER/AGENTS/TOOLS) plus the
/// memory index, assemble the prompt, convert to LLM-API message JSON,
/// strip prior thinking if configured, and render tool defs.
///
/// Errors loading individual prompt files are not fatal — missing files
/// produce `None` for that slot, exactly as the existing code did.
/// Snapshot-ensure errors are logged at `warn` and ignored.
///
/// The returned `prompt` is the [`AssembledPrompt`] that produced
/// `llm_messages` and `system`; callers can use its `.messages` field
/// directly for things like image cache warming.
pub(crate) fn prepare_chat_context(params: PrepareChatContextParams<'_>) -> PreparedChatContext {
    let PrepareChatContextParams {
        character,
        character_data_dir,
        config,
        resolved,
        messages,
        has_prior_context,
        mcp_tool_defs,
    } = params;

    let display_name = config.app.defaults.resolve_display_name();

    if let Err(e) = crate::memory::deferred_edits::ensure_active_prompt_snapshot(
        character_data_dir,
        &config.dirs.config,
        character,
    ) {
        warn!(character, error = %e, "failed to prepare active prompt snapshot");
    }

    let character_definition =
        crate::memory::deferred_edits::load_active_prompt_file(character_data_dir, SOUL_FILE);
    let user_definition =
        crate::memory::deferred_edits::load_active_prompt_file(character_data_dir, USER_FILE);
    let system_prompt =
        crate::memory::deferred_edits::load_active_prompt_file(character_data_dir, AGENTS_FILE);
    let tools_guidance =
        crate::memory::deferred_edits::load_active_prompt_file(character_data_dir, TOOLS_FILE);
    let memory_index = crate::memory::deferred_edits::load_memory_index(
        character_data_dir,
        &config.dirs.config,
        character,
    );

    let prompt = prompt::assemble_prompt(&PromptParams {
        character_name: character,
        display_name: &display_name,
        system_prompt: system_prompt.as_deref(),
        tools_guidance: tools_guidance.as_deref(),
        character_definition: character_definition.as_deref(),
        user_definition: user_definition.as_deref(),
        memory_index: memory_index.as_deref(),
        has_prior_context,
        messages,
        max_context_tokens: resolved.max_context_tokens,
        max_output_tokens: resolved.max_output_tokens,
        user_timestamp_mode: config.app.behavior.user_message_timestamps,
    });

    let tools_available = config.app.tools.any_enabled() || !mcp_tool_defs.is_empty();
    let (llm_messages, system) = super::build_llm_messages(
        &prompt,
        config.app.advanced.max_image_size,
        &config.dirs.cache,
        super::AssistantImageMode::for_request(&resolved.sdk, tools_available),
    );

    let tool_defs = if tools_available {
        // Offer order is cache-load-bearing; `assemble_tool_surface` owns it.
        Some(crate::tools::assemble_tool_surface(
            crate::tools::render_tool_defs(&config.app.tools, character, &display_name),
            crate::tools::subagent_tool_defs(
                &config.app.subagents,
                &config.app.tools.enabled_subagents,
                character,
                &display_name,
            ),
            mcp_tool_defs,
        ))
    } else {
        None
    };

    PreparedChatContext {
        llm_messages,
        system,
        tool_defs,
        prompt,
    }
}

/// Build a chat-shape `LlmRequest` from disk — the request chat's handler
/// would build for its next turn, packaged as an `LlmRequest`.
///
/// Used as the fallback when an in-memory `AutonomyState::last_request` is
/// unavailable (daemon restart, post-compaction invalidation, manual
/// `swp memory_compact` before any chat has run). Both the heartbeat cold
/// rebuild and the compaction tail builder rely on this: whatever chat
/// would have sent is what they send, so the cache prefix lines up across
/// chat / heartbeat / compaction.
///
/// `resolved` is the model the resulting request is anchored on (system,
/// tools, and provider key flow from it). Compaction reuses the chat model
/// here because the compaction tool loop rebuilds the request against its
/// own model in `RealCompactionLlm::build_compaction_request`; the chat
/// model just establishes the wire shape.
pub(crate) fn build_chat_shape_request_from_disk(
    character: &str,
    character_data_dir: &Path,
    config: &LoadedConfig,
    resolved: &shore_common::config::models::ResolvedModel,
    messages: &[Message],
    has_prior_context: bool,
) -> Result<LlmRequest, LlmError> {
    let PreparedChatContext {
        llm_messages,
        system,
        tool_defs,
        ..
    } = prepare_chat_context(PrepareChatContextParams {
        character,
        character_data_dir,
        config,
        resolved,
        messages,
        has_prior_context,
        // Background disk rebuild: MCP tools are not wired on this path yet.
        mcp_tool_defs: &[],
    });

    LedgerClient::build_request_with_provider_keys(
        resolved,
        &config.providers,
        llm_messages,
        system,
        tool_defs,
        None,
        resolved.resolved_replay_prior_thinking(&config.app),
    )
}
