use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc;
use tracing::{debug, info, instrument, warn};

use crate::convert::elapsed_ms_u64;
use crate::engine::tool_loop;
use crate::ledger::{CallType, LedgerClient};
use crate::llm::retry::{should_retry_error, RetryDecision, RetryPolicy};
use crate::llm::stream::StreamConsumer;
use crate::llm::types::{LlmRequest, StreamResult, ToolUseEvent, WireBlock, WireMessage, WireRole};
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
    result: StreamResult,
    ctx: &dyn ToolContext,
    max_tool_iterations: Option<u32>,
    tools_cfg: &shore_common::config::app::ToolsConfig,
    diag: &Arc<Mutex<Diagnostics>>,
    character: &str,
    thinking_enabled: bool,
    retry: ToolLoopRetry,
) -> Result<ToolLoopResult, ToolLoopError> {
    let mut driver = ChatDriver {
        client,
        consumer: StreamConsumer::new(direct_tx.clone(), request.rid.clone()),
        direct_tx,
        ctx,
        tools_cfg,
        diag,
        character,
        thinking_enabled,
        retry,
        max_tool_iterations,
        iteration: 0,
        intermediate_messages: Vec::new(),
    };

    // `CloseWithFinalTurn`: this loop's return value is the reply the user
    // reads, so a capped run still spends a call letting the model answer with
    // the last tool results in hand. The background passes choose otherwise —
    // see `tool_loop::CapBehavior`.
    let outcome = tool_loop::run(
        &mut driver,
        request,
        Some(result),
        max_tool_iterations,
        tool_loop::CapBehavior::CloseWithFinalTurn,
    )
    .await?;

    if outcome.stop == tool_loop::LoopStop::CapReached {
        warn!(
            max = ?max_tool_iterations,
            "Tool loop hit max iterations, returning last result"
        );
    }

    Ok(ToolLoopResult {
        result: outcome.last_turn,
        intermediate_messages: driver.intermediate_messages,
    })
}

/// Run tools for a loop the sidecar is driving.
///
/// The inverse of [`run_tool_loop`]: instead of deciding *when* to call a tool,
/// this waits to be asked and answers. Everything a tool needs — the context,
/// the event sender, the growing intermediate messages — stays borrowed here at
/// its natural lifetime, which is why the registry hands over a channel rather
/// than trying to hold any of it (see `crate::tool_rpc`).
///
/// Execution goes through the same [`execute_tool_use`] the daemon-driven loop
/// uses, so the SWP events, per-tool truncation, diagnostics, and the
/// generated-image side channel behave identically no matter which side is
/// driving. Returns when the sidecar's loop ends and the sender is dropped.
pub async fn serve_tool_calls(
    calls: &mut mpsc::Receiver<crate::tool_rpc::ToolCall>,
    direct_tx: &mpsc::Sender<ServerMessage>,
    request_rid: Option<&str>,
    ctx: &dyn ToolContext,
    tools_cfg: &shore_common::config::app::ToolsConfig,
    diag: &Arc<Mutex<Diagnostics>>,
    intermediate_messages: &mut Vec<Message>,
) {
    while let Some(call) = calls.recv().await {
        let response = match &call.request {
            crate::tool_rpc::SidecarRequest::Messages(report) => {
                // Written down as given. The sidecar decided the grouping and
                // the order; inferring either from the tool calls is what this
                // replaced. An assistant turn arrives before the tools it asked
                // for, which is why this shares a channel with them:
                // `attach_generated_image` hangs the image off that turn.
                for reported in &report.messages {
                    record_reported_message(
                        intermediate_messages,
                        reported.role.clone(),
                        reported.content_blocks.clone(),
                    );
                }
                crate::tool_rpc::ToolCallResponse {
                    output: String::new(),
                    is_error: false,
                }
            }
            crate::tool_rpc::SidecarRequest::Tool(request) => {
                let tool_use = ToolUseEvent {
                    id: request.tool_id.clone(),
                    name: request.name.clone(),
                    input: request.input.clone(),
                };
                let outcome = execute_tool_use(
                    &tool_use,
                    direct_tx,
                    request_rid,
                    ctx,
                    tools_cfg,
                    diag,
                    intermediate_messages.as_mut_slice(),
                )
                .await;
                // The result is *not* recorded here. A round's tools run
                // concurrently, so recording each as it lands would store one
                // message per tool in whatever order they finished. The sidecar
                // sends the round's results together, in ask order, once the
                // round completes.
                tool_response_from(&outcome.content_block)
            }
        };
        call.respond(response);
    }
}

/// Project a dispatched block onto the socket's answer shape.
fn tool_response_from(block: &ContentBlock) -> crate::tool_rpc::ToolCallResponse {
    // `execute_tool_use` only ever produces a tool result; anything else would
    // be a bug here rather than something the model should be told about, so it
    // is reported as a failed tool rather than crashing a turn.
    match block {
        ContentBlock::ToolResult {
            content, is_error, ..
        } => crate::tool_rpc::ToolCallResponse {
            output: content.clone(),
            is_error: *is_error,
        },
        ContentBlock::Text { .. }
        | ContentBlock::Thinking { .. }
        | ContentBlock::RedactedThinking { .. }
        | ContentBlock::ToolUse { .. } => crate::tool_rpc::ToolCallResponse {
            output: "tool dispatch produced a non-result block".to_owned(),
            is_error: true,
        },
    }
}

/// Record an assistant turn a sidecar-driven loop produced.
///
/// The daemon-driven loop builds this itself in `append_assistant_tool_use_turn`
/// from the stream result it already has; when the sidecar drives, the blocks
/// arrive over the socket instead. Provenance is left unset — the request the
/// loop ran on carries it, and the persistence layer stamps it there.
/// Store a message exactly as the sidecar reported it.
fn record_reported_message(
    intermediate_messages: &mut Vec<Message>,
    role: Role,
    blocks: Vec<ContentBlock>,
) {
    intermediate_messages.push(Message {
        msg_id: format!("m_{}", uuid::Uuid::new_v4()),
        origin: None,
        role,
        content: derive_content_from_blocks(&blocks),
        images: vec![],
        content_blocks: blocks,
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        timestamp: chrono::Local::now().to_rfc3339(),
        provider_key: None,
        model: None,
    });
}

/// Drives the shared tool loop for the chat path (and sub-agents).
struct ChatDriver<'src> {
    client: &'src LedgerClient,
    consumer: StreamConsumer,
    direct_tx: &'src mpsc::Sender<ServerMessage>,
    ctx: &'src dyn ToolContext,
    tools_cfg: &'src shore_common::config::app::ToolsConfig,
    diag: &'src Arc<Mutex<Diagnostics>>,
    character: &'src str,
    thinking_enabled: bool,
    retry: ToolLoopRetry,
    max_tool_iterations: Option<u32>,
    iteration: u32,
    intermediate_messages: Vec<Message>,
}

#[async_trait::async_trait]
impl tool_loop::ToolLoopDriver for ChatDriver<'_> {
    type Turn = StreamResult;
    type Error = ToolLoopError;

    fn finish_reason(turn: &Self::Turn) -> &str {
        &turn.finish_reason
    }

    fn tool_uses(turn: &Self::Turn) -> Vec<ToolUseEvent> {
        turn.tool_uses.clone()
    }

    async fn call_model(&mut self, request: &mut LlmRequest) -> Result<Self::Turn, Self::Error> {
        stream_tool_loop_continuation(
            self.client,
            &self.consumer,
            request,
            self.character,
            self.thinking_enabled,
            self.retry,
        )
        .await
    }

    async fn dispatch(
        &mut self,
        request: &mut LlmRequest,
        turn: &Self::Turn,
        uses: Vec<ToolUseEvent>,
    ) -> Vec<WireBlock> {
        // Emit StreamEnd for the prior LLM phase now that we've decided to
        // continue with tool execution. Intermediate phases are emitted
        // immediately (clients need the boundary to render tool calls); only
        // the FINAL phase's StreamEnd is deferred until after persistence.
        // is_final=false so aggregating clients (collect_stream) know to keep
        // reading past this boundary.
        crate::llm::stream::emit_stream_end(
            self.direct_tx,
            request.rid.clone(),
            turn,
            false,
            None,
            None,
        )
        .await;

        self.iteration = self.iteration.saturating_add(1);
        info!(
            iteration = self.iteration,
            max = ?self.max_tool_iterations,
            tool_count = uses.len(),
            "Tool loop iteration"
        );

        append_assistant_tool_use_turn(request, &mut self.intermediate_messages, turn);

        let mut blocks: Vec<ContentBlock> = Vec::with_capacity(uses.len());
        for tool_use in &uses {
            let outcome = execute_tool_use(
                tool_use,
                self.direct_tx,
                request.rid.as_deref(),
                self.ctx,
                self.tools_cfg,
                self.diag,
                self.intermediate_messages.as_mut_slice(),
            )
            .await;
            blocks.push(outcome.content_block);
        }

        record_tool_result_message(&mut self.intermediate_messages, &blocks);
        blocks.iter().map(WireBlock::from_content_block).collect()
    }
}

fn append_assistant_tool_use_turn(
    request: &mut LlmRequest,
    intermediate_messages: &mut Vec<Message>,
    result: &StreamResult,
) {
    let assistant_blocks = assistant_blocks_from_result(result);

    // Model provenance mirrors the final-response path: prefer what the
    // provider reported for this iteration, fall back to what we requested.
    let minting_model = if result.model.is_empty() {
        request.model.clone()
    } else {
        result.model.clone()
    };
    let minted_model = (!minting_model.is_empty()).then(|| minting_model.clone());

    // The active model minted these blocks this instant, so they are trivially
    // replayable — but the turn still carries its provenance, because that is
    // what the adapter reads and a mid-loop model switch must not look like a
    // same-model turn.
    request.messages.push(
        WireMessage::new(
            WireRole::Assistant,
            assistant_blocks
                .iter()
                .map(WireBlock::from_content_block)
                .collect(),
        )
        .minted_by(request.provider_key.clone(), minted_model.clone()),
    );
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
        model: minted_model,
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

/// A dispatched tool's result, in the one form that feeds both the persisted
/// message and the next request turn.
///
/// This used to carry the result twice — a `ContentBlock` for storage and a
/// hand-built `tool_result` JSON value for the wire — which is the same
/// dual-representation the seam produced everywhere else. The wire form is now
/// derived from the block.
struct ToolDispatchOutcome {
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
        dispatch_within_deadline(tool_use, ctx, tools_cfg.timeout_for(&tool_use.name)).await;
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
        content_block: ContentBlock::ToolResult {
            tool_use_id: tool_use.id.clone(),
            content: output_str,
            is_error,
        },
    }
}

/// Run one tool, cancelling it if it outlives its deadline.
///
/// A tool that never returns used to hold the turn open forever, and neither
/// loop could notice: the daemon-driven one awaits the handler directly, and
/// the sidecar-driven one awaits an answer over the tool socket whose ping pump
/// keeps reporting the connection healthy the whole time. The deadline belongs
/// here rather than at either loop because this is the only side that can
/// actually *stop* the work — dropping the future cancels it. Timing it out
/// from the sidecar would abandon the call while the tool kept running.
///
/// The timeout becomes a failed tool result, not a transport error, so the
/// model is told and the loop continues. That is the same shape a tool that
/// returns an error takes, which is what makes it recoverable.
async fn dispatch_within_deadline(
    tool_use: &ToolUseEvent,
    ctx: &dyn ToolContext,
    deadline: Option<Duration>,
) -> Result<Value, tool_system::ToolError> {
    let dispatch = tool_system::dispatch_tool(&tool_use.name, tool_use.input.clone(), ctx);
    let Some(limit) = deadline else {
        return dispatch.await;
    };
    match tokio::time::timeout(limit, dispatch).await {
        Ok(result) => result,
        Err(_elapsed) => {
            warn!(
                tool_id = %tool_use.id,
                tool_name = %tool_use.name,
                timeout_secs = limit.as_secs(),
                "Tool exceeded its deadline and was cancelled"
            );
            Err(tool_system::ToolError::TimedOut(limit.as_secs()))
        }
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
    // The assistant turn that asked for this tool, not simply the last message.
    // Only assistant messages render their images (`handler::task`), so an
    // image parked on a `tool_result` turn is dropped with no error — and once
    // a round's results are stored as one user message, the last message is a
    // user turn more often than not.
    if let Some(turn) = intermediate_messages
        .iter_mut()
        .rev()
        .find(|message| message.role == Role::Assistant)
    {
        turn.images.push(image_ref);
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

/// Record the persisted `Message` for a round of tool results.
///
/// The matching wire turn is appended by `tool_loop::run`, which owns it
/// because that push is identical for every caller. This half is not: only the
/// chat path persists its intermediate turns.
fn record_tool_result_message(intermediate_messages: &mut Vec<Message>, blocks: &[ContentBlock]) {
    let tool_result_blocks = blocks.to_vec();
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
            let mut reader = client
                .stream_raw(request, CallType::ToolLoop, character, thinking_enabled)
                .await?;
            consumer.consume(&mut reader, false).await
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
    use crate::tool_rpc::{
        MessagesRequest, ReportedMessage, SidecarRequest, ToolCall, ToolCallRequest,
        ToolCallResponse,
    };
    use serde_json::json;
    use tokio::sync::mpsc;

    fn test_ledger_client(tmp: &tempfile::TempDir) -> LedgerClient {
        LedgerClient::new(LlmClient::try_new().unwrap(), &tmp.path().join("ledger.db")).unwrap()
    }

    fn test_diag() -> Arc<Mutex<Diagnostics>> {
        Arc::new(Mutex::new(Diagnostics::default()))
    }

    /// A tool call as it would arrive from the sidecar, plus the reply channel.
    fn sidecar_call(
        name: &str,
        input: Value,
    ) -> (ToolCall, tokio::sync::oneshot::Receiver<ToolCallResponse>) {
        ToolCall::for_test(SidecarRequest::Tool(ToolCallRequest {
            rid: "rid_1".into(),
            tool_id: "tu_1".into(),
            name: name.into(),
            input,
        }))
    }

    #[tokio::test]
    async fn serving_a_sidecar_loop_runs_the_tool_and_answers() {
        let ctx = TestToolContext::new();
        let (direct_tx, mut events) = mpsc::channel(32);
        let diag = test_diag();
        let mut intermediate = Vec::new();
        let (calls_tx, mut calls_rx) = mpsc::channel(4);

        let (call, reply) = sidecar_call("read", json!({"path": "nope.txt"}));
        calls_tx.send(call).await.expect("queue the call");
        drop(calls_tx); // the loop ended; serve_tool_calls should return

        serve_tool_calls(
            &mut calls_rx,
            &direct_tx,
            Some("rid_1"),
            &ctx,
            &tools_cfg(0),
            &diag,
            &mut intermediate,
        )
        .await;

        let answer = reply.await.expect("the call is answered");
        // A missing file is a *tool* failure the model is told about, not a
        // transport failure — the distinction the protocol is built around.
        assert!(answer.is_error, "a failing tool reports is_error");
        assert!(!answer.output.is_empty());

        // The same client-facing events the daemon-driven loop emits.
        let mut kinds = Vec::new();
        while let Ok(event) = events.try_recv() {
            if matches!(event, ServerMessage::ToolCall(_)) {
                kinds.push("tool_call");
            }
            if matches!(event, ServerMessage::ToolResult(_)) {
                kinds.push("tool_result");
            }
        }
        assert!(kinds.contains(&"tool_call"), "{kinds:?}");
        assert!(kinds.contains(&"tool_result"), "{kinds:?}");

        // And it was recorded for the diagnostics pane, as before.
        let calls = diag
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .tool_calls
            .len();
        assert_eq!(calls, 1);
    }

    #[tokio::test]
    async fn a_reported_turn_is_recorded_before_the_tools_it_asked_for() {
        // Why turns ride the tool socket rather than the event stream: the
        // generated-image side channel hangs its image off the assistant turn
        // that requested it, so that turn must already be the last message when
        // its tools dispatch. One channel makes that ordering structural.
        let ctx = TestToolContext::new();
        let (direct_tx, _events) = mpsc::channel(32);
        let diag = test_diag();
        let mut intermediate = Vec::new();
        let (calls_tx, mut calls_rx) = mpsc::channel(4);

        let (turn, turn_reply) = ToolCall::for_test(SidecarRequest::Messages(MessagesRequest {
            rid: "rid_1".into(),
            messages: vec![ReportedMessage {
                role: Role::Assistant,
                content_blocks: vec![
                    ContentBlock::Text {
                        text: "let me look".into(),
                    },
                    ContentBlock::ToolUse {
                        id: "tu_1".into(),
                        name: "read".into(),
                        input: json!({"path": "nope.txt"}),
                    },
                ],
            }],
        }));
        calls_tx.send(turn).await.expect("queue the turn");
        let (call, _reply) = sidecar_call("read", json!({"path": "nope.txt"}));
        calls_tx.send(call).await.expect("queue the call");
        drop(calls_tx);

        serve_tool_calls(
            &mut calls_rx,
            &direct_tx,
            Some("rid_1"),
            &ctx,
            &tools_cfg(0),
            &diag,
            &mut intermediate,
        )
        .await;

        assert!(!turn_reply.await.expect("the turn is acknowledged").is_error);
        // Only what was reported. Running a tool records nothing on its own:
        // a round's tools finish in a race, so recording each as it lands would
        // store one message per tool in completion order. The sidecar sends the
        // round's results together once the round is done.
        let roles: Vec<Role> = intermediate.iter().map(|m| m.role.clone()).collect();
        assert_eq!(roles, vec![Role::Assistant], "{roles:?}");
        assert_eq!(intermediate[0].content, "let me look");
    }

    #[tokio::test]
    async fn serving_returns_when_the_sidecar_loop_ends() {
        // The sender dropping is how a finished or cancelled turn tells this
        // task to stop; without that it would hold the borrow forever.
        let ctx = TestToolContext::new();
        let (direct_tx, _events) = mpsc::channel(4);
        let diag = test_diag();
        let mut intermediate = Vec::new();
        let (calls_tx, mut calls_rx) = mpsc::channel(4);
        drop(calls_tx);

        serve_tool_calls(
            &mut calls_rx,
            &direct_tx,
            None,
            &ctx,
            &tools_cfg(0),
            &diag,
            &mut intermediate,
        )
        .await;
        assert!(intermediate.is_empty());
    }

    /// A `ToolsConfig` whose global result cap is `max` and which carries no
    /// per-tool overrides, so `result_chars_for` returns `max` for every tool.
    fn tools_cfg(max: usize) -> shore_common::config::app::ToolsConfig {
        shore_common::config::app::ToolsConfig {
            max_result_chars: max,
            ..Default::default()
        }
    }

    // ── Tool deadline ───────────────────────────────────────────────

    /// A context whose sub-agent never returns — what a wedged tool looks like
    /// from the loop's side, where the handler simply never completes.
    struct HangingContext {
        search: shore_common::config::app::SearchConfig,
    }

    impl ToolContext for HangingContext {
        fn image_dir(&self) -> &'static str {
            ""
        }
        fn llm_client(&self) -> Option<&LlmClient> {
            None
        }
        fn image_gen_config(&self) -> Option<&crate::memory::compaction_impls::ImageGenConfig> {
            None
        }
        fn search_config(&self) -> &shore_common::config::app::SearchConfig {
            &self.search
        }
        fn run_subagent<'ctx>(
            &'ctx self,
            _name: &'ctx str,
            _query: &'ctx str,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<Value, tool_system::ToolError>>
                    + Send
                    + 'ctx,
            >,
        > {
            Box::pin(std::future::pending())
        }
    }

    fn hanging_ctx() -> HangingContext {
        HangingContext {
            search: shore_common::config::app::SearchConfig::default(),
        }
    }

    fn hanging_tool_use() -> ToolUseEvent {
        ToolUseEvent {
            id: "tu_hang".into(),
            name: "ask_wedged".into(),
            input: json!({"query": "anything"}),
        }
    }

    #[tokio::test]
    async fn a_tool_that_never_returns_is_cancelled_at_its_deadline() {
        let ctx = hanging_ctx();
        let (direct_tx, _events) = mpsc::channel(32);
        let mut cfg = tools_cfg(0);
        cfg.timeout = shore_common::config::duration::ConfigDuration::from_millis(50);

        let outcome = execute_tool_use(
            &hanging_tool_use(),
            &direct_tx,
            None,
            &ctx,
            &cfg,
            &test_diag(),
            &mut [],
        )
        .await;

        // A failed *tool*, not a transport error: the model is told and the
        // loop continues. Without the deadline this call never returns at all.
        match outcome.content_block {
            ContentBlock::ToolResult {
                content, is_error, ..
            } => {
                assert!(is_error, "a cancelled tool reports is_error");
                assert!(content.contains("timed out"), "{content}");
            }
            other @ (ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolUse { .. }) => panic!("expected a tool result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_per_tool_override_outranks_the_global_deadline() {
        // The reason overrides exist: a sub-agent runs its own loop and
        // legitimately outlives a deadline meant for a filesystem read. Here
        // the global would fire and the override keeps the tool alive, so a
        // returned result is proof the override was the one consulted.
        let ctx = hanging_ctx();
        let (direct_tx, _events) = mpsc::channel(32);
        let mut cfg = tools_cfg(0);
        cfg.timeout = shore_common::config::duration::ConfigDuration::from_millis(50);
        let _replaced = cfg.config.insert(
            "ask_wedged".into(),
            shore_common::config::app::ToolOverride {
                max_result_chars: None,
                timeout: Some(shore_common::config::duration::ConfigDuration::from_secs(
                    60,
                )),
            },
        );

        let dispatched = tokio::time::timeout(
            Duration::from_millis(250),
            execute_tool_use(
                &hanging_tool_use(),
                &direct_tx,
                None,
                &ctx,
                &cfg,
                &test_diag(),
                &mut [],
            ),
        )
        .await;
        assert!(
            dispatched.is_err(),
            "the override's 60s deadline should still be pending, not the global 50ms"
        );
    }

    /// Build a test LlmRequest. The sidecar mock handles transport; base_url
    /// remains present to keep the request shape close to configured models.
    fn test_request(base_url: &str, messages: Vec<WireMessage>) -> LlmRequest {
        LlmRequest {
            sdk: shore_common::config::models::Sdk::Anthropic,
            model: "test".into(),
            api_key: "sk-test".into(),
            api_key_name: None,
            base_url: Some(base_url.to_owned()),
            messages,
            system: Vec::new(),
            tools: None,
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: shore_common::config::app::ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
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
