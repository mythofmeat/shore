//! Stream retry and tool-phase execution for the generation pipeline.

use tracing::{debug, error, instrument, warn};

/// True when the request has extended thinking / reasoning enabled via
/// either provider knob: Anthropic-style `budget_tokens > 0`, or
/// OpenAI/Anthropic-style `reasoning_effort` set to any non-null value.
/// Used by both the primary stream call and the tool-loop re-entry to
/// tag ledger rows and SSE metadata consistently.
pub(super) fn thinking_enabled_from_request(request: &crate::llm::types::LlmRequest) -> bool {
    request
        .provider_options
        .as_ref()
        .is_some_and(crate::llm::types::ProviderOptions::thinking_enabled)
}

use crate::convert::elapsed_ms_u64;
use crate::engine::tools;
use crate::ledger::CallType;
use crate::llm::retry::{self, RetryDecision, RetryPolicy};
use crate::llm::stream::StreamConsumer;
use crate::memory::compaction_impls::resolve_image_gen_config;
use crate::memory::markdown_store::MarkdownMemoryStore;
use crate::memory::retrieval::resolve_embedder;
use crate::tools::context::SharedToolContext;
use shore_common::config::LoadedConfig;
use shore_common::config::{character_data_dir, character_memory_dir, character_workspace_dir};

use super::{GenContext, HandlerToolContext};

/// Phase 10: Stream the LLM response with exponential backoff retry.
///
/// Returns `LlmError` directly so the multi-key fallback wrapper
/// (`key_fallback::stream_with_credential_fallback`) can classify the
/// failure and decide whether to rotate credentials. Transient retries
/// (5xx, 429, network blips) are absorbed here; credential-shaped
/// failures bubble up to the rotation layer above.
#[instrument(skip(ctx, request, effective_config), fields(char = char_name, model = %resolved.qualified_name))]
pub(super) async fn stream_with_retry(
    ctx: &GenContext,
    request: &crate::llm::types::LlmRequest,
    resolved: &shore_common::config::models::ResolvedModel,
    effective_config: &LoadedConfig,
    regen: bool,
    char_name: &str,
    thinking_enabled: bool,
) -> Result<crate::llm::types::StreamResult, crate::llm::LlmError> {
    let retry_policy = RetryPolicy {
        max_retries: effective_config
            .app
            .advanced
            .max_retries
            .unwrap_or(RetryPolicy::default().max_retries),
        ..RetryPolicy::default()
    };
    debug!(
        character = char_name,
        model = %resolved.qualified_name,
        max_retries = retry_policy.max_retries,
        "stream_with_retry starting"
    );
    let mut attempt: u32 = 0;

    loop {
        let consumer = StreamConsumer::new(ctx.direct_tx.clone(), request.rid.clone());

        let stream_result = async {
            let mut reader = ctx
                .llm_client
                .stream_raw(request, CallType::Message, char_name, thinking_enabled)
                .await?;

            consumer.consume(&mut reader, regen).await
        }
        .await;

        match stream_result {
            Ok(r) => {
                debug!(
                    attempts = attempt.saturating_add(1),
                    finish_reason = %r.finish_reason,
                    input_tokens = r.usage.input_tokens,
                    output_tokens = r.usage.output_tokens,
                    "stream_with_retry complete"
                );
                return Ok(r);
            }
            Err(e) => match retry::should_retry_error(&e, attempt, &retry_policy) {
                RetryDecision::Retry => {
                    let base_ms = effective_config
                        .app
                        .advanced
                        .retry_backoff
                        .map_or(500, |d| d.as_millis());
                    let delay = std::time::Duration::from_millis(
                        base_ms.saturating_mul(2_u64.saturating_pow(attempt)),
                    );
                    warn!(
                        attempt,
                        delay_ms = elapsed_ms_u64(delay),
                        error = %e,
                        "Retrying after transient LLM error"
                    );
                    tokio::time::sleep(delay).await;
                    attempt = attempt.saturating_add(1);
                }
                RetryDecision::FallbackModel(_model) => {
                    error!(error = %e, "stream_with_retry failed — fallback model requested");
                    return Err(e);
                }
                RetryDecision::Fail => {
                    error!(attempts = attempt.saturating_add(1), error = %e, "stream_with_retry exhausted retries");
                    return Err(e);
                }
            },
        }
    }
}

/// Build the `HandlerToolContext` for a tool loop invocation.
fn build_tool_context(
    ctx: &GenContext,
    data_dir: &std::path::Path,
    char_name: &str,
    effective_config: &LoadedConfig,
    conversation: &[shore_common::protocol::types::Message],
) -> HandlerToolContext {
    let image_gen_config = resolve_image_gen_config(
        effective_config.app.defaults.image_generation.as_deref(),
        &effective_config.models.image_generation,
        &effective_config.providers,
    )
    .ok();

    let character_data_dir = character_data_dir(data_dir, char_name);
    let config_dir = &effective_config.dirs.config;
    let workspace_dir = character_workspace_dir(config_dir, char_name);
    let memory_dir = character_memory_dir(config_dir, char_name);
    let embedder = resolve_embedder(
        effective_config.app.defaults.embedding.as_deref(),
        &effective_config.models.embedding,
        &effective_config.providers,
        ctx.llm_client.inner().http_client(),
    )
    .map_err(|e| {
        warn!(character = %char_name, error = %e, "embedder unavailable; semantic memory retrieval disabled");
    })
    .ok();

    if let Err(e) = crate::memory::deferred_edits::ensure_active_prompt_snapshot(
        &character_data_dir,
        config_dir,
        char_name,
    ) {
        warn!(character = %char_name, error = %e, "Failed to prepare active prompt snapshot");
    }

    HandlerToolContext {
        inner: SharedToolContext {
            image_dir: character_data_dir
                .join("images")
                .to_string_lossy()
                .into_owned(),
            llm_client: ctx.llm_client.inner().clone(),
            image_gen_config,
            search_config: effective_config.app.tools.web_search.clone(),
            character_name: char_name.to_owned(),
            workspace_dir: workspace_dir.to_string_lossy().into_owned(),
            markdown_store: MarkdownMemoryStore::open_sync(memory_dir).ok(),
            memory_retrieval_config: effective_config.app.memory.retrieval.clone(),
            embedder,
            memory_index_path: crate::memory::workspace_index::index_path(
                &effective_config.dirs.cache,
                char_name,
            ),
            config_dir: config_dir.to_string_lossy().into_owned(),
            character_data_dir: character_data_dir.to_string_lossy().into_owned(),
            mcp_registry: Some(std::sync::Arc::clone(&ctx.mcp_registry)),
            // Wire the sub-agent runtime only when sub-agents are configured —
            // avoids cloning the config into an Arc for every turn otherwise.
            subagent_runtime: if effective_config.app.subagents.is_empty() {
                None
            } else {
                Some(std::sync::Arc::new(
                    crate::tools::subagent::SubagentRuntime {
                        ledger_client: ctx.llm_client.clone(),
                        diagnostics: std::sync::Arc::clone(&ctx.diagnostics),
                        config: std::sync::Arc::new(effective_config.clone()),
                        direct_tx: Some(ctx.direct_tx.clone()),
                        conversation: conversation.to_vec(),
                    },
                ))
            },
        },
        autonomy_val: ctx.autonomy.clone(),
    }
}

/// Whether this request can hand its tool loop to the sidecar.
///
/// Anthropic only: the loop is built on the SDK's tool runner, which has no
/// equivalent in the other dialects, so they keep the daemon's loop. A daemon
/// with no tool socket serving also stays daemon-side, which is what makes the
/// socket's absence a graceful degradation rather than a failure.
pub(super) fn can_delegate_tool_loop(
    ctx: &GenContext,
    effective_config: &LoadedConfig,
    resolved: &shore_common::config::models::ResolvedModel,
) -> bool {
    resolved.sdk == shore_common::config::models::Sdk::Anthropic
        && effective_config.app.tools.any_enabled()
        && ctx.llm_client.inner().tool_rpc().is_some()
}

/// Stream a turn whose tool loop runs in the sidecar.
///
/// Unlike the daemon-driven path there is no separate tool phase: the single
/// call *is* the whole loop, and it comes back having already run every tool.
/// Those tools ran here, over the socket, concurrently with the stream — which
/// is why this joins two futures rather than awaiting in sequence.
///
/// The registration guard moves into the streaming future so it drops the
/// moment the stream ends. That is what closes the channel and lets the serving
/// task return; holding it in this scope instead would deadlock the join.
#[instrument(skip(ctx, effective_config, request), fields(char = char_name))]
#[expect(
    clippy::too_many_arguments,
    reason = "generation-pipeline stage; params are distinct threaded values"
)]
pub(super) async fn stream_with_sidecar_tool_loop(
    ctx: &GenContext,
    data_dir: &std::path::Path,
    char_name: &str,
    effective_config: &LoadedConfig,
    request: &mut crate::llm::types::LlmRequest,
    resolved: &shore_common::config::models::ResolvedModel,
    regen: bool,
    conversation: &[shore_common::protocol::types::Message],
) -> Result<
    (
        crate::llm::types::StreamResult,
        Vec<shore_common::protocol::types::Message>,
    ),
    Box<dyn std::error::Error + Send + Sync>,
> {
    let Some((shared_registry, socket_path)) = ctx.llm_client.inner().tool_rpc() else {
        return Err("tool RPC is not available".into());
    };
    let registry = std::sync::Arc::clone(shared_registry);

    // The loop is addressed by the request id the sidecar echoes back, so one
    // is minted here when the request has none.
    let rid = request
        .rid
        .clone()
        .unwrap_or_else(|| format!("r_{}", uuid::Uuid::new_v4()));
    request.rid = Some(rid.clone());
    request.tool_rpc = Some(crate::llm::types::ToolRpc {
        socket_path: socket_path.to_string_lossy().into_owned(),
        rid: rid.clone(),
    });
    request.max_tool_iterations = resolved.max_tool_iterations;

    let tool_ctx = build_tool_context(ctx, data_dir, char_name, effective_config, conversation);
    let thinking_enabled = thinking_enabled_from_request(request);
    let (mut calls, registration) = registry.register(rid.clone(), TOOL_CALL_QUEUE_DEPTH);

    let mut intermediate_messages: Vec<shore_common::protocol::types::Message> = Vec::new();
    let streaming = async {
        let result = crate::handler::key_fallback::stream_with_credential_fallback(
            ctx,
            request,
            resolved,
            effective_config,
            regen,
            char_name,
            thinking_enabled,
        )
        .await;
        // Ends the serving task below; see the doc comment.
        drop(registration);
        result
    };
    let serving = tools::serve_tool_calls(
        &mut calls,
        &ctx.direct_tx,
        Some(rid.as_str()),
        &tool_ctx,
        &effective_config.app.tools,
        &ctx.diagnostics,
        &mut intermediate_messages,
    );

    let (streamed, ()) = tokio::join!(streaming, serving);
    let result = streamed?;

    // The sidecar grew the conversation; this request did not. Every
    // `last_request` reuse path — keepalive ping, heartbeat, dreaming,
    // compaction — clones this body and is required to stay byte-identical to
    // what actually went out (756a308f). Left as sent, it would replay a
    // conversation missing every tool exchange, so the ping's anchors miss and
    // it rewrites the whole thing.
    //
    // The daemon-driven loop kept this true by appending as it went
    // (`append_assistant_tool_use_turn`). Here the sidecar reported what it
    // appended, and those messages are applied once the streaming future has
    // released its borrow.
    let minted_model = (!result.model.is_empty()).then(|| result.model.clone());
    for message in &intermediate_messages {
        request.messages.push(
            crate::llm::types::WireMessage::new(
                match message.role {
                    shore_common::protocol::types::Role::Assistant => {
                        crate::llm::types::WireRole::Assistant
                    }
                    shore_common::protocol::types::Role::User
                    | shore_common::protocol::types::Role::System => {
                        crate::llm::types::WireRole::User
                    }
                },
                message
                    .content_blocks
                    .iter()
                    .map(crate::llm::types::WireBlock::from_content_block)
                    .collect(),
            )
            .minted_by(request.provider_key.clone(), minted_model.clone()),
        );
    }

    debug!(
        character = char_name,
        intermediate_messages = intermediate_messages.len(),
        "sidecar-driven tool loop complete"
    );
    Ok((result, intermediate_messages))
}

/// How many tool calls may queue for one loop before the socket backpressures.
/// A model can request several tools in one turn; they run one at a time here,
/// matching what the daemon-driven loop did.
const TOOL_CALL_QUEUE_DEPTH: usize = 8;

/// Phase 11: Set up tool context and run the tool loop.
#[instrument(skip(ctx, effective_config, request, result), fields(char = char_name))]
#[expect(
    clippy::too_many_arguments,
    reason = "generation-pipeline stage; params are distinct threaded values"
)]
pub(super) async fn run_tool_phase(
    ctx: &GenContext,
    data_dir: &std::path::Path,
    char_name: &str,
    effective_config: &LoadedConfig,
    request: &mut crate::llm::types::LlmRequest,
    result: crate::llm::types::StreamResult,
    resolved: &shore_common::config::models::ResolvedModel,
    conversation: &[shore_common::protocol::types::Message],
) -> Result<tools::ToolLoopResult, Box<dyn std::error::Error + Send + Sync>> {
    debug!(character = char_name, "run_tool_phase starting");
    let tool_ctx = build_tool_context(ctx, data_dir, char_name, effective_config, conversation);

    let thinking_enabled = thinking_enabled_from_request(request);

    // Mirror `stream_with_retry`'s policy so transient blips inside the tool
    // loop are absorbed the same way they are on the first turn.
    let tool_loop_retry = tools::ToolLoopRetry {
        max_retries: effective_config
            .app
            .advanced
            .max_retries
            .unwrap_or(RetryPolicy::default().max_retries),
        backoff_base_ms: effective_config
            .app
            .advanced
            .retry_backoff
            .map_or(500, |d| d.as_millis()),
    };

    let tool_loop_result = tools::run_tool_loop(
        &ctx.llm_client,
        &ctx.direct_tx,
        request,
        result,
        &tool_ctx,
        resolved.max_tool_iterations,
        &effective_config.app.tools,
        &ctx.diagnostics,
        char_name,
        thinking_enabled,
        tool_loop_retry,
    )
    .await?;

    debug!(
        character = char_name,
        intermediate_messages = tool_loop_result.intermediate_messages.len(),
        "run_tool_phase complete"
    );
    Ok(tool_loop_result)
}
