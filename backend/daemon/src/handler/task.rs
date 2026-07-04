use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use shore_config::character_data_dir;
use shore_config::LoadedConfig;
use shore_protocol::client_msg::ClientMessageBody;
use shore_protocol::types::{ContentBlock, Message, Role};
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
        shore_config::models::ResolvedModel,
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

    let (result, tool_intermediate_messages) = run_generation_stream(
        &ctx,
        &params.data_dir,
        &params.char_name,
        &params.effective_config,
        &mut request,
        resolved,
        params.regen,
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
        // Per-model override (preferences overlay) falls back to the global
        // `[memory.thinking]` default. The effect is model-dependent — see #129.
        resolved.replay_prior_thinking.unwrap_or(
            params
                .effective_config
                .app
                .memory
                .thinking
                .replay_prior_thinking,
        ),
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
    wire_msg.origin = Some(shore_protocol::server_msg::MessageOrigin::UserInput);
    embed_image_data(&mut wire_msg.images);
    let _ignored = ctx
        .event_tx
        .send(shore_protocol::server_msg::ServerMessage::NewMessage(
            shore_protocol::server_msg::NewMessage {
                revision,
                character: Some(char_name.to_owned()),
                message: wire_msg,
            },
        ));
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
    active_model: Option<shore_config::models::ResolvedModel>,
    effective_config: &LoadedConfig,
    sampler_overlay: &crate::preferences::SamplerSettings,
) -> Result<shore_config::models::ResolvedModel, Box<dyn std::error::Error + Send + Sync>> {
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
    resolved: &shore_config::models::ResolvedModel,
    body: &ClientMessageBody,
    regen: bool,
    mcp_registry: &crate::tools::mcp_registry::McpRegistry,
) -> shore_llm::types::LlmRequest {
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
    let include_unsigned_thinking = resolved.sdk.echoes_unsigned_thinking();
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
        include_unsigned_thinking,
        mcp_tool_defs: &mcp_tool_defs,
    });

    warm_image_cache(
        &prompt_result.messages,
        effective_config.app.advanced.max_image_size,
        &effective_config.dirs.cache,
    )
    .await;

    let mut request = shore_llm::LlmClient::build_request_with_resolved_key(
        resolved,
        String::new(),
        llm_messages,
        system,
        tool_defs,
        None,
    );

    if let Some(ref ov) = body.overrides {
        if let Some(t) = ov.temperature {
            request.temperature = Some(t);
        }
        if let Some(p) = ov.top_p {
            request.top_p = Some(p);
        }
        if let Some(budget) = ov.thinking_budget {
            let opts = request
                .provider_options
                .get_or_insert_with(|| Value::Object(serde_json::Map::new()));
            if let Some(map) = opts.as_object_mut() {
                let _ignored = map.insert("budget_tokens".into(), serde_json::json!(budget));
            }
        }
    }

    request
}

/// Stream the LLM response, then run the tool-use phase when the model
/// requested tools and tool use is enabled. Returns the final stream result
/// plus any intermediate (tool-loop) messages to persist.
async fn run_generation_stream(
    ctx: &GenContext,
    data_dir: &Path,
    char_name: &str,
    effective_config: &LoadedConfig,
    request: &mut shore_llm::types::LlmRequest,
    resolved: &shore_config::models::ResolvedModel,
    regen: bool,
) -> Result<(shore_llm::types::StreamResult, Vec<Message>), Box<dyn std::error::Error + Send + Sync>>
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
    result: &shore_llm::types::StreamResult,
) {
    let (stream_msg_id, stream_revision) = {
        let engine = engine_arc.lock().await;
        (
            engine.messages().last().map(|m| m.msg_id.clone()),
            Some(engine.current_revision()),
        )
    };

    shore_llm::stream::emit_stream_end(
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
    result: &shore_llm::types::StreamResult,
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
    cached_request: Option<shore_llm::types::LlmRequest>,
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
    cached_request: Option<shore_llm::types::LlmRequest>,
) {
    let _ignored = ctx
        .direct_tx
        .send(
            shore_protocol::server_msg::ServerMessage::Phase(shore_protocol::server_msg::Phase {
                rid: None,
                phase: "compacting".into(),
                model: None,
            })
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

/// Convert assembled prompt messages into LLM API JSON format.
pub(crate) fn build_llm_messages(
    prompt_result: &prompt::AssembledPrompt,
    include_unsigned_thinking: bool,
    max_image_size: u64,
    cache_dir: &Path,
    active_provider_key: &str,
) -> (Vec<Value>, Option<Value>) {
    let llm_messages: Vec<Value> = prompt_result
        .messages
        .iter()
        .filter_map(|m| {
            let role = match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::System => "system",
            };
            let content = if m.content_blocks.is_empty() {
                super::build_content(&m.content, &m.images, max_image_size, cache_dir)
            } else {
                let mut blocks: Vec<Value> = Vec::new();

                for img in &m.images {
                    if let Some(block) =
                        super::images::encode_image_block(img, max_image_size, cache_dir)
                    {
                        blocks.push(block);
                    }
                }

                // Drop opaque thinking data (signatures, redacted blobs) that
                // a different provider minted — replaying it to the active
                // provider hard-fails the request.
                let minting = m.provider_key.as_deref();
                let portable = m.content_blocks.iter().filter(|b| {
                    crate::content_util::thinking_block_portable_to(b, minting, active_provider_key)
                });
                if include_unsigned_thinking {
                    blocks.extend(portable.filter_map(|b| {
                        // Drop empty text blocks even on the unsigned path
                        // (they can't anchor a cache breakpoint).
                        if matches!(b, ContentBlock::Text { text } if text.trim().is_empty()) {
                            None
                        } else {
                            Some(crate::content_util::content_block_to_json(b))
                        }
                    }));
                } else {
                    blocks.extend(
                        portable.filter_map(crate::content_util::content_block_to_api_json),
                    );
                }

                // If every block was dropped (e.g. a message whose only content
                // was an empty text block), fall back to the string-content
                // path so we never emit an empty content array, which the API
                // also rejects.
                if blocks.is_empty() {
                    super::build_content(&m.content, &m.images, max_image_size, cache_dir)
                } else {
                    json!(blocks)
                }
            };

            // Drop a message that rendered to nothing — an empty string or an
            // empty content array. This happens for a degenerate persisted
            // turn that carries no usable content (e.g. an assistant turn that
            // ended a tool loop without emitting any final text). Anthropic
            // rejects such a turn with "messages: text content blocks must be
            // non-empty", failing the *entire* request, so any conversation
            // whose window contains one can no longer generate. Mirrors the
            // empty-turn skip in `append_response_messages_to_request`.
            // `content` is only ever a string (build_content) or an array of
            // blocks here; the other JSON shapes never occur but are spelled
            // out because wildcard enum arms are denied workspace-wide.
            let is_empty = match &content {
                Value::String(s) => s.trim().is_empty(),
                Value::Array(a) => a.is_empty(),
                Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => false,
            };
            if is_empty {
                return None;
            }

            Some(json!({ "role": role, "content": content }))
        })
        .collect();

    let system = if prompt_result.system.is_empty() {
        None
    } else if prompt_result.system.len() == 1 {
        prompt_result
            .system
            .first()
            .map(|block| json!(block.content))
    } else {
        Some(json!(prompt_result
            .system
            .iter()
            .map(|b| { json!({"type": "text", "text": b.content, "_label": b.label}) })
            .collect::<Vec<_>>()))
    };

    (llm_messages, system)
}

#[cfg(test)]
mod build_llm_messages_tests {
    use super::*;
    use crate::engine::prompt::{AssembledPrompt, PromptMessage};

    fn pm(role: Role, content_blocks: Vec<ContentBlock>) -> PromptMessage {
        PromptMessage {
            role,
            content: String::new(),
            images: vec![],
            content_blocks,
            provider_key: None,
        }
    }

    fn build(messages: Vec<PromptMessage>) -> Vec<Value> {
        let prompt = AssembledPrompt {
            system: vec![],
            messages,
        };
        let (llm_messages, _) =
            build_llm_messages(&prompt, false, 1024, Path::new("/tmp"), "anthropic");
        llm_messages
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
        assert_eq!(msgs[0]["content"], json!("fallback"));
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
}
