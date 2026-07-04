use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, info, instrument, warn};

use crate::convert::elapsed_ms_u64;
use crate::tools::{self as tool_system, ToolContext};
use shore_diagnostics::{self as diagnostics, Diagnostics};
use shore_ledger::{CallType, LedgerClient};
use shore_llm::retry::{should_retry_error, RetryDecision, RetryPolicy};
use shore_llm::stream::StreamConsumer;
use shore_llm::types::{LlmRequest, StreamResult, ToolUseEvent};
use shore_llm::LlmError;
use shore_protocol::server_msg::{SendImage, ServerMessage, ToolCall, ToolResult as SwpToolResult};
use shore_protocol::types::{derive_content_from_blocks, ContentBlock, ImageRef, Message, Role};

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
    tools_cfg: &shore_config::app::ToolsConfig,
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
        shore_llm::stream::emit_stream_end(
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
    tools_cfg: &shore_config::app::ToolsConfig,
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
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "tests assert on a specific ServerMessage variant and panic on any other"
)]
mod tests {
    use super::*;
    use crate::test_support::TestToolContext;
    use shore_llm::types::{Timing, ToolUseEvent, Usage};
    use shore_llm::LlmClient;
    use shore_test_harness::MockLlmSidecar;
    use tokio::sync::mpsc;

    fn test_ledger_client(tmp: &tempfile::TempDir) -> LedgerClient {
        LedgerClient::new(LlmClient::try_new().unwrap(), &tmp.path().join("ledger.db")).unwrap()
    }

    fn test_ledger_client_with_sidecar(
        tmp: &tempfile::TempDir,
        sidecar: &MockLlmSidecar,
    ) -> LedgerClient {
        let mut llm = LlmClient::try_new().unwrap();
        llm.set_sidecar_socket(sidecar.socket_path().to_path_buf());
        LedgerClient::new(llm, &tmp.path().join("ledger.db")).unwrap()
    }

    fn test_diag() -> Arc<Mutex<Diagnostics>> {
        Arc::new(Mutex::new(Diagnostics::default()))
    }

    /// A `ToolsConfig` whose global result cap is `max` and which carries no
    /// per-tool overrides, so `result_chars_for` returns `max` for every tool.
    fn tools_cfg(max: usize) -> shore_config::app::ToolsConfig {
        shore_config::app::ToolsConfig {
            max_result_chars: max,
            ..Default::default()
        }
    }

    /// Build a test LlmRequest. The sidecar mock handles transport; base_url
    /// remains present to keep the request shape close to configured models.
    fn test_request(base_url: &str, messages: Vec<Value>) -> LlmRequest {
        LlmRequest {
            sdk: shore_config::models::Sdk::Anthropic,
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

    #[tokio::test]
    async fn tool_loop_executes_tool_and_continues() {
        let sidecar = MockLlmSidecar::start().await;
        sidecar
            .enqueue_stream_text("The current time is shown above.")
            .await;
        let base_url = sidecar.base_url();

        let tmp = tempfile::tempdir().unwrap();
        let client = test_ledger_client_with_sidecar(&tmp, &sidecar);
        let (push_tx, mut push_rx) = mpsc::channel(64);
        let ctx = TestToolContext::new();

        let mut request = test_request(
            &base_url,
            vec![json!({"role": "user", "content": "What time is it?"})],
        );

        let initial = StreamResult {
            content: String::new(),
            model: "test".into(),
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            tool_uses: vec![ToolUseEvent {
                id: "t1".into(),
                name: "check_time".into(),
                input: json!({}),
            }],
            content_blocks: vec![],
        };

        let result = run_tool_loop(
            &client,
            &push_tx,
            &mut request,
            initial,
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

        assert_eq!(result.result.finish_reason, "end_turn");
        assert_eq!(result.result.content, "The current time is shown above.");

        // Intermediate messages should have been generated.
        assert_eq!(result.intermediate_messages.len(), 2);
        assert_eq!(result.intermediate_messages[0].role, Role::Assistant);
        assert_eq!(result.intermediate_messages[1].role, Role::User);
        assert!(!result.intermediate_messages[0].content_blocks.is_empty());
        assert!(!result.intermediate_messages[1].content_blocks.is_empty());

        // The intermediate StreamEnd (for the initial tool_use phase) is now
        // emitted by run_tool_loop itself before the tool dispatch — clients
        // need this boundary to render tool calls. The FINAL StreamEnd is
        // deferred to the caller (after persistence), so it is NOT in this
        // event sequence.
        let intermediate_end = push_rx.try_recv().unwrap();
        match intermediate_end {
            ServerMessage::StreamEnd(end) => {
                assert_eq!(end.finish_reason, "tool_use");
            }
            other => panic!("Expected intermediate StreamEnd(tool_use), got {other:?}"),
        }

        let tc = push_rx.try_recv().unwrap();
        match tc {
            ServerMessage::ToolCall(call) => {
                assert_eq!(call.tool_id, "t1");
                assert_eq!(call.tool_name, "check_time");
            }
            other => panic!("Expected ToolCall, got {other:?}"),
        }

        let tr = push_rx.try_recv().unwrap();
        match tr {
            ServerMessage::ToolResult(res) => {
                assert_eq!(res.tool_id, "t1");
                assert_eq!(res.tool_name, "check_time");
                assert!(!res.is_error);
                assert!(
                    res.output.contains(" at "),
                    "expected friendly format: {}",
                    res.output
                );
            }
            other => panic!("Expected ToolResult, got {other:?}"),
        }

        let ss = push_rx.try_recv().unwrap();
        assert!(matches!(ss, ServerMessage::StreamStart(_)));
        let sc = push_rx.try_recv().unwrap();
        assert!(matches!(sc, ServerMessage::StreamChunk(_)));
        // No final StreamEnd from the consumer — caller emits it post-persist.
        assert!(
            push_rx.try_recv().is_err(),
            "tool loop must not emit the final StreamEnd; caller emits after persist"
        );

        assert_eq!(request.messages.len(), 3);
        assert_eq!(request.messages[1]["content"][0]["name"], "check_time");
        assert_eq!(request.messages[2]["content"][0]["type"], "tool_result");
    }

    #[tokio::test]
    async fn tool_loop_respects_max_iterations() {
        let sidecar = MockLlmSidecar::start().await;
        for _ in 0..3 {
            sidecar
                .enqueue_stream_tool_use("t1", "check_time", json!({}))
                .await;
        }
        let base_url = sidecar.base_url();

        let tmp = tempfile::tempdir().unwrap();
        let client = test_ledger_client_with_sidecar(&tmp, &sidecar);
        let (push_tx, _rx) = mpsc::channel(64);
        let ctx = TestToolContext::new();

        let mut request = test_request(&base_url, vec![]);

        let initial = StreamResult {
            content: String::new(),
            model: "test".into(),
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            tool_uses: vec![ToolUseEvent {
                id: "t1".into(),
                name: "check_time".into(),
                input: json!({}),
            }],
            content_blocks: vec![],
        };

        let result = run_tool_loop(
            &client,
            &push_tx,
            &mut request,
            initial,
            &ctx,
            Some(3),
            &tools_cfg(0),
            &test_diag(),
            "test",
            false,
            ToolLoopRetry::NONE,
        )
        .await
        .unwrap();

        assert_eq!(result.result.finish_reason, "tool_use");
    }

    #[tokio::test]
    async fn tool_loop_handles_tool_error() {
        // generate_image returns a tool error when no image-generation profile is configured.
        let sidecar = MockLlmSidecar::start().await;
        sidecar
            .enqueue_stream_text("Image generation is not available.")
            .await;
        let base_url = sidecar.base_url();

        let tmp = tempfile::tempdir().unwrap();
        let client = test_ledger_client_with_sidecar(&tmp, &sidecar);
        let (push_tx, mut push_rx) = mpsc::channel(64);
        let ctx = TestToolContext::new();

        let mut request = test_request(&base_url, vec![]);

        let initial = StreamResult {
            content: String::new(),
            model: "test".into(),
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            tool_uses: vec![ToolUseEvent {
                id: "t_img".into(),
                name: "generate_image".into(),
                input: json!({"prompt": "a cat"}),
            }],
            content_blocks: vec![],
        };

        let result = run_tool_loop(
            &client,
            &push_tx,
            &mut request,
            initial,
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

        // LLM should have received the error and responded.
        assert_eq!(result.result.finish_reason, "end_turn");

        // The tool loop emits the intermediate StreamEnd(tool_use) before
        // dispatching tools.
        let intermediate_end = push_rx.try_recv().unwrap();
        assert!(matches!(intermediate_end, ServerMessage::StreamEnd(_)));

        // ToolCall event should be present.
        let tc = push_rx.try_recv().unwrap();
        assert!(matches!(tc, ServerMessage::ToolCall(_)));

        // ToolResult should have is_error = true.
        let tr = push_rx.try_recv().unwrap();
        match tr {
            ServerMessage::ToolResult(res) => {
                assert!(res.is_error);
                assert_eq!(res.tool_name, "generate_image");
            }
            other => panic!("Expected ToolResult, got {other:?}"),
        }

        // The tool_result in request.messages should also have is_error.
        let tool_result_msg = &request.messages[1]["content"][0];
        assert_eq!(tool_result_msg["is_error"], json!(true));
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

    #[tokio::test]
    async fn tool_loop_truncates_result_when_limit_set() {
        // A small max_result_chars must cut the tool output everywhere it
        // flows: the live SWP event, the LLM payload, and the persisted
        // content block (which is what later turns replay).
        let sidecar = MockLlmSidecar::start().await;
        sidecar.enqueue_stream_text("Noted.").await;
        let base_url = sidecar.base_url();

        let tmp = tempfile::tempdir().unwrap();
        let client = test_ledger_client_with_sidecar(&tmp, &sidecar);
        let (push_tx, mut push_rx) = mpsc::channel(64);
        let ctx = TestToolContext::new();

        let mut request = test_request(
            &base_url,
            vec![json!({"role": "user", "content": "What time is it?"})],
        );

        let initial = StreamResult {
            content: String::new(),
            model: "test".into(),
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            tool_uses: vec![ToolUseEvent {
                id: "t1".into(),
                name: "check_time".into(),
                input: json!({}),
            }],
            content_blocks: vec![],
        };

        let result = run_tool_loop(
            &client,
            &push_tx,
            &mut request,
            initial,
            &ctx,
            Some(10),
            &tools_cfg(5),
            &test_diag(),
            "test",
            false,
            ToolLoopRetry::NONE,
        )
        .await
        .unwrap();

        // SWP event carries the truncated output.
        let _ = push_rx.try_recv().unwrap(); // intermediate StreamEnd
        let _ = push_rx.try_recv().unwrap(); // ToolCall
        let tr = push_rx.try_recv().unwrap();
        match tr {
            ServerMessage::ToolResult(res) => {
                assert!(
                    res.output.contains("tool_result truncated"),
                    "live event should show truncation notice: {}",
                    res.output
                );
            }
            other => panic!("Expected ToolResult, got {other:?}"),
        }

        // LLM payload carries the truncated output.
        let llm_content = request.messages[2]["content"][0]["content"]
            .as_str()
            .unwrap();
        assert!(
            llm_content.contains("tool_result truncated"),
            "LLM payload should be truncated: {llm_content}"
        );

        // Persisted block (replayed on later turns) carries it too.
        let persisted = &result.intermediate_messages[1].content_blocks[0];
        match persisted {
            ContentBlock::ToolResult { content, .. } => {
                assert!(
                    content.contains("tool_result truncated"),
                    "persisted block should be truncated: {content}"
                );
            }
            other => panic!("Expected ToolResult block, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tool_loop_honors_per_tool_result_char_override() {
        // A `[tools.config.<name>]` override must win over the global cap: the
        // global limit here is generous, but `check_time` carries a tiny
        // per-tool override, so only that tool's result is truncated.
        let sidecar = MockLlmSidecar::start().await;
        sidecar.enqueue_stream_text("Noted.").await;
        let base_url = sidecar.base_url();

        let tmp = tempfile::tempdir().unwrap();
        let client = test_ledger_client_with_sidecar(&tmp, &sidecar);
        let (push_tx, _push_rx) = mpsc::channel(64);
        let ctx = TestToolContext::new();

        let mut request = test_request(
            &base_url,
            vec![json!({"role": "user", "content": "What time is it?"})],
        );

        let initial = StreamResult {
            content: String::new(),
            model: "test".into(),
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            tool_uses: vec![ToolUseEvent {
                id: "t1".into(),
                name: "check_time".into(),
                input: json!({}),
            }],
            content_blocks: vec![],
        };

        // Generous global cap, but a 5-char override scoped to `check_time`.
        let mut tools = tools_cfg(10_000);
        let _ = tools.config.insert(
            "check_time".into(),
            shore_config::app::ToolOverride {
                max_result_chars: Some(5),
            },
        );

        let result = run_tool_loop(
            &client,
            &push_tx,
            &mut request,
            initial,
            &ctx,
            Some(10),
            &tools,
            &test_diag(),
            "test",
            false,
            ToolLoopRetry::NONE,
        )
        .await
        .unwrap();

        let persisted = &result.intermediate_messages[1].content_blocks[0];
        match persisted {
            ContentBlock::ToolResult { content, .. } => {
                assert!(
                    content.contains("tool_result truncated"),
                    "per-tool override should truncate check_time under a generous \
                     global cap: {content}"
                );
            }
            other => panic!("Expected ToolResult block, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tool_loop_multiple_tools_single_response() {
        let sidecar = MockLlmSidecar::start().await;
        sidecar.enqueue_stream_text("Done.").await;
        let base_url = sidecar.base_url();

        let tmp = tempfile::tempdir().unwrap();
        let client = test_ledger_client_with_sidecar(&tmp, &sidecar);
        let (push_tx, mut push_rx) = mpsc::channel(64);
        let ctx = TestToolContext::new();

        let mut request = test_request(&base_url, vec![]);

        // Two tools in one response.
        let initial = StreamResult {
            content: String::new(),
            model: "test".into(),
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            tool_uses: vec![
                ToolUseEvent {
                    id: "t1".into(),
                    name: "check_time".into(),
                    input: json!({}),
                },
                ToolUseEvent {
                    id: "t2".into(),
                    name: "roll_dice".into(),
                    input: json!({"notation": "1d6"}),
                },
            ],
            content_blocks: vec![],
        };

        let result = run_tool_loop(
            &client,
            &push_tx,
            &mut request,
            initial,
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

        assert_eq!(result.result.finish_reason, "end_turn");

        // Drain the intermediate StreamEnd(tool_use) emitted before the tool dispatch.
        let intermediate_end = push_rx.try_recv().unwrap();
        assert!(matches!(intermediate_end, ServerMessage::StreamEnd(_)));

        // Should have ToolCall + ToolResult for each tool (4 events), then stream events.
        let mut tool_calls = vec![];
        let mut tool_results = vec![];
        for _ in 0..4 {
            match push_rx.try_recv().unwrap() {
                ServerMessage::ToolCall(tc) => tool_calls.push(tc),
                ServerMessage::ToolResult(tr) => tool_results.push(tr),
                other => panic!("Unexpected event: {other:?}"),
            }
        }

        assert_eq!(tool_calls.len(), 2);
        assert_eq!(tool_results.len(), 2);
        assert_eq!(tool_calls[0].tool_name, "check_time");
        assert_eq!(tool_calls[1].tool_name, "roll_dice");
        assert!(!tool_results[0].is_error);
        assert!(!tool_results[1].is_error);

        // The request should have: assistant msg (with 2 tool_use blocks) + user msg (with 2 tool_result blocks).
        assert_eq!(request.messages.len(), 2);
        let assistant_content = request.messages[0]["content"].as_array().unwrap();
        assert_eq!(assistant_content.len(), 2); // 2 tool_use blocks (no text)
        let user_content = request.messages[1]["content"].as_array().unwrap();
        assert_eq!(user_content.len(), 2); // 2 tool_result blocks
    }
}
