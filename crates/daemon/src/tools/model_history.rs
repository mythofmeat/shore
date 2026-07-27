//! Model provenance history tool.
//!
//! Answers "which models generated my words, and when" from the usage
//! ledger — every LLM call the daemon has made for this character, grouped
//! by model/provider/call type with first/last timestamps and counts. This
//! is the coarse timeline complement to `search_chat_logs`' per-message
//! `model` field: the ledger covers periods whose transcripts predate
//! per-message model stamping.

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

pub fn handle_model_history(input: &Value, ctx: &dyn ToolContext) -> Result<Value, ToolError> {
    // NotImplemented is reserved for unrouted tool names (see
    // test_dispatch_all_registered_names_route); a context without a ledger
    // handle is an availability problem, not a missing dispatch arm.
    let Some(ledger) = ctx.ledger() else {
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

    let filter = crate::ledger::query::QueryFilter {
        since: since.clone(),
        until: until.clone(),
        character: Some(character.to_owned()),
        ..crate::ledger::query::QueryFilter::default()
    };
    let rows = crate::ledger::query::model_usage_summary(ledger, &filter)
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
    use crate::ledger::store::CallRow;
    use crate::ledger::store::Ledger;
    use crate::test_support::TestToolContext;

    fn call_row(ts: &str, character: &str, model: &str, call_type: &str) -> CallRow {
        CallRow {
            ts: ts.to_owned(),
            character: character.to_owned(),
            provider: "anthropic".to_owned(),
            api_key_name: None,
            model: model.to_owned(),
            call_type: call_type.to_owned(),
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cache_ttl: None,
            total_ms: 100,
            ttft_ms: 10,
            finish_reason: "end_turn".to_owned(),
            thinking_enabled: false,
            reasoning_effort: None,
            cache_state: None,
            cache_anomaly: None,
            input_cost: None,
            output_cost: None,
            cache_read_cost: None,
            cache_write_cost: None,
            cost_source: None,
            total_cost: None,
        }
    }

    fn ledger_with_calls() -> Ledger {
        let ledger = Ledger::open_in_memory().unwrap();
        for row in [
            call_row(
                "2026-04-05T10:00:00+00:00",
                "poppy",
                "claude-opus-4-6",
                "message",
            ),
            call_row(
                "2026-05-01T10:00:00+00:00",
                "poppy",
                "claude-opus-4-6",
                "message",
            ),
            call_row("2026-06-01T10:00:00+00:00", "poppy", "glm-5.2", "heartbeat"),
            call_row("2026-06-02T10:00:00+00:00", "poppy", "glm-5.2", "dreaming"),
            call_row("2026-06-03T10:00:00+00:00", "other", "gpt-5.5", "message"),
        ] {
            let _ignored = ledger.insert(&row).unwrap();
        }
        ledger
    }

    #[tokio::test]
    async fn model_history_reports_character_scoped_rows_with_kinds() {
        let ctx = TestToolContext::new()
            .with_ledger(ledger_with_calls())
            .with_character("poppy");
        let result = handle_model_history(&json!({}), &ctx).unwrap();

        assert_eq!(result["character"], "poppy");
        let models = result["models"].as_array().unwrap();
        // gpt-5.5 belongs to another character and must not leak in.
        assert_eq!(models.len(), 3);
        assert_eq!(models[0]["model"], "claude-opus-4-6");
        assert_eq!(models[0]["kind"], "interactive");
        assert_eq!(models[0]["calls"], 2);
        assert_eq!(models[0]["first_seen"], "2026-04-05T10:00:00+00:00");
        assert_eq!(models[0]["last_seen"], "2026-05-01T10:00:00+00:00");
        assert_eq!(models[1]["kind"], "autonomous");
        assert_eq!(models[2]["kind"], "background");
    }

    #[tokio::test]
    async fn model_history_time_bounds_rebase_to_utc() {
        let ctx = TestToolContext::new()
            .with_ledger(ledger_with_calls())
            .with_character("poppy");
        // 2026-05-01T20:00+10:00 == 2026-05-01T10:00Z — the +10:00 bound must
        // still include the May call stored in UTC.
        let result = handle_model_history(
            &json!({
                "start_time": "2026-04-20T00:00:00+10:00",
                "end_time": "2026-05-01T20:00:00+10:00"
            }),
            &ctx,
        )
        .unwrap();
        let models = result["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["model"], "claude-opus-4-6");
        assert_eq!(models[0]["calls"], 1);
    }

    #[tokio::test]
    async fn model_history_rejects_reversed_range() {
        let ctx = TestToolContext::new()
            .with_ledger(ledger_with_calls())
            .with_character("poppy");
        let result = handle_model_history(
            &json!({
                "start_time": "2026-06-01T00:00:00Z",
                "end_time": "2026-05-01T00:00:00Z"
            }),
            &ctx,
        );
        assert!(matches!(result, Err(ToolError::InvalidArgs(_))));
    }

    #[tokio::test]
    async fn model_history_unavailable_without_ledger() {
        let ctx = TestToolContext::new().with_character("poppy");
        let result = handle_model_history(&json!({}), &ctx);
        // Io, not NotImplemented — the latter is reserved for unrouted names.
        assert!(matches!(result, Err(ToolError::Io(_))));
    }
}
