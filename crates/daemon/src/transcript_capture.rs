//! Curated heartbeat/dreaming transcript capture.
//!
//! The raw `calls` rows in the observability store already hold every LLM call's
//! request/response. Tool *outputs*, though, live in the *next* call's request
//! in provider-wire shape — fragile to reconstruct on read. So the background
//! tool loops, which hold each tool result in normalized form at dispatch time,
//! record a curated transcript entry per call: reasoning, visible text, and each
//! tool call paired with its full output. These land in the `transcripts` table
//! of the same store and back `shore log --heartbeat` / `--dreaming`.

use std::sync::Arc;

use crate::call_store::{CallStore, TranscriptRecord, Usage as StoreUsage};
use crate::llm::types::GenerateResponse;
use chrono::Utc;
use serde_json::json;
use shore_common::protocol::types::ContentBlock;
use tracing::warn;

/// One tool call captured during a background tool loop, with its full output.
#[derive(Debug, Clone)]
pub struct CapturedTool {
    pub name: String,
    pub input: serde_json::Value,
    pub output: String,
    pub is_error: bool,
}

/// Build the curated entry JSON (reasoning, visible text, tool calls) from a
/// response and the tools dispatched from it.
fn build_entry_json(resp: &GenerateResponse, tools: &[CapturedTool]) -> String {
    let mut reasoning: Vec<&str> = Vec::new();
    let mut text = String::new();
    for block in &resp.content_blocks {
        match block {
            ContentBlock::Thinking { thinking, .. } => {
                if !thinking.trim().is_empty() {
                    reasoning.push(thinking);
                }
            }
            ContentBlock::RedactedThinking { .. } => reasoning.push("[redacted thinking]"),
            ContentBlock::Text { text: t } => {
                if !t.is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(t);
                }
            }
            ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. } => {}
        }
    }
    let tool_calls: Vec<serde_json::Value> = tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "input": tool.input,
                "output": tool.output,
                "is_error": tool.is_error,
            })
        })
        .collect();
    json!({ "reasoning": reasoning, "text": text, "tool_calls": tool_calls }).to_string()
}

/// Record one curated transcript entry to the store. Best-effort: a write
/// failure is logged and never disturbs the tool loop.
#[expect(
    clippy::too_many_arguments,
    reason = "flat metadata for one transcript row; grouping into a struct adds no clarity"
)]
pub fn record(
    store: &Arc<CallStore>,
    source: &str,
    character: &str,
    call_type: &str,
    iteration: u32,
    provider: Option<&str>,
    resp: &GenerateResponse,
    tools: &[CapturedTool],
) {
    let entry_json = build_entry_json(resp, tools);
    let usage = StoreUsage {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
        cache_read_tokens: resp.usage.cache_read_tokens,
    };
    let record = TranscriptRecord {
        ts: Utc::now(),
        source,
        character: Some(character),
        call_type: Some(call_type),
        iteration,
        model: (!resp.model.is_empty()).then_some(resp.model.as_str()),
        provider,
        finish_reason: Some(&resp.finish_reason),
        usage,
        entry_json: &entry_json,
    };
    if let Err(e) = store.record_transcript(&record) {
        warn!(error = %e, source, "Failed to record transcript entry");
    }
}
