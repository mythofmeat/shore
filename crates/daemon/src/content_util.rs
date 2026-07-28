//! Shared utilities for reading structured data out of content block
//! sequences, and for shaping tool output before it is stored.
//!
//! This module used to also project `ContentBlock` onto provider request JSON —
//! per-SDK forks, thinking-carrier naming, cross-model replay portability, and
//! the prior-thinking strip. Those are provider decisions and now live in the
//! sidecar's adapters, which are the only code that knows which provider a
//! request is going to. What remains is the daemon's own business: reading its
//! blocks, and bounding what it stores.

use serde_json::Value;
use shore_common::protocol::types::ContentBlock;

/// Extract `(id, name, input)` tuples from `ToolUse` blocks in a content
/// block sequence.
pub fn extract_tool_uses(blocks: &[ContentBlock]) -> Vec<(String, String, Value)> {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => {
                Some((id.clone(), name.clone(), input.clone()))
            }
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect()
}

/// Convert a `dispatch_tool` result (`Result<Value, ToolError>`) to an
/// `(output_string, is_error)` pair suitable for tool_result messages.
///
/// On success, extracts the string representation (bare string if the
/// Value is a string, otherwise JSON-serialized). On error, uses the
/// Display representation.
pub fn dispatch_result_to_output(result: Result<Value, crate::tools::ToolError>) -> (String, bool) {
    match result {
        Ok(value) => {
            let s = if let Some(s) = value.as_str() {
                s.to_owned()
            } else {
                serde_json::to_string(&value).unwrap_or_default()
            };
            (s, false)
        }
        Err(e) => (e.to_string(), true),
    }
}

/// Truncate a tool result to at most `max_chars` characters, appending a
/// notice so the model knows output was cut.
///
/// `max_chars == 0` disables truncation and returns `output` unchanged. When
/// the output exceeds the limit, it is cut at a character boundary (counting
/// Unicode scalar values, not bytes, so multi-byte text is never split) and a
/// one-line notice with the kept/total character counts is appended.
///
/// Callers apply this before persisting the result, so the shortened form is
/// what gets stored and replayed on later turns — capping the context cost of
/// a large result for the rest of the conversation, not just the current
/// request.
pub fn truncate_tool_result(output: String, max_chars: usize) -> String {
    if max_chars == 0 {
        return output;
    }
    let total = output.chars().count();
    if total <= max_chars {
        return output;
    }
    let kept: String = output.chars().take(max_chars).collect();
    format!("{kept}\n\n[tool_result truncated: showing first {max_chars} of {total} characters]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_tool_uses_empty_input() {
        assert!(extract_tool_uses(&[]).is_empty());
    }

    #[test]
    fn extract_tool_uses_no_tool_blocks() {
        let blocks = vec![
            ContentBlock::Text {
                text: "hi".to_owned(),
            },
            ContentBlock::Thinking {
                thinking: "hmm".to_owned(),
                signature: None,
            },
        ];
        assert!(extract_tool_uses(&blocks).is_empty());
    }

    #[test]
    fn extract_tool_uses_mixed_blocks() {
        let blocks = vec![
            ContentBlock::Text {
                text: "let me look".to_owned(),
            },
            ContentBlock::ToolUse {
                id: "call_1".to_owned(),
                name: "search".to_owned(),
                input: json!({"q": "shore"}),
            },
            ContentBlock::RedactedThinking {
                data: "blob".to_owned(),
            },
            ContentBlock::ToolUse {
                id: "call_2".to_owned(),
                name: "fetch".to_owned(),
                input: json!({}),
            },
        ];
        let uses = extract_tool_uses(&blocks);
        assert_eq!(uses.len(), 2);
        assert_eq!(uses[0].0, "call_1");
        assert_eq!(uses[0].1, "search");
        assert_eq!(uses[1].0, "call_2");
    }

    #[test]
    fn truncate_zero_disables_returns_unchanged() {
        assert_eq!(truncate_tool_result("abc".to_owned(), 0), "abc");
    }

    #[test]
    fn truncate_under_limit_returns_unchanged() {
        assert_eq!(truncate_tool_result("abc".to_owned(), 10), "abc");
    }

    #[test]
    fn truncate_at_exact_limit_returns_unchanged() {
        assert_eq!(truncate_tool_result("abc".to_owned(), 3), "abc");
    }

    #[test]
    fn truncate_over_limit_cuts_and_annotates() {
        let out = truncate_tool_result("abcdef".to_owned(), 3);
        assert!(out.starts_with("abc"));
        assert!(out.contains("first 3 of 6 characters"));
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        // Cutting by bytes would split the multi-byte char and panic.
        let out = truncate_tool_result("héllo wörld".to_owned(), 4);
        assert!(out.starts_with("héll"));
    }
}
