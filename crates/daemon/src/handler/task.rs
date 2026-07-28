use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde_json::json;
use shore_common::config::character_data_dir;
use shore_common::config::models::Sdk;
use shore_common::config::LoadedConfig;
use shore_common::protocol::client_msg::ClientMessageBody;
use shore_common::protocol::types::{ContentBlock, ImageRef, Message, Role};
use tokio::sync::Mutex;
use tracing::{debug, info, instrument};

use crate::convert::u64_to_usize;
use crate::engine::messages::PendingAlt;
use crate::engine::prompt;
use crate::engine::ConversationEngine;
use crate::handler::generation::{run_tool_phase, thinking_enabled_from_request};
use crate::handler::images::{embed_image_data, ingest_images};
use crate::handler::key_fallback::stream_with_credential_fallback;
use crate::handler::persistence::persist_and_notify;
use crate::handler::resize::warm_image_cache;
use crate::llm::types::{SystemBlock, ToolResultContent, WireBlock, WireMessage, WireRole};

use super::{GenContext, GenerationParams, PrepareChatContextParams, PreparedChatContext};

/// Set up the generation engine: get or create the character engine,
/// record the incoming user turn (or capture regen alternatives), resolve
/// the active model, backfill autonomy state, and notify on new user
/// messages.
async fn setup_generation(
    ctx: &GenContext,
    params: &GenerationParams,
) -> Result<
    (
        Arc<Mutex<ConversationEngine>>,
        Option<PendingAlt>,
        shore_common::config::models::ResolvedModel,
    ),
    Box<dyn std::error::Error + Send + Sync>,
> {
    let engine_arc = {
        let mut registry = ctx.registry.lock().await;
        registry
            .get_or_create(&params.char_name)
            .map_err(|e| e.to_string())?
    };

    let regen_alt = append_user_turn(
        ctx,
        &engine_arc,
        &params.data_dir,
        &params.char_name,
        &params.body,
        params.regen,
    )
    .await?;

    // The handler resolves the active model (via preferences +
    // discovery) and passes the `ResolvedModel` through directly, so we
    // do not re-run `find_effective_model` here — discovered-only models
    // have a synthetic `qualified_name` that the resolver does not
    // accept as input. If nothing was passed, fall back to the
    // configured app default, then the first static chat model.
    let resolved_owned = resolve_generation_model(
        params.active_model.clone(),
        &params.effective_config,
        &params.sampler_overlay,
    )?;
    debug!(
        model = %resolved_owned.qualified_name,
        provider = %resolved_owned.provider_key,
        reasoning_effort = ?resolved_owned.reasoning_effort,
        sampler_overlay_active = !params.sampler_overlay.is_empty(),
        "model resolved"
    );

    ensure_and_backfill_autonomy(
        ctx,
        &engine_arc,
        &params.char_name,
        &params.effective_config,
    )
    .await;

    if !params.regen
        && (!params.body.text.is_empty()
            || !params.body.images.is_empty()
            || !params.body.image_data.is_empty())
    {
        let turn_count = engine_arc.lock().await.turn_count();
        ctx.autonomy
            .notify_user_message(&params.char_name, turn_count);
    }

    Ok((engine_arc, regen_alt, resolved_owned))
}

#[instrument(
    skip(ctx, params),
    fields(
        client_id = params.request.session.client_id.0,
        session_id = params.request.session.session_id.0,
        client_type = %params.request.session.client_type,
        char = %params.char_name,
        rid = params.rid.as_deref().unwrap_or("-")
    )
)]
pub(super) async fn handle_generation(
    ctx: GenContext,
    params: GenerationParams,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    info!(
        character = %params.char_name,
        regen = params.regen,
        text_len = params.body.text.len(),
        image_count = params.body.images.len().saturating_add(params.body.image_data.len()),
        "handle_generation starting"
    );
    let wall_clock_start = Instant::now();

    let (engine_arc, regen_alt, resolved_owned) = setup_generation(&ctx, &params).await?;
    let resolved = &resolved_owned;

    let mut request = build_generation_request(
        &engine_arc,
        &params.data_dir,
        &params.char_name,
        &params.effective_config,
        resolved,
        &params.body,
        params.regen,
        &ctx.mcp_registry,
    )
    .await;
    request.rid = params.rid.clone();
    request.forensic_character = Some(params.char_name.clone());

    // Snapshot a bounded tail of the conversation for any `{{active_history:}}`
    // macros in sub-agent prompts. Only when sub-agents are configured —
    // otherwise an empty slice, so the macro (if present) degrades to empty and
    // no per-turn clone is paid.
    let subagent_history: Vec<Message> = if params.effective_config.app.subagents.is_empty() {
        Vec::new()
    } else {
        let engine = engine_arc.lock().await;
        let msgs = engine.messages();
        let start = msgs
            .len()
            .saturating_sub(crate::tools::subagent::MAX_HISTORY_MESSAGES);
        msgs.iter().skip(start).cloned().collect()
    };

    let (result, tool_intermediate_messages) = run_generation_stream(
        &ctx,
        &params.data_dir,
        &params.char_name,
        &params.effective_config,
        &mut request,
        resolved,
        params.regen,
        &subagent_history,
    )
    .await?;

    persist_and_notify(
        &ctx,
        &engine_arc,
        &params.char_name,
        resolved,
        &result,
        &request,
        tool_intermediate_messages,
        wall_clock_start,
        regen_alt,
    )
    .await?;

    emit_post_persist_stream_end(&ctx, &engine_arc, request.rid.clone(), &result).await;

    maybe_schedule_compaction(
        &ctx,
        &engine_arc,
        &params.char_name,
        &params.effective_config,
        &params.data_dir,
        &result,
        request.rid.clone(),
    )
    .await;

    Ok(())
}

/// Record the incoming user turn (or capture the pending regen alternatives).
///
/// Returns the regeneration alternatives to thread into persistence when
/// `regen` is set; `None` when this is a fresh turn. A regen request with no
/// body content appends nothing.
async fn append_user_turn(
    ctx: &GenContext,
    engine_arc: &Arc<Mutex<ConversationEngine>>,
    data_dir: &Path,
    char_name: &str,
    body: &ClientMessageBody,
    regen: bool,
) -> Result<Option<PendingAlt>, Box<dyn std::error::Error + Send + Sync>> {
    let mut engine = engine_arc.lock().await;
    if regen {
        return Ok(Some(engine.pending_regen_alt().unwrap_or(PendingAlt {
            alternatives: Vec::new(),
        })));
    }
    if body.text.is_empty() && body.images.is_empty() && body.image_data.is_empty() {
        // Regen with no body content: nothing to append.
        return Ok(None);
    }

    let (images, mut content_blocks) =
        ingest_images(data_dir, char_name, &body.images, &body.image_data);
    // Only append a text block when there is text. An image-only message
    // (empty `text`, non-empty images) must not carry an empty text block:
    // it persists into history and later breaks Anthropic requests when a
    // prompt-cache breakpoint lands on it ("cache_control cannot be set for
    // empty text blocks").
    if !body.text.is_empty() {
        content_blocks.push(ContentBlock::Text {
            text: body.text.clone(),
        });
    }

    let user_msg = Message {
        msg_id: format!("m_{}", uuid::Uuid::new_v4()),
        origin: None,
        role: Role::User,
        content: body.text.clone(),
        images,
        content_blocks,
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        provider_key: None,
        model: None,
        timestamp: chrono::Local::now().to_rfc3339(),
    };
    engine.append_message(user_msg.clone())?;
    let revision = engine.current_revision();
    let mut wire_msg = user_msg;
    wire_msg.origin = Some(shore_common::protocol::server_msg::MessageOrigin::UserInput);
    embed_image_data(&mut wire_msg.images);
    let _ignored = ctx.event_tx.send(
        shore_common::protocol::server_msg::ServerMessage::NewMessage(
            shore_common::protocol::server_msg::NewMessage {
                revision,
                character: Some(char_name.to_owned()),
                message: wire_msg,
            },
        ),
    );
    Ok(None)
}

/// Resolve the active model for this generation and apply any per-model
/// sampler overlay.
///
/// `active_model` is the pre-resolved model threaded through from preference
/// resolution; when absent we fall back to the configured app default, then the
/// first static chat model. App-level defaults are user configuration, not a
/// discovery-cache selection — `discovery.ignore` still applies for safety, but
/// a misspelled default should surface.
fn resolve_generation_model(
    active_model: Option<shore_common::config::models::ResolvedModel>,
    effective_config: &LoadedConfig,
    sampler_overlay: &crate::preferences::SamplerSettings,
) -> Result<shore_common::config::models::ResolvedModel, Box<dyn std::error::Error + Send + Sync>> {
    let resolved_base = match active_model {
        Some(m) => m,
        None => match effective_config.app.defaults.model.as_deref() {
            Some(name) => crate::effective_catalog::find_effective_model(
                effective_config,
                &effective_config.dirs.cache,
                name,
                true,
            )
            .map_err(|e| e.to_string())?,
            None => effective_config
                .models
                .first_chat_model()
                .cloned()
                .ok_or("No model configured")?,
        },
    };
    if sampler_overlay.is_empty() {
        Ok(resolved_base)
    } else {
        Ok(crate::preferences::apply_sampler_overlay(
            &resolved_base,
            sampler_overlay,
        ))
    }
}

/// Ensure the per-character autonomy state exists and, when first created,
/// backfill its activity tracker from recent chat history (live + archived
/// segments, user turns within the last 90 days).
async fn ensure_and_backfill_autonomy(
    ctx: &GenContext,
    engine_arc: &Arc<Mutex<ConversationEngine>>,
    char_name: &str,
    effective_config: &LoadedConfig,
) {
    let is_new_autonomy_state = ctx
        .autonomy
        .ensure_state_with_config(char_name, Some(effective_config));
    if !is_new_autonomy_state {
        return;
    }

    let engine = engine_arc.lock().await;
    let now = chrono::Local::now().naive_local();
    let cutoff = now
        .checked_sub_signed(chrono::Duration::days(90))
        .unwrap_or(now);
    let mut timestamps: Vec<chrono::NaiveDateTime> = Vec::new();

    let mut collect = |msgs: &[Message]| {
        for msg in msgs
            .iter()
            .filter(|msg| msg.role == Role::User && !msg.is_tool_result_only())
        {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&msg.timestamp) {
                let naive = dt.with_timezone(&chrono::Local).naive_local();
                if naive >= cutoff {
                    timestamps.push(naive);
                }
            }
        }
    };

    collect(engine.messages());
    let segments = engine.segments();
    for i in 0..segments.segment_count() {
        if let Ok(segment_msgs) = segments.read_segment(i) {
            collect(&segment_msgs);
        }
    }

    drop(engine);

    if !timestamps.is_empty() {
        info!(
            character = %char_name,
            count = timestamps.len(),
            "Backfilling activity tracker from chat history"
        );
        ctx.autonomy.backfill_activity(char_name, &timestamps);
    }
}

/// Assemble the prompt, warm the image cache, and build the LLM request
/// (sans API key — the credential-fallback wrapper resolves and rewrites the
/// key just-in-time during rotation). Client-supplied overrides are applied
/// last. The caller sets `rid` / `forensic_character` on the returned request.
#[expect(
    clippy::too_many_arguments,
    reason = "request assembly threads several independent inputs; bundling them would just relocate the noise"
)]
async fn build_generation_request(
    engine_arc: &Arc<Mutex<ConversationEngine>>,
    data_dir: &Path,
    char_name: &str,
    effective_config: &LoadedConfig,
    resolved: &shore_common::config::models::ResolvedModel,
    body: &ClientMessageBody,
    regen: bool,
    mcp_registry: &crate::tools::mcp_registry::McpRegistry,
) -> crate::llm::types::LlmRequest {
    let (messages, has_prior_context) = {
        let engine = engine_arc.lock().await;
        let has_prior = engine.segments().segment_count() > 0;
        (
            if regen {
                engine.messages_through_last_user_turn()
            } else {
                engine.messages().to_vec()
            },
            has_prior,
        )
    };

    let character_data_dir = character_data_dir(data_dir, char_name);
    // Filter the live MCP surface by the character's `enabled_tools` allowlist
    // (exact names or `mcp__server__*` globs); appended last for a stable prefix.
    let mcp_tool_defs = mcp_registry.tool_defs_filtered(&effective_config.app.tools.enabled_tools);
    let PreparedChatContext {
        llm_messages,
        system,
        tool_defs,
        prompt: prompt_result,
    } = super::prepare_chat_context(PrepareChatContextParams {
        character: char_name,
        character_data_dir: &character_data_dir,
        config: effective_config,
        resolved,
        messages: &messages,
        has_prior_context,
        mcp_tool_defs: &mcp_tool_defs,
    });

    warm_image_cache(
        &prompt_result.messages,
        effective_config.app.advanced.max_image_size,
        &effective_config.dirs.cache,
    )
    .await;

    let mut request = crate::llm::LlmClient::build_request_with_resolved_key(
        resolved,
        String::new(),
        llm_messages,
        system,
        tool_defs,
        None,
        resolved.resolved_replay_prior_thinking(&effective_config.app),
    );

    if let Some(ref ov) = body.overrides {
        if let Some(t) = ov.temperature {
            request.temperature = Some(t);
        }
        if let Some(p) = ov.top_p {
            request.top_p = Some(p);
        }
        if let Some(budget) = ov.thinking_budget {
            request
                .provider_options
                .get_or_insert_default()
                .budget_tokens = Some(budget);
        }
    }

    request
}

/// Stream the LLM response, then run the tool-use phase when the model
/// requested tools and tool use is enabled. Returns the final stream result
/// plus any intermediate (tool-loop) messages to persist.
#[expect(
    clippy::too_many_arguments,
    reason = "generation-pipeline stage; params are distinct threaded values"
)]
async fn run_generation_stream(
    ctx: &GenContext,
    data_dir: &Path,
    char_name: &str,
    effective_config: &LoadedConfig,
    request: &mut crate::llm::types::LlmRequest,
    resolved: &shore_common::config::models::ResolvedModel,
    regen: bool,
    conversation: &[Message],
) -> Result<(crate::llm::types::StreamResult, Vec<Message>), Box<dyn std::error::Error + Send + Sync>>
{
    info!(
        model = %resolved.model_id,
        messages = request.messages.len(),
        "Sending streaming request to LLM"
    );

    let thinking_enabled = thinking_enabled_from_request(request);

    let mut result = stream_with_credential_fallback(
        ctx,
        request,
        resolved,
        effective_config,
        regen,
        char_name,
        thinking_enabled,
    )
    .await?;

    let tool_intermediate_messages =
        if result.finish_reason == "tool_use" && effective_config.app.tools.any_enabled() {
            let tool_loop_result = run_tool_phase(
                ctx,
                data_dir,
                char_name,
                effective_config,
                request,
                result,
                resolved,
                conversation,
            )
            .await?;
            result = tool_loop_result.result;
            tool_loop_result.intermediate_messages
        } else {
            Vec::new()
        };

    Ok((result, tool_intermediate_messages))
}

/// Emit StreamEnd ONLY after persistence completes — clients that issue an
/// immediate follow-up command (e.g. `memory_compact` via shore-mcp) would
/// otherwise race the persist write and snapshot stale engine state. See
/// ARCHITECTURE.md (runtime flow).
async fn emit_post_persist_stream_end(
    ctx: &GenContext,
    engine_arc: &Arc<Mutex<ConversationEngine>>,
    rid: Option<String>,
    result: &crate::llm::types::StreamResult,
) {
    let (stream_msg_id, stream_revision) = {
        let engine = engine_arc.lock().await;
        (
            engine.messages().last().map(|m| m.msg_id.clone()),
            Some(engine.current_revision()),
        )
    };

    crate::llm::stream::emit_stream_end(
        &ctx.direct_tx,
        rid,
        result,
        true,
        stream_msg_id,
        stream_revision,
    )
    .await;
}

/// Check whether this turn crossed a compaction threshold and, if so, schedule
/// an inline compaction on a detached task.
async fn maybe_schedule_compaction(
    ctx: &GenContext,
    engine_arc: &Arc<Mutex<ConversationEngine>>,
    char_name: &str,
    effective_config: &LoadedConfig,
    data_dir: &Path,
    result: &crate::llm::types::StreamResult,
    rid: Option<String>,
) {
    let (turn_count, context_tokens, should_compact) = {
        let engine = engine_arc.lock().await;
        let turn_count = engine.turn_count();
        let context_tokens = u64_to_usize(result.usage.input_tokens)
            .saturating_add(u64_to_usize(result.usage.cache_read_tokens))
            .saturating_add(u64_to_usize(result.usage.cache_creation_tokens));
        let should_compact = ctx
            .autonomy
            .should_compact_now(char_name, turn_count, context_tokens);
        (turn_count, context_tokens, should_compact)
    };
    if should_compact {
        info!(
            character = %char_name,
            turn_count,
            context_tokens,
            "Scheduling inline compaction"
        );
        spawn_inline_compaction(
            ctx.clone(),
            Arc::clone(engine_arc),
            char_name.to_owned(),
            effective_config.clone(),
            data_dir.to_path_buf(),
            rid,
            ctx.autonomy.cached_last_request(char_name),
        );
    }
}

fn spawn_inline_compaction(
    ctx: GenContext,
    engine_arc: Arc<Mutex<ConversationEngine>>,
    char_name: String,
    effective_config: LoadedConfig,
    data_dir: PathBuf,
    rid: Option<String>,
    cached_request: Option<crate::llm::types::LlmRequest>,
) {
    let _ignored = tokio::spawn(async move {
        run_inline_compaction(
            ctx,
            engine_arc,
            char_name,
            effective_config,
            data_dir,
            rid,
            cached_request,
        )
        .await;
    });
}

async fn run_inline_compaction(
    ctx: GenContext,
    engine_arc: Arc<Mutex<ConversationEngine>>,
    char_name: String,
    effective_config: LoadedConfig,
    data_dir: PathBuf,
    rid: Option<String>,
    cached_request: Option<crate::llm::types::LlmRequest>,
) {
    let _ignored = ctx
        .direct_tx
        .send(
            shore_common::protocol::server_msg::ServerMessage::Phase(
                shore_common::protocol::server_msg::Phase {
                    rid: None,
                    phase: "compacting".into(),
                    model: None,
                },
            )
            .with_rid(rid),
        )
        .await;

    match crate::memory::compaction::run_compaction(
        &char_name,
        &effective_config,
        &ctx.llm_client,
        &ctx.notifier,
        cached_request,
        None,
        false,
    )
    .await
    {
        Ok(retained_count) => {
            {
                let mut engine = engine_arc.lock().await;
                if let Err(e) = engine.reload() {
                    tracing::warn!(
                        character = %char_name,
                        error = %e,
                        "Inline compaction: engine reload failed"
                    );
                    ctx.autonomy.notify_compaction_failed(&char_name);
                    return;
                }
            }

            // Apply deferred character self-edits now that the cache
            // has been busted by the engine reload.
            let character_data_dir = character_data_dir(&data_dir, &char_name);
            if let Err(e) = crate::memory::deferred_edits::apply_deferred_edits(
                &character_data_dir,
                &effective_config.dirs.config,
                &char_name,
            ) {
                tracing::warn!(
                    character = %char_name,
                    error = %e,
                    "Failed to apply deferred edits after inline compaction"
                );
            }

            ctx.autonomy
                .notify_compaction_complete(&char_name, retained_count);
            info!(
                character = %char_name,
                retained_count,
                "Inline compaction complete, engine reloaded"
            );
        }
        Err(e) => {
            tracing::warn!(
                character = %char_name,
                error = %e,
                "Inline compaction failed"
            );
            ctx.autonomy.notify_compaction_failed(&char_name);
        }
    }
}

/// How images attached to *assistant* messages render on the wire.
///
/// Anthropic rejects raw `image` blocks inside assistant turns at any
/// position, and one such turn fails the entire request — so a persisted
/// assistant message carrying a generated image (heartbeat `generate_image`,
/// #293) would wedge the conversation if replayed directly.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum AssistantImageMode {
    /// Replay the image as the tool call it originally was: the assistant
    /// turn gains a synthetic `generate_image` `tool_use` block and the
    /// following user turn carries the matching `tool_result` with the image
    /// and caption. This is the only wire position where the model can
    /// actually see the image it generated.
    ToolPair,
    /// Fold the image into a caption-derived text stand-in on the assistant
    /// turn itself. Used when tool blocks can't ship: non-Anthropic dialects
    /// (image-bearing `tool_result` blocks aren't portable across the other
    /// SDKs' tool-message shapes) and requests without tool definitions
    /// (tool blocks require a non-empty `tools` param).
    TextStandin,
}

impl AssistantImageMode {
    pub(crate) fn for_request(sdk: &Sdk, has_tool_defs: bool) -> Self {
        if *sdk == Sdk::Anthropic && has_tool_defs {
            Self::ToolPair
        } else {
            Self::TextStandin
        }
    }
}

/// Rendered wire form of the images attached to one assistant message.
struct AssistantImageRender {
    /// Blocks appended to the assistant turn itself (`tool_use` or text
    /// stand-ins).
    assistant_blocks: Vec<WireBlock>,
    /// `tool_result` blocks owed to the turn immediately after the assistant
    /// message (empty in [`AssistantImageMode::TextStandin`]).
    tool_results: Vec<WireBlock>,
}

fn render_assistant_images(
    images: &[ImageRef],
    mode: AssistantImageMode,
    max_image_size: u64,
    cache_dir: &Path,
) -> AssistantImageRender {
    let mut render = AssistantImageRender {
        assistant_blocks: Vec::new(),
        tool_results: Vec::new(),
    };
    for (index, img) in images.iter().enumerate() {
        let encoded = match mode {
            AssistantImageMode::ToolPair => {
                super::images::encode_image_block(img, max_image_size, cache_dir)
            }
            AssistantImageMode::TextStandin => None,
        };
        let caption = img
            .caption
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty());
        match encoded {
            Some(source) => {
                let id = synthetic_tool_use_id(&img.path, index);
                render.assistant_blocks.push(WireBlock::ToolUse {
                    id: id.clone(),
                    name: "generate_image".to_owned(),
                    // The generation prompt isn't persisted, so the input
                    // carries only what is: the caption.
                    input: match caption {
                        Some(c) => json!({ "caption": c }),
                        None => json!({}),
                    },
                });
                let mut result_content = vec![WireBlock::Image { source }];
                if let Some(c) = caption {
                    result_content.push(WireBlock::text(c));
                }
                render.tool_results.push(WireBlock::ToolResult {
                    tool_use_id: id,
                    content: ToolResultContent::Blocks(result_content),
                    is_error: false,
                });
            }
            // TextStandin mode — or the image failed to encode (missing/
            // unreadable file), where emitting the `tool_use` anyway would
            // leave it dangling without a result and fail the request.
            None => {
                render.assistant_blocks.push(WireBlock::text(match caption {
                    Some(c) => format!("[sent an image: {c}]"),
                    None => "[sent an image]".to_owned(),
                }));
            }
        }
    }
    render
}

/// Deterministic `tool_use` id for a replayed generated image. The same
/// history must render byte-identically across requests, processes, and
/// daemon restarts (prompt-cache stability), so the id derives from the
/// image's file stem — unique per generated image — never from randomness
/// or an unstable hash.
fn synthetic_tool_use_id(path: &str, index: usize) -> String {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let safe: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(48)
        .collect();
    format!("toolu_gen_{index}_{safe}")
}

/// Render one prompt message's wire content blocks, plus the `tool_result`
/// blocks it owes the following turn (generated-image replay — see
/// [`AssistantImageMode`]).
///
/// Returns `None` for a message that rendered to nothing. This happens for a
/// degenerate persisted turn that carries no usable content (e.g. an assistant
/// turn that ended a tool loop without emitting any final text). Anthropic
/// rejects such a turn with "messages: text content blocks must be non-empty",
/// failing the *entire* request, so any conversation whose window contains one
/// could no longer generate. Mirrors the empty-turn skip in
/// `append_response_messages_to_request`.
///
/// What this deliberately does *not* do is decide which blocks a provider will
/// accept. Carrier-less thinking, thinking minted by another model, and prior
/// turns' thinking under a `none` replay setting all ship from here and are
/// filtered by the adapter, which is the only side that knows the provider.
///
/// Whitespace-only blocks are skipped here too, but not as a wire decision:
/// this side has to know whether the stored blocks render to anything in order
/// to choose between them and the derived `content` string, and only this side
/// has that string. The *guarantee* that no empty text block reaches a provider
/// is the adapter's, because the tool-loop and `last_request` append paths never
/// come through here.
fn render_message_content(
    m: &prompt::PromptMessage,
    max_image_size: u64,
    cache_dir: &Path,
    assistant_image_mode: AssistantImageMode,
) -> Option<(Vec<WireBlock>, Vec<WireBlock>)> {
    // Images on assistant turns can't ship as raw `image` blocks (see
    // `AssistantImageMode`); render them separately and keep them out of
    // the shared content paths below.
    let image_render = (m.role == Role::Assistant && !m.images.is_empty()).then(|| {
        render_assistant_images(&m.images, assistant_image_mode, max_image_size, cache_dir)
    });
    let turn_images: &[ImageRef] = if image_render.is_some() {
        &[]
    } else {
        &m.images
    };

    let mut content = if m.content_blocks.is_empty() {
        super::build_content(&m.content, turn_images, max_image_size, cache_dir)
    } else {
        let mut blocks: Vec<WireBlock> = Vec::new();
        for img in turn_images {
            if let Some(source) = super::images::encode_image_block(img, max_image_size, cache_dir)
            {
                blocks.push(WireBlock::Image { source });
            }
        }
        blocks.extend(
            m.content_blocks
                .iter()
                .filter(|b| !matches!(b, ContentBlock::Text { text } if text.trim().is_empty()))
                .map(WireBlock::from_content_block),
        );

        // A turn whose only stored block was empty text renders to nothing;
        // fall back to the derived `content` string so a turn with text in it
        // is not silently dropped.
        if blocks.is_empty() {
            super::build_content(&m.content, turn_images, max_image_size, cache_dir)
        } else {
            blocks
        }
    };

    if let Some(render) = &image_render {
        content.extend(render.assistant_blocks.iter().cloned());
    }

    if content.is_empty() {
        return None;
    }

    Some((
        content,
        image_render.map(|r| r.tool_results).unwrap_or_default(),
    ))
}

/// Convert assembled prompt messages into the wire message list.
pub(crate) fn build_llm_messages(
    prompt_result: &prompt::AssembledPrompt,
    max_image_size: u64,
    cache_dir: &Path,
    assistant_image_mode: AssistantImageMode,
) -> (Vec<WireMessage>, Vec<SystemBlock>) {
    let mut llm_messages: Vec<WireMessage> = Vec::new();
    // `tool_result` blocks owed by a preceding assistant turn whose images
    // rendered as synthetic `generate_image` tool calls. The API requires a
    // tool_use's result in the turn immediately after it, so these merge into
    // the front of the next emitted user message — or a user turn of their
    // own when the next emitted message isn't one (or nothing follows).
    let mut pending_tool_results: Vec<WireBlock> = Vec::new();

    for m in &prompt_result.messages {
        let role = match m.role {
            Role::User => WireRole::User,
            Role::Assistant => WireRole::Assistant,
            Role::System => WireRole::System,
        };
        let Some((rendered, owed_tool_results)) =
            render_message_content(m, max_image_size, cache_dir, assistant_image_mode)
        else {
            // Dropped empty turn; owed tool_results (if any) survive to the
            // next emitted message.
            continue;
        };

        let content = if pending_tool_results.is_empty() {
            rendered
        } else {
            let mut owed = std::mem::take(&mut pending_tool_results);
            if m.role == Role::User {
                owed.extend(rendered);
                owed
            } else {
                llm_messages.push(WireMessage::new(WireRole::User, owed));
                rendered
            }
        };

        // Provenance travels with the turn so the adapter can decide whether
        // this turn's thinking is replayable to the active model.
        llm_messages.push(
            WireMessage::new(role, content).minted_by(m.provider_key.clone(), m.model.clone()),
        );
        pending_tool_results.extend(owed_tool_results);
    }

    if !pending_tool_results.is_empty() {
        llm_messages.push(WireMessage::new(WireRole::User, pending_tool_results));
    }

    // Every block keeps its label. This used to fork on count — one block
    // serialized as a bare string, dropping the label with it — so a
    // single-block system prompt silently lost the anchor placement the label
    // exists to drive.
    let system: Vec<SystemBlock> = prompt_result
        .system
        .iter()
        .map(|b| SystemBlock::new(b.content.clone(), b.label.clone()))
        .collect();

    (llm_messages, system)
}

#[cfg(test)]
mod build_llm_messages_tests {
    use super::*;
    use crate::engine::prompt::{AssembledPrompt, PromptMessage};
    use serde_json::Value;

    fn pm(role: Role, content_blocks: Vec<ContentBlock>) -> PromptMessage {
        PromptMessage {
            role,
            content: String::new(),
            images: vec![],
            content_blocks,
            provider_key: None,
            model: None,
        }
    }

    fn pm_img(
        role: Role,
        content_blocks: Vec<ContentBlock>,
        images: Vec<ImageRef>,
    ) -> PromptMessage {
        let mut m = pm(role, content_blocks);
        m.images = images;
        m
    }

    fn img(path: &str, caption: Option<&str>) -> ImageRef {
        ImageRef {
            path: path.to_owned(),
            caption: caption.map(str::to_owned),
            data: None,
        }
    }

    /// Write a tiny valid PNG (well under the test max_image_size, so the
    /// resize path never triggers) and return its path.
    fn write_test_image(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        image::RgbImage::from_pixel(4, 4, image::Rgb([200, 120, 40]))
            .save(&path)
            .unwrap();
        path.to_string_lossy().into_owned()
    }

    /// Render and serialize, so the assertions below read the bytes that
    /// actually cross the seam rather than the in-memory shape.
    fn build_with_mode(messages: Vec<PromptMessage>, mode: AssistantImageMode) -> Vec<Value> {
        let prompt = AssembledPrompt {
            system: vec![],
            messages,
        };
        let (llm_messages, _) = build_llm_messages(&prompt, 1024, Path::new("/tmp"), mode);
        llm_messages
            .iter()
            .map(|m| serde_json::to_value(m).expect("WireMessage serializes"))
            .collect()
    }

    fn build(messages: Vec<PromptMessage>) -> Vec<Value> {
        build_with_mode(messages, AssistantImageMode::ToolPair)
    }

    fn content(m: &Value) -> &Vec<Value> {
        m["content"].as_array().unwrap()
    }

    #[test]
    fn empty_text_block_is_dropped_from_wire_content() {
        let msgs = build(vec![pm(
            Role::Assistant,
            vec![
                ContentBlock::Text {
                    text: "look".into(),
                },
                ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "search".into(),
                    input: json!({}),
                },
                ContentBlock::Text {
                    text: String::new(),
                },
            ],
        )]);
        let blocks = content(&msgs[0]);
        // The trailing empty text block is gone; real blocks remain.
        assert_eq!(blocks.len(), 2);
        assert!(blocks.iter().all(|b| b["text"] != ""));
        assert_eq!(blocks[1]["type"], "tool_use");
    }

    #[test]
    fn message_of_only_empty_text_falls_back_to_non_empty_string_content() {
        // A degenerate message whose only block is empty text must not produce
        // an empty content array (the API rejects that too).
        let mut msg = pm(Role::User, vec![ContentBlock::Text { text: "  ".into() }]);
        msg.content = "fallback".into();
        let msgs = build(vec![msg]);
        assert_eq!(
            msgs[0]["content"],
            json!([{"type": "text", "text": "fallback"}])
        );
    }

    #[test]
    fn fully_empty_message_is_dropped_from_the_wire() {
        // A persisted assistant turn with no blocks, no content, and no images
        // (e.g. a tool loop that ended without final text) renders to nothing.
        // It must be dropped entirely — shipping `content: ""` makes Anthropic
        // reject the whole request ("text content blocks must be non-empty").
        let real = pm(Role::User, vec![ContentBlock::Text { text: "hi".into() }]);
        let empty = pm(Role::Assistant, vec![]); // content "", no images
        let msgs = build(vec![real, empty]);
        assert_eq!(msgs.len(), 1, "the empty turn is dropped");
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(content(&msgs[0])[0]["text"], "hi");
    }

    #[test]
    fn message_whose_blocks_all_drop_is_removed_when_no_string_fallback() {
        // Blocks that all filter out (empty text only) and no `content` string
        // to fall back to: the message must be dropped, not shipped empty.
        let msgs = build(vec![pm(
            Role::Assistant,
            vec![ContentBlock::Text { text: "   ".into() }],
        )]);
        assert!(msgs.is_empty(), "message with no usable content is dropped");
    }

    #[test]
    fn assistant_image_replays_as_generate_image_tool_pair() {
        // Anthropic rejects raw `image` blocks in assistant turns, so a
        // persisted generated image replays as the tool call it originally
        // was: tool_use on the assistant turn, tool_result (image + caption)
        // merged into the front of the next user turn.
        let dir = tempfile::tempdir().unwrap();
        let path = write_test_image(dir.path(), "20260711_121732.jpg");
        let msgs = build(vec![
            pm(Role::User, vec![ContentBlock::Text { text: "hi".into() }]),
            pm_img(
                Role::Assistant,
                vec![ContentBlock::Text {
                    text: "made you a thing".into(),
                }],
                vec![img(&path, Some("sunset over the bay"))],
            ),
            pm(
                Role::User,
                vec![ContentBlock::Text {
                    text: "thanks".into(),
                }],
            ),
        ]);
        assert_eq!(
            msgs.len(),
            3,
            "no extra turn is injected when a user turn follows"
        );

        let assistant = content(&msgs[1]);
        assert_eq!(assistant[0]["text"], "made you a thing");
        assert_eq!(assistant[1]["type"], "tool_use");
        assert_eq!(assistant[1]["name"], "generate_image");
        assert_eq!(assistant[1]["input"]["caption"], "sunset over the bay");
        assert!(assistant.iter().all(|b| b["type"] != "image"));

        let user = content(&msgs[2]);
        assert_eq!(user[0]["type"], "tool_result");
        assert_eq!(user[0]["tool_use_id"], assistant[1]["id"]);
        assert_eq!(user[0]["content"][0]["type"], "image");
        assert_eq!(user[0]["content"][1]["text"], "sunset over the bay");
        assert_eq!(user[1]["text"], "thanks");
    }

    #[test]
    fn image_only_assistant_turn_at_history_end_gets_own_tool_result_turn() {
        // The exact shape that wedged a live conversation: an autonomous
        // heartbeat message whose only content is a generated image, sitting
        // at the end of the rendered history.
        let dir = tempfile::tempdir().unwrap();
        let path = write_test_image(dir.path(), "gen.png");
        let msgs = build(vec![
            pm(Role::User, vec![ContentBlock::Text { text: "hi".into() }]),
            pm_img(Role::Assistant, vec![], vec![img(&path, None)]),
        ]);
        assert_eq!(
            msgs.len(),
            3,
            "owed tool_result flushes as its own user turn"
        );

        let assistant = content(&msgs[1]);
        assert_eq!(assistant.len(), 1);
        assert_eq!(assistant[0]["type"], "tool_use");
        assert_eq!(assistant[0]["input"], json!({}));

        assert_eq!(msgs[2]["role"], "user");
        let flushed = content(&msgs[2]);
        assert_eq!(flushed.len(), 1);
        assert_eq!(flushed[0]["type"], "tool_result");
        assert_eq!(flushed[0]["tool_use_id"], assistant[0]["id"]);
        assert_eq!(flushed[0]["content"][0]["type"], "image");
    }

    #[test]
    fn text_standin_mode_folds_assistant_image_into_caption_text() {
        // Non-Anthropic dialects and tool-less requests can't carry tool
        // blocks: the image becomes a text stand-in and no turn is injected.
        // The stand-in never reads the file, so the path may not exist.
        let msgs = build_with_mode(
            vec![
                pm_img(
                    Role::Assistant,
                    vec![ContentBlock::Text {
                        text: "made you a thing".into(),
                    }],
                    vec![img("/nonexistent/gen.jpg", Some("sunset"))],
                ),
                pm(
                    Role::User,
                    vec![ContentBlock::Text {
                        text: "thanks".into(),
                    }],
                ),
            ],
            AssistantImageMode::TextStandin,
        );
        assert_eq!(msgs.len(), 2);
        let assistant = content(&msgs[0]);
        assert_eq!(assistant[1]["type"], "text");
        assert_eq!(assistant[1]["text"], "[sent an image: sunset]");
        assert_eq!(content(&msgs[1])[0]["text"], "thanks");
    }

    #[test]
    fn unreadable_assistant_image_degrades_to_text_standin() {
        // A tool_use whose image can't be encoded would dangle without its
        // result and fail the request — degrade to the stand-in instead.
        let msgs = build(vec![pm_img(
            Role::Assistant,
            vec![],
            vec![img("/nonexistent/gone.jpg", None)],
        )]);
        assert_eq!(msgs.len(), 1);
        let assistant = content(&msgs[0]);
        assert_eq!(assistant.len(), 1);
        assert_eq!(
            assistant[0],
            json!({ "type": "text", "text": "[sent an image]" })
        );
    }

    #[test]
    fn assistant_image_render_is_deterministic_across_calls() {
        // Prompt-cache stability: identical history must render to identical
        // JSON, so the synthetic tool_use ids derive from the image path —
        // never from randomness or an unstable hash.
        let dir = tempfile::tempdir().unwrap();
        let path = write_test_image(dir.path(), "20260711_121732.jpg");
        let history = || {
            vec![
                pm_img(Role::Assistant, vec![], vec![img(&path, Some("sunset"))]),
                pm(
                    Role::User,
                    vec![ContentBlock::Text {
                        text: "thanks".into(),
                    }],
                ),
            ]
        };
        assert_eq!(build(history()), build(history()));
    }

    #[test]
    fn user_images_still_render_as_raw_image_blocks() {
        // Only *assistant* turns reroute images; user attachments keep the
        // plain image-block shape.
        let dir = tempfile::tempdir().unwrap();
        let path = write_test_image(dir.path(), "upload.png");
        let mut m = pm_img(Role::User, vec![], vec![img(&path, None)]);
        m.content = "look at this".into();
        let msgs = build(vec![m]);
        let user = content(&msgs[0]);
        assert_eq!(user[0]["type"], "image");
        assert_eq!(user[1]["text"], "look at this");
    }
}
