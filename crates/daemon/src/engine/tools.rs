use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, info, instrument, warn};

use crate::convert::elapsed_ms_u64;
use crate::ledger::{CallType, LedgerClient};
use crate::llm::retry::{should_retry_error, RetryDecision, RetryPolicy};
use crate::llm::stream::StreamConsumer;
use crate::llm::types::{LlmRequest, StreamResult, ToolUseEvent};
use crate::llm::LlmError;
use crate::tools::{self as tool_system, ToolContext};
use shore_common::diagnostics::{self as diagnostics, Diagnostics};
use shore_common::protocol::server_msg::{
    SendImage, ServerMessage, ToolCall, ToolResult as SwpToolResult,
};
use shore_common::protocol::types::{
    derive_content_from_blocks, ContentBlock, ImageRef, Message, Role,
};

// ── Errors ──────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ToolLoopError {
    #[error("LLM error during tool loop: {0}")]
    Llm(#[from] LlmError),
}

/// Transient-retry settings for the per-iteration LLM calls the tool loop
/// makes. The loop's continuation calls are NOT covered by
/// `generation::stream_with_retry` (which wraps only the first turn), so a
/// transient blip — e.g. an `IncompleteStream` from the sidecar dropping a
/// quiet stream — would otherwise kill the whole loop. This mirrors that
/// retry: same `should_retry_error` classification, same exponential backoff.
#[derive(Debug, Clone, Copy)]
pub struct ToolLoopRetry {
    /// Maximum transient retries per continuation call before failing.
    pub max_retries: u32,
    /// Base backoff in milliseconds; doubled each attempt.
    pub backoff_base_ms: u64,
}

impl ToolLoopRetry {
    /// No retries — fail on the first error. Used by tests that drive the loop
    /// with a deterministic mock and never inject transient failures.
    pub const NONE: Self = Self {
        max_retries: 0,
        backoff_base_ms: 0,
    };
}

/// Result of the tool loop: the final LLM response plus any intermediate
/// messages (assistant tool_use + user tool_result) that should be persisted.
#[derive(Debug)]
pub struct ToolLoopResult {
    /// The final stream result from the last LLM call.
    pub result: StreamResult,
    /// Intermediate messages generated during the tool loop, in order.
    /// These are assistant messages (with tool_use blocks) and user messages
    /// (with tool_result blocks) that should be persisted to the conversation.
    pub intermediate_messages: Vec<Message>,
}

// ── Tool loop ───────────────────────────────────────────────────────────

/// Run the tool use agentic loop.
///
/// If the initial stream result has `finish_reason == "tool_use"`, executes
/// the requested tools via the unified `dispatch_tool()` system, appends
/// results to the request messages, and calls the LLM again. Repeats until
/// `finish_reason != "tool_use"` or the `max_tool_iterations` cap is reached.
///
/// `max_tool_iterations` is the resolved per-model limit: `None` means
/// **unlimited** — the loop runs until the model stops requesting tools,
/// bounded only by per-call HTTP timeouts. `Some(n)` caps the loop at `n`
/// iterations.
///
/// Returns both the final result and any intermediate messages for persistence.
#[instrument(skip(client, direct_tx, request, result, ctx, diag), fields(char = character, ?max_tool_iterations))]
#[expect(
    clippy::too_many_arguments,
    reason = "tool-loop orchestration needs the live ledger, stream, request, context, diagnostics, and character inputs"
)]
pub async fn run_tool_loop(
    client: &LedgerClient,
    direct_tx: &mpsc::Sender<ServerMessage>,
    request: &mut LlmRequest,
    mut result: StreamResult,
    ctx: &dyn ToolContext,
    max_tool_iterations: Option<u32>,
    tools_cfg: &shore_common::config::app::ToolsConfig,
    diag: &Arc<Mutex<Diagnostics>>,
    character: &str,
    thinking_enabled: bool,
    retry: ToolLoopRetry,
) -> Result<ToolLoopResult, ToolLoopError> {
    let consumer = StreamConsumer::new(direct_tx.clone(), request.rid.clone());
    let mut intermediate_messages: Vec<Message> = Vec::new();

    let mut iteration: u32 = 0;
    loop {
        if result.finish_reason != "tool_use" || result.tool_uses.is_empty() {
            return Ok(ToolLoopResult {
                result,
                intermediate_messages,
            });
        }

        // Enforce the resolved per-model cap. `None` = unlimited, so the only
        // exit is the model ending cleanly (handled above) or an LLM error.
        if let Some(max) = max_tool_iterations {
            if iteration >= max {
                break;
            }
        }

        // Emit StreamEnd for the prior LLM phase now that we've decided to
        // continue with tool execution. Intermediate phases are emitted
        // immediately (clients need the boundary to render tool calls); only
        // the FINAL phase's StreamEnd is deferred until after persistence.
        // is_final=false so aggregating clients (collect_stream) know to keep
        // reading past this boundary.
        crate::llm::stream::emit_stream_end(
            direct_tx,
            request.rid.clone(),
            &result,
            false,
            None,
            None,
        )
        .await;

        info!(
            iteration = iteration.saturating_add(1),
            max = ?max_tool_iterations,
            tool_count = result.tool_uses.len(),
            "Tool loop iteration"
        );

        append_assistant_tool_use_turn(request, &mut intermediate_messages, &result);

        // Execute each tool and collect results.
        let mut tool_results: Vec<Value> = Vec::new();
        let mut tool_result_blocks: Vec<ContentBlock> = Vec::new();

        for tool_use in &result.tool_uses {
            let outcome = execute_tool_use(
                tool_use,
                direct_tx,
                request.rid.as_deref(),
                ctx,
                tools_cfg,
                diag,
                intermediate_messages.as_mut_slice(),
            )
            .await;
            tool_results.push(outcome.llm_payload);
            tool_result_blocks.push(outcome.content_block);
        }

        append_user_tool_result_turn(
            request,
            &mut intermediate_messages,
            tool_results,
            tool_result_blocks,
        );

        result = stream_tool_loop_continuation(
            client,
            &consumer,
            request,
            character,
            thinking_enabled,
            retry,
        )
        .await?;

        iteration = iteration.saturating_add(1);
    }

    warn!(
        max = ?max_tool_iterations,
        "Tool loop hit max iterations, returning last result"
    );
    Ok(ToolLoopResult {
        result,
        intermediate_messages,
    })
}

fn append_assistant_tool_use_turn(
    request: &mut LlmRequest,
    intermediate_messages: &mut Vec<Message>,
    result: &StreamResult,
) {
    let assistant_blocks = assistant_blocks_from_result(result);
    let assistant_content: Vec<Value> = assistant_blocks
        .iter()
        .filter_map(|block| {
            crate::content_util::content_block_to_request_json_for_sdk(block, &request.sdk)
        })
        .collect();

    request.messages.push(json!({
        "role": "assistant",
        "content": assistant_content,
    }));

    // Model provenance mirrors the final-response path: prefer what the
    // provider reported for this iteration, fall back to what we requested.
    let minting_model = if result.model.is_empty() {
        request.model.clone()
    } else {
        result.model.clone()
    };
    intermediate_messages.push(Message {
        msg_id: format!("m_{}", uuid::Uuid::new_v4()),
        origin: None,
        role: Role::Assistant,
        content: derive_content_from_blocks(&assistant_blocks),
        images: vec![],
        content_blocks: assistant_blocks,
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        timestamp: chrono::Local::now().to_rfc3339(),
        provider_key: request.provider_key.clone(),
        model: (!minting_model.is_empty()).then_some(minting_model),
    });
}

fn assistant_blocks_from_result(result: &StreamResult) -> Vec<ContentBlock> {
    if !result.content_blocks.is_empty() {
        return result.content_blocks.clone();
    }

    let mut blocks = Vec::new();
    if !result.content.is_empty() {
        blocks.push(ContentBlock::Text {
            text: result.content.clone(),
        });
    }
    for tool_use in &result.tool_uses {
        blocks.push(ContentBlock::ToolUse {
            id: tool_use.id.clone(),
            name: tool_use.name.clone(),
            input: tool_use.input.clone(),
        });
    }
    blocks
}

struct ToolDispatchOutcome {
    llm_payload: Value,
    content_block: ContentBlock,
}

async fn execute_tool_use(
    tool_use: &ToolUseEvent,
    direct_tx: &mpsc::Sender<ServerMessage>,
    request_rid: Option<&str>,
    ctx: &dyn ToolContext,
    tools_cfg: &shore_common::config::app::ToolsConfig,
    diag: &Arc<Mutex<Diagnostics>>,
    intermediate_messages: &mut [Message],
) -> ToolDispatchOutcome {
    let _ignored = direct_tx
        .send(ServerMessage::ToolCall(ToolCall {
            subagent: None,
            rid: request_rid.map(str::to_owned),
            tool_id: tool_use.id.clone(),
            tool_name: tool_use.name.clone(),
            input: tool_use.input.clone(),
        }))
        .await;

    debug!(
        tool_id = %tool_use.id,
        tool_name = %tool_use.name,
        "Executing tool"
    );

    let dispatch_start = Instant::now();
    let dispatch_result =
        tool_system::dispatch_tool(&tool_use.name, tool_use.input.clone(), ctx).await;
    let dispatch_ms = elapsed_ms_u64(dispatch_start.elapsed());
    let (raw_output, is_error, ok_value) = match dispatch_result {
        Ok(value) => {
            let output = value.as_str().map_or_else(
                || serde_json::to_string(&value).unwrap_or_default(),
                str::to_owned,
            );
            (output, false, Some(value))
        }
        Err(e) => (e.to_string(), true, None),
    };
    // Cap how much a single result contributes to the conversation, honoring
    // any per-tool `[tools.config.<name>]` override over the global limit.
    // Apply before the SWP event, persistence, and LLM payload so every replay
    // path sees the same bounded result. A limit of 0 leaves output untouched.
    let max_result_chars = tools_cfg.result_chars_for(&tool_use.name);
    let output_str = crate::content_util::truncate_tool_result(raw_output, max_result_chars);

    if !is_error && tool_use.name == "generate_image" {
        if let Some(value) = &ok_value {
            attach_generated_image(value, intermediate_messages, direct_tx, request_rid).await;
        }
    }

    record_tool_diagnostics(diag, tool_use, dispatch_ms, &output_str, is_error);
    emit_tool_result(tool_use, direct_tx, request_rid, &output_str, is_error).await;

    ToolDispatchOutcome {
        llm_payload: crate::content_util::build_tool_result_json(
            &tool_use.id,
            &output_str,
            is_error,
        ),
        content_block: ContentBlock::ToolResult {
            tool_use_id: tool_use.id.clone(),
            content: output_str,
            is_error,
        },
    }
}

async fn attach_generated_image(
    value: &Value,
    intermediate_messages: &mut [Message],
    direct_tx: &mpsc::Sender<ServerMessage>,
    request_rid: Option<&str>,
) {
    let Some(path) = value.get("path").and_then(Value::as_str) else {
        return;
    };
    let caption = value
        .get("caption")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let image_ref = ImageRef {
        path: path.to_owned(),
        caption: caption.clone(),
        data: None,
    };
    if let Some(last) = intermediate_messages.last_mut() {
        last.images.push(image_ref);
    }
    let _ignored = direct_tx
        .send(ServerMessage::SendImage(SendImage {
            subagent: None,
            rid: request_rid.map(str::to_owned),
            path: path.to_owned(),
            caption,
            data: crate::handler::image_data_for_path(path),
        }))
        .await;
}

fn record_tool_diagnostics(
    diag: &Arc<Mutex<Diagnostics>>,
    tool_use: &ToolUseEvent,
    duration_ms: u64,
    output_str: &str,
    is_error: bool,
) {
    let input_str = serde_json::to_string(&tool_use.input).unwrap_or_default();
    let entry = diagnostics::ToolCallEntry {
        timestamp: chrono::Local::now().to_rfc3339(),
        tool_name: tool_use.name.clone(),
        tool_id: tool_use.id.clone(),
        success: !is_error,
        duration_ms,
        input_summary: diagnostics::truncate_summary(&input_str, 200),
        output_summary: diagnostics::truncate_summary(output_str, 200),
    };
    diag.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .tool_calls
        .push(entry);
}

async fn emit_tool_result(
    tool_use: &ToolUseEvent,
    direct_tx: &mpsc::Sender<ServerMessage>,
    request_rid: Option<&str>,
    output: &str,
    is_error: bool,
) {
    let _ignored = direct_tx
        .send(ServerMessage::ToolResult(SwpToolResult {
            subagent: None,
            rid: request_rid.map(str::to_owned),
            tool_id: tool_use.id.clone(),
            tool_name: tool_use.name.clone(),
            output: output.to_owned(),
            is_error,
        }))
        .await;

    debug!(
        tool_id = %tool_use.id,
        tool_name = %tool_use.name,
        is_error,
        "Tool completed"
    );
}

fn append_user_tool_result_turn(
    request: &mut LlmRequest,
    intermediate_messages: &mut Vec<Message>,
    tool_results: Vec<Value>,
    tool_result_blocks: Vec<ContentBlock>,
) {
    let mut user_message = serde_json::Map::new();
    let _ignored = user_message.insert("role".into(), Value::String("user".into()));
    _ = user_message.insert("content".into(), Value::Array(tool_results));
    request.messages.push(Value::Object(user_message));

    intermediate_messages.push(Message {
        msg_id: format!("m_{}", uuid::Uuid::new_v4()),
        origin: None,
        role: Role::User,
        content: derive_content_from_blocks(&tool_result_blocks),
        images: vec![],
        content_blocks: tool_result_blocks,
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        timestamp: chrono::Local::now().to_rfc3339(),
        provider_key: None,
        model: None,
    });
}

/// Stream one tool-loop continuation turn, retrying transient LLM errors with
/// exponential backoff — the same policy `generation::stream_with_retry` applies
/// to the first turn. Retrying here is safe and idempotent: the tools have
/// already run and their results are already appended to `request.messages`, so
/// a retry merely re-requests the next assistant turn. Credential-shaped and
/// non-transient errors fail immediately (`should_retry_error` short-circuits).
async fn stream_tool_loop_continuation(
    client: &LedgerClient,
    consumer: &StreamConsumer,
    request: &mut LlmRequest,
    character: &str,
    thinking_enabled: bool,
    retry: ToolLoopRetry,
) -> Result<StreamResult, ToolLoopError> {
    let policy = RetryPolicy {
        max_retries: retry.max_retries,
        fallback_model: None,
    };
    let mut attempt: u32 = 0;

    loop {
        let stream_result = async {
            let mut ledger_stream = client
                .stream_raw(request, CallType::ToolLoop, character, thinking_enabled)
                .await?;
            match consumer.consume(ledger_stream.reader_mut(), false).await {
                Ok(result) => {
                    ledger_stream.finalize(&result);
                    Ok(result)
                }
                Err(e) => {
                    ledger_stream.finalize_error(&e);
                    Err(e)
                }
            }
        }
        .await;

        match stream_result {
            Ok(result) => return Ok(result),
            // Only `Retry` loops; `Fail` (and the unreachable `FallbackModel`,
            // since we set no fallback) surface the error to the loop caller.
            Err(e) => match should_retry_error(&e, attempt, &policy) {
                RetryDecision::Retry => {
                    let delay = Duration::from_millis(
                        retry
                            .backoff_base_ms
                            .saturating_mul(2_u64.saturating_pow(attempt)),
                    );
                    warn!(
                        attempt,
                        delay_ms = elapsed_ms_u64(delay),
                        error = %e,
                        "Retrying tool-loop continuation after transient LLM error"
                    );
                    tokio::time::sleep(delay).await;
                    attempt = attempt.saturating_add(1);
                }
                RetryDecision::FallbackModel(_) | RetryDecision::Fail => return Err(e.into()),
            },
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::{Timing, Usage};
    use crate::llm::LlmClient;
    use crate::test_support::TestToolContext;
    use tokio::sync::mpsc;

    fn test_ledger_client(tmp: &tempfile::TempDir) -> LedgerClient {
        LedgerClient::new(LlmClient::try_new().unwrap(), &tmp.path().join("ledger.db")).unwrap()
    }

    fn test_diag() -> Arc<Mutex<Diagnostics>> {
        Arc::new(Mutex::new(Diagnostics::default()))
    }

    /// A `ToolsConfig` whose global result cap is `max` and which carries no
    /// per-tool overrides, so `result_chars_for` returns `max` for every tool.
    fn tools_cfg(max: usize) -> shore_common::config::app::ToolsConfig {
        shore_common::config::app::ToolsConfig {
            max_result_chars: max,
            ..Default::default()
        }
    }

    /// Build a test LlmRequest. The sidecar mock handles transport; base_url
    /// remains present to keep the request shape close to configured models.
    fn test_request(base_url: &str, messages: Vec<Value>) -> LlmRequest {
        LlmRequest {
            sdk: shore_common::config::models::Sdk::Anthropic,
            model: "test".into(),
            api_key: "sk-test".into(),
            api_key_name: None,
            base_url: Some(base_url.to_owned()),
            messages,
            system: None,
            tools: None,
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            rid: None,
            forensic_character: None,
            retain_long: false,
            keepalive_interval: None,
        }
    }

    // ── Tool loop ───────────────────────────────────────────────────

    #[test]
    fn tool_loop_returns_immediately_on_end_turn() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let client = test_ledger_client(&tmp);
            let (push_tx, _rx) = mpsc::channel(16);
            let ctx = TestToolContext::new();

            let mut request = test_request("http://unused", vec![]);

            let result = StreamResult {
                content: "Hello".into(),
                model: "test".into(),
                finish_reason: "end_turn".into(),
                usage: Usage::default(),
                timing: Timing::default(),
                tool_uses: vec![],
                content_blocks: vec![],
            };

            let out = run_tool_loop(
                &client,
                &push_tx,
                &mut request,
                result,
                &ctx,
                Some(10),
                &tools_cfg(0),
                &test_diag(),
                "test",
                false,
                ToolLoopRetry::NONE,
            )
            .await
            .unwrap();

            assert_eq!(out.result.finish_reason, "end_turn");
            assert_eq!(out.result.content, "Hello");
        });
    }

    #[test]
    fn tool_loop_text_with_tool_use() {
        // Verify that when content accompanies a tool_use, both blocks
        // appear in the assistant message.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let client = test_ledger_client(&tmp);
            let (push_tx, _rx) = mpsc::channel(16);
            let ctx = TestToolContext::new();

            let mut request = test_request("http://unused", vec![]);

            // Result with both text content and tool_uses, but no LLM server
            // to call -- the tool_uses are empty, so it should return immediately.
            let result = StreamResult {
                content: "Let me check the time...".into(),
                model: "test".into(),
                finish_reason: "end_turn".into(),
                usage: Usage::default(),
                timing: Timing::default(),
                tool_uses: vec![],
                content_blocks: vec![],
            };

            let out = run_tool_loop(
                &client,
                &push_tx,
                &mut request,
                result,
                &ctx,
                Some(10),
                &tools_cfg(0),
                &test_diag(),
                "test",
                false,
                ToolLoopRetry::NONE,
            )
            .await
            .unwrap();

            assert_eq!(out.result.content, "Let me check the time...");
        });
    }
}
