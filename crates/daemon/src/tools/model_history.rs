//! Model provenance history tool.
//!
//! Answers "which models generated my words, and when" from the usage
//! ledger — every LLM call the daemon has made for this character, grouped
//! by model/provider/call type with first/last timestamps and counts. This
//! is the coarse timeline complement to `search_chat_logs`' per-message
//! `model` field: the ledger covers periods whose transcripts predate
//! per-message model stamping.
//!
//! The query runs in the sidecar, which owns the ledger. What stays here is
//! the tool's own vocabulary: argument parsing, the time-bound validation that
//! produces a user-facing `InvalidArgs`, and the voice attribution below.

use chrono::Utc;
use serde_json::{json, Value};

use super::history::parse_time_bound;
use super::{ToolCategory, ToolContext, ToolDef, ToolError};

pub fn tool_defs() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "model_history",
        description: crate::include_prompt!("../../prompts/tools/history/model_history.md"),
        parameters: json!({
            "type": "object",
            "properties": {
                "start_time": {
                    "type": "string",
                    "description": "Optional inclusive lower timestamp bound in RFC3339 format, for example 2026-05-13T09:00:00+10:00."
                },
                "end_time": {
                    "type": "string",
                    "description": "Optional inclusive upper timestamp bound in RFC3339 format, for example 2026-05-13T17:00:00+10:00."
                }
            },
            "required": []
        }),
        category: ToolCategory::Other,
    }]
}

/// Voice attribution for a ledger call type. `tool_loop` is genuinely mixed —
/// chat tool-loop continuations and delegated sub-agent continuations share
/// the tag — so rows keep their raw `call_type` and this is advisory.
fn kind_for(call_type: &str) -> &'static str {
    match call_type {
        "message" | "tool_loop" => "interactive",
        "heartbeat" | "heartbeat_tool_loop" => "autonomous",
        _ => "background",
    }
}

/// Ledger timestamps are stored as RFC3339 in UTC; bounds arrive in any
/// offset. Rebase to UTC so the ledger's lexicographic `ts >= ?` comparison
/// is chronologically correct.
fn utc_bound(input: &Value, field: &str) -> Result<Option<String>, ToolError> {
    Ok(parse_time_bound(input, field)?.map(|ts| ts.with_timezone(&Utc).to_rfc3339()))
}

pub async fn handle_model_history(
    input: &Value,
    ctx: &dyn ToolContext,
) -> Result<Value, ToolError> {
    // NotImplemented is reserved for unrouted tool names (see
    // test_dispatch_all_registered_names_route); a context without a ledger
    // client is an availability problem, not a missing dispatch arm.
    let Some(ledger) = ctx.ledger_client() else {
        return Err(ToolError::Io(
            "the usage ledger is not available in this context".into(),
        ));
    };
    let character = ctx.character_name();
    if character.is_empty() {
        return Err(ToolError::InvalidArgs(
            "model history is not configured".into(),
        ));
    }

    let since = utc_bound(input, "start_time")?;
    let until = utc_bound(input, "end_time")?;
    if let (Some(start), Some(end)) = (&since, &until) {
        if start > end {
            return Err(ToolError::InvalidArgs(
                "start_time must be before or equal to end_time".into(),
            ));
        }
    }

    let rows = ledger
        .model_history(character, since.as_deref(), until.as_deref())
        .await
        .map_err(|e| ToolError::Io(e.to_string()))?;

    let models: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "model": row.model,
                "provider": row.provider,
                "call_type": row.call_type,
                "kind": kind_for(&row.call_type),
                "first_seen": row.first_ts,
                "last_seen": row.last_ts,
                "calls": row.call_count,
            })
        })
        .collect();

    Ok(json!({
        "character": character,
        "time_range": {
            "start_time": since,
            "end_time": until,
            "inclusive": true,
        },
        "models": models,
        "count": models.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestToolContext;

    // What `model_history` *returns* is pinned where the query runs, in
    // `llm-sidecar/tests/ledger_usage.test.ts` — character scoping, the UTC
    // rebase of the bounds, the grouping. What is left here is the handling
    // this side still owns: the arguments, and saying so when the ledger is
    // out of reach.

    #[tokio::test]
    async fn model_history_rejects_reversed_range() {
        let ctx = TestToolContext::new().with_ledger().with_character("poppy");
        let result = handle_model_history(
            &json!({
                "start_time": "2026-06-01T00:00:00Z",
                "end_time": "2026-05-01T00:00:00Z"
            }),
            &ctx,
        )
        .await;
        assert!(matches!(result, Err(ToolError::InvalidArgs(_))));
    }

    #[tokio::test]
    async fn model_history_unavailable_without_ledger() {
        let ctx = TestToolContext::new().with_character("poppy");
        let result = handle_model_history(&json!({}), &ctx).await;
        // Io, not NotImplemented — the latter is reserved for unrouted names.
        assert!(matches!(result, Err(ToolError::Io(_))));
    }

    #[tokio::test]
    async fn model_history_requires_a_character() {
        let ctx = TestToolContext::new().with_ledger();
        let result = handle_model_history(&json!({}), &ctx).await;
        assert!(matches!(result, Err(ToolError::InvalidArgs(_))));
    }
}
