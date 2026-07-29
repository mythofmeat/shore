//! Persistence and notification for completed generations.
//!
//! Writes assistant messages to the conversation engine, records diagnostics,
//! tracks token usage, and sends push notifications.

use std::sync::{Arc, PoisonError};
use std::time::Instant;

use shore_common::config::models::Sdk;
use shore_common::protocol::server_msg::{MessageOrigin, NewMessage, ServerMessage, UsageWarning};
use shore_common::protocol::types::{derive_content_from_blocks, ContentBlock, Message, Role};
use tokio::sync::{broadcast, Mutex};
use tracing::{info, instrument, warn};

use crate::convert::elapsed_ms_u32;
use crate::engine::messages::{MessageStore, PendingAlt};
use crate::llm::types::{WireBlock, WireMessage, WireRole};
use crate::notifications::NotificationEvent;

use super::GenContext;

#[derive(Debug, Clone, PartialEq)]
struct CompletedResponseMessage {
    role: Role,
    content_blocks: Vec<ContentBlock>,
}

/// Phase 12: Persist messages, record diagnostics, and send notifications.
#[instrument(skip(ctx, engine_arc, result, request, tool_intermediate_messages), fields(char = char_name, model = %resolved.qualified_name))]
#[expect(
    clippy::too_many_arguments,
    reason = "generation persistence boundary mirrors handler state; parameter object tracked in #109"
)]
pub(super) async fn persist_and_notify(
    ctx: &GenContext,
    engine_arc: &Arc<Mutex<crate::engine::ConversationEngine>>,
    char_name: &str,
    resolved: &shore_common::config::models::ResolvedModel,
    result: &crate::llm::types::StreamResult,
    request: &crate::llm::types::LlmRequest,
    tool_intermediate_messages: Vec<Message>,
    wall_clock_start: Instant,
    regen_alt: Option<PendingAlt>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    record_completion_diagnostics(ctx, result, request, resolved);

    let notify_content = {
        let mut engine = engine_arc.lock().await;

        let completed_messages = completed_response_messages(result, &request.sdk);

        // Include the assistant response in last_request so the
        // heartbeat system sees a complete conversation ending on an
        // assistant turn — not the user turn that triggered this call.
        update_last_request_with_response(ctx, request, &completed_messages, char_name);
        let notify_content = notify_content_from_response_messages(&completed_messages);
        let mut generated_messages = tool_intermediate_messages;
        // The provider that actually minted this turn (matching the diagnostics
        // entry above) so opaque thinking data carries its provenance to disk.
        let minting_provider = request
            .provider_key
            .clone()
            .unwrap_or_else(|| resolved.provider_key.clone());
        // Prefer the model the provider reported for this call (matching the
        // ledger/diagnostics entries); fall back to the model we requested.
        let minting_model = if result.model.is_empty() {
            request.model.clone()
        } else {
            result.model.clone()
        };
        let response_messages: Vec<Message> = completed_messages
            .into_iter()
            .map(|m| message_from_response(m, &minting_provider, &minting_model))
            .collect();
        let response_event_ids: Vec<String> = response_messages
            .iter()
            .filter(|msg| msg.role == Role::Assistant)
            .map(|msg| msg.msg_id.clone())
            .collect();
        generated_messages.extend(response_messages);
        apply_generated_messages_to_engine(
            &mut engine,
            generated_messages,
            regen_alt,
            &response_event_ids,
            &ctx.event_tx,
            char_name,
        )?;
        ctx.autonomy
            .notify_assistant_message(char_name, engine.turn_count());
        notify_content
    }; // engine lock released

    let wall_clock_ms = elapsed_ms_u32(wall_clock_start.elapsed());
    ctx.notifier.notify_message_complete(
        &format!("Shore — {char_name}"),
        &notify_content,
        wall_clock_ms,
    );
    emit_usage_budget_warnings(ctx, request.rid.as_deref()).await;

    Ok(())
}

/// Update the last-request cache with the completed response so the
/// heartbeat system sees a complete conversation.
fn update_last_request_with_response(
    ctx: &GenContext,
    request: &crate::llm::types::LlmRequest,
    completed_messages: &[CompletedResponseMessage],
    char_name: &str,
) {
    ctx.autonomy.notify_last_request(
        char_name,
        last_request_with_response(request, completed_messages),
    );
}

/// The request-as-sent plus this turn's response messages — the body every
/// `last_request` reuse path (keepalive ping, heartbeat, dreaming, compaction)
/// clones and extends.
///
/// Nothing is filtered here. This used to apply the prior-thinking replay
/// policy to the appended messages only, with a careful index clamp so it could
/// never rewrite bytes that had already gone out and were covered by a live
/// cache entry — rewriting those is what made every keepalive ping miss. The
/// policy is now applied by the adapter at send time, so the same history
/// always produces the same wire bytes and there is nothing left to clamp.
fn last_request_with_response(
    request: &crate::llm::types::LlmRequest,
    completed_messages: &[CompletedResponseMessage],
) -> crate::llm::types::LlmRequest {
    let mut full_request = request.clone();
    append_response_messages_to_request(&mut full_request, completed_messages);
    full_request
}

/// Apply generated messages to the engine, handling regeneration
/// alternatives versus standard append.
fn apply_generated_messages_to_engine(
    engine: &mut crate::engine::ConversationEngine,
    mut generated_messages: Vec<Message>,
    regen_alt: Option<PendingAlt>,
    response_event_ids: &[String],
    event_tx: &broadcast::Sender<ServerMessage>,
    char_name: &str,
) -> Result<(), crate::engine::EngineError> {
    if let Some(pending) = regen_alt {
        let _ignored =
            MessageStore::attach_generated_alt(&mut generated_messages, pending.alternatives);
        let event_messages: Vec<Message> = generated_messages
            .iter()
            .filter(|msg| {
                response_event_ids
                    .iter()
                    .any(|msg_id| msg_id == &msg.msg_id)
            })
            .cloned()
            .collect();
        _ = engine.replace_after_last_user_turn(generated_messages)?;
        let revision = engine.current_revision();
        for msg in &event_messages {
            emit_new_message_event(
                event_tx,
                char_name,
                MessageOrigin::AssistantReply,
                revision,
                msg,
            );
        }
    } else {
        for msg in generated_messages {
            let event_msg = response_event_ids
                .iter()
                .any(|msg_id| msg_id == &msg.msg_id)
                .then(|| msg.clone());
            engine.append_message(msg)?;
            if let Some(emitted) = event_msg {
                emit_new_message_event(
                    event_tx,
                    char_name,
                    MessageOrigin::AssistantReply,
                    engine.current_revision(),
                    &emitted,
                );
            }
        }
    }
    Ok(())
}

fn record_completion_diagnostics(
    ctx: &GenContext,
    result: &crate::llm::types::StreamResult,
    request: &crate::llm::types::LlmRequest,
    resolved: &shore_common::config::models::ResolvedModel,
) {
    let mut tokens = ctx
        .session_tokens
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    tokens.input = tokens.input.saturating_add(result.usage.input_tokens);
    tokens.output = tokens.output.saturating_add(result.usage.output_tokens);
    tokens.cache_read = tokens
        .cache_read
        .saturating_add(result.usage.cache_read_tokens);
    tokens.cache_write = tokens
        .cache_write
        .saturating_add(result.usage.cache_creation_tokens);
    drop(tokens);

    let entry = shore_common::diagnostics::ApiCallEntry {
        timestamp: chrono::Local::now().to_rfc3339(),
        model: result.model.clone(),
        provider: request
            .provider_key
            .clone()
            .unwrap_or_else(|| resolved.provider_key.clone()),
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read_tokens: result.usage.cache_read_tokens,
        cache_write_tokens: result.usage.cache_creation_tokens,
        ttft_ms: result.timing.time_to_first_token_ms,
        total_ms: result.timing.total_ms,
        finish_reason: result.finish_reason.clone(),
        total_cost_usd: result.usage.total_cost_usd,
        error: None,
    };
    ctx.diagnostics
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .api_calls
        .push(entry);

    info!(
        input_tokens = result.usage.input_tokens,
        output_tokens = result.usage.output_tokens,
        cache_read = result.usage.cache_read_tokens,
        cache_creation = result.usage.cache_creation_tokens,
        model = %result.model,
        "Response complete"
    );
}

async fn emit_usage_budget_warnings(ctx: &GenContext, rid: Option<&str>) {
    let warnings = match ctx.llm_client.newly_crossed_usage_budget_warnings().await {
        Ok(warnings) => warnings,
        Err(e) => {
            warn!(error = %e, "Usage budget warning check failed");
            return;
        }
    };

    for warning in warnings {
        let message = warning.message.clone();
        let frame = UsageWarning {
            rid: rid.map(str::to_owned),
            budget: warning.budget,
            message: message.clone(),
            current_cost: warning.current_cost,
            cost_limit: warning.cost_limit,
            percent_used: warning.percent_used,
            crossed_warn_at: warning.crossed_warn_at,
            period: warning.period,
            period_start: warning.period_start,
            reset_at: warning.reset_at,
            reset_at_display: warning.reset_at_display,
            // Omitted for budget-cap warnings so the frame stays byte-identical
            // to what pre-pace clients already parse.
            scope: match warning.scope.as_str() {
                "budget" => None,
                other => Some(other.to_owned()),
            },
        };
        if let Err(e) = ctx.direct_tx.try_send(ServerMessage::UsageWarning(frame)) {
            warn!(error = %e, "UsageWarning drop: direct channel unavailable");
        }
        ctx.notifier.notify(
            NotificationEvent::UsageWarning,
            "Shore usage warning",
            &message,
        );
    }
}

fn emit_new_message_event(
    event_tx: &broadcast::Sender<ServerMessage>,
    character: &str,
    origin: MessageOrigin,
    revision: u64,
    msg: &Message,
) {
    let mut wire_msg = msg.clone();
    wire_msg.origin = Some(origin);
    crate::handler::embed_image_data(&mut wire_msg.images);
    let _ignored = event_tx.send(ServerMessage::NewMessage(NewMessage {
        revision,
        character: Some(character.to_owned()),
        message: wire_msg,
    }));
}

fn message_from_response(
    response_msg: CompletedResponseMessage,
    provider_key: &str,
    model: &str,
) -> Message {
    let content = derive_content_from_blocks(&response_msg.content_blocks);
    Message {
        msg_id: format!("m_{}", uuid::Uuid::new_v4()),
        origin: None,
        role: response_msg.role,
        content,
        images: vec![],
        content_blocks: response_msg.content_blocks,
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        timestamp: chrono::Local::now().to_rfc3339(),
        provider_key: Some(provider_key.to_owned()),
        model: (!model.is_empty()).then(|| model.to_owned()),
    }
}

fn completed_response_messages(
    result: &crate::llm::types::StreamResult,
    _sdk: &Sdk,
) -> Vec<CompletedResponseMessage> {
    let content_blocks = content_blocks_for_result(result);
    // Don't persist a degenerate empty assistant turn. A tool loop that ends
    // without the model emitting any final text yields a result with no
    // content blocks; persisting it as an empty assistant message poisons the
    // conversation, since `build_llm_messages` would later ship a turn with
    // empty content and Anthropic rejects the whole request ("text content
    // blocks must be non-empty").
    if content_blocks.is_empty() {
        return Vec::new();
    }
    vec![CompletedResponseMessage {
        role: Role::Assistant,
        content_blocks,
    }]
}

fn content_blocks_for_result(result: &crate::llm::types::StreamResult) -> Vec<ContentBlock> {
    if result.content_blocks.is_empty() && !result.content.is_empty() {
        vec![ContentBlock::Text {
            text: result.content.clone(),
        }]
    } else {
        result.content_blocks.clone()
    }
}

fn append_response_messages_to_request(
    request: &mut crate::llm::types::LlmRequest,
    response_messages: &[CompletedResponseMessage],
) {
    let provider_key = request.provider_key.clone();
    let model = Some(request.model.clone());
    for message in response_messages {
        // Skip turns that carry nothing (e.g. an empty-text-only response): an
        // empty content array is rejected by the API and would poison the
        // cached last-request the heartbeat replays.
        if message.content_blocks.is_empty() {
            continue;
        }
        request.messages.push(
            WireMessage::new(
                request_role(&message.role),
                message
                    .content_blocks
                    .iter()
                    .map(WireBlock::from_content_block)
                    .collect(),
            )
            .minted_by(provider_key.clone(), model.clone()),
        );
    }
}

fn request_role(role: &Role) -> WireRole {
    match role {
        Role::User => WireRole::User,
        Role::Assistant => WireRole::Assistant,
        Role::System => WireRole::System,
    }
}

fn notify_content_from_response_messages(messages: &[CompletedResponseMessage]) -> String {
    let text = messages
        .iter()
        .filter(|message| message.role == Role::Assistant)
        .map(|message| derive_content_from_blocks(&message.content_blocks))
        .filter(|content| !content.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if text.is_empty() {
        messages
            .iter()
            .map(|message| derive_content_from_blocks(&message.content_blocks))
            .filter(|content| !content.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result_with(
        content: &str,
        content_blocks: Vec<ContentBlock>,
    ) -> crate::llm::types::StreamResult {
        crate::llm::types::StreamResult {
            content: content.to_owned(),
            model: "test".to_owned(),
            finish_reason: "end_turn".to_owned(),
            usage: crate::llm::types::Usage::default(),
            timing: crate::llm::types::Timing::default(),
            tool_uses: vec![],
            content_blocks,
        }
    }

    #[test]
    fn empty_result_produces_no_persisted_message() {
        // A tool loop that ends without final text yields no content blocks and
        // no content string; persisting an empty assistant turn would later
        // poison the request, so nothing should be persisted.
        let result = result_with("", vec![]);
        assert!(completed_response_messages(&result, &Sdk::Anthropic).is_empty());
    }

    #[test]
    fn text_result_produces_one_message() {
        let result = result_with("hello", vec![]);
        let msgs = completed_response_messages(&result, &Sdk::Anthropic);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, Role::Assistant);
    }

    #[test]
    fn message_from_response_stamps_provenance() {
        let result = result_with("hello", vec![]);
        let mut msgs = completed_response_messages(&result, &Sdk::Anthropic);
        let msg = message_from_response(msgs.remove(0), "anthropic", "claude-opus-4-6");
        assert_eq!(msg.provider_key.as_deref(), Some("anthropic"));
        assert_eq!(msg.model.as_deref(), Some("claude-opus-4-6"));
    }

    fn request_with_sent_messages(messages: Vec<WireMessage>) -> crate::llm::types::LlmRequest {
        crate::llm::types::LlmRequest {
            sdk: Sdk::Anthropic,
            model: "claude-opus-5".to_owned(),
            api_key: "k".to_owned(),
            api_key_name: None,
            base_url: None,
            messages,
            system: Vec::new(),
            tools: None,
            max_tokens: 1024,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: shore_common::config::app::ThinkingReplay::None,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
            keepalive_interval: None,
        }
    }

    #[test]
    fn last_request_appends_without_touching_the_sent_prefix() {
        // The keepalive ping clones `last_request` and must stay byte-identical
        // to the request the provider cached. This function is the only thing
        // that writes `last_request`, so its whole contract is: append, never
        // rewrite. Note `replay_prior_thinking: None` on the request — the
        // strip is the adapter's job now, and it must not happen here even when
        // the policy says to strip, because `a1` already went out on the wire
        // carrying its thinking and rewriting it kills the cache entry anchored
        // past it.
        let sent = vec![
            WireMessage::text(WireRole::User, "q1"),
            WireMessage::new(
                WireRole::Assistant,
                vec![
                    WireBlock::Thinking {
                        thinking: "t1".to_owned(),
                        carrier: crate::llm::types::ReasoningCarrier {
                            signature: Some("s1".to_owned()),
                            ..Default::default()
                        },
                    },
                    WireBlock::text("a1"),
                ],
            ),
            WireMessage::text(WireRole::User, "q2"),
        ];
        let request = request_with_sent_messages(sent.clone());
        let response = vec![CompletedResponseMessage {
            role: Role::Assistant,
            content_blocks: vec![
                ContentBlock::Thinking {
                    thinking: "t2".into(),
                    signature: Some("s2".into()),
                },
                ContentBlock::Text { text: "a2".into() },
            ],
        }];

        let full = last_request_with_response(&request, &response);

        assert_eq!(full.messages.len(), 4);
        assert_eq!(
            full.messages[..3],
            sent[..],
            "every already-sent message must survive byte-identical"
        );
        assert_eq!(
            full.messages[3].content.len(),
            2,
            "the appended turn keeps its thinking; the adapter decides what ships"
        );
    }

    #[test]
    fn message_from_response_empty_model_stays_none() {
        // A provider that reports no model id must not stamp an empty string —
        // downstream consumers treat `Some("")` as a real (garbage) model.
        let result = result_with("hello", vec![]);
        let mut msgs = completed_response_messages(&result, &Sdk::Anthropic);
        let msg = message_from_response(msgs.remove(0), "anthropic", "");
        assert_eq!(msg.provider_key.as_deref(), Some("anthropic"));
        assert_eq!(msg.model, None);
    }
}
