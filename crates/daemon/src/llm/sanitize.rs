//! Defensive sanitization of tool_use / tool_result pairing in outbound LLM
//! requests. See `sanitize_tool_pairs` for details.

use serde_json::Value;

/// Strip orphan `tool_use` and `tool_result` blocks from a conversation.
///
/// Returns `None` when no orphans are present (the common, healthy case);
/// the caller should pass the original messages through unchanged. Returns
/// `Some(cleaned)` when orphans were dropped — the caller should send the
/// cleaned vector instead.
///
/// An "orphan" is a `tool_use` block in an assistant message whose `id` is
/// not referenced by any `tool_result` block elsewhere in the conversation,
/// or a `tool_result` block whose `tool_use_id` is not produced by any
/// `tool_use` block. Either case causes hard rejections from Anthropic and
/// OpenAI-family APIs (and confuses translation proxies like OpenRouter).
///
/// User and assistant messages whose content arrays empty out as a result
/// of stripping are dropped entirely. Non-tool blocks (`text`, `image`,
/// `thinking`, etc.) are preserved verbatim.
pub fn sanitize_tool_pairs(messages: &[Value]) -> Option<Vec<Value>> {
    // First pass: collect every tool_use id and every tool_result tool_use_id.
    let mut tool_use_ids = std::collections::HashSet::<String>::default();
    let mut tool_result_ids = std::collections::HashSet::<String>::default();

    for msg in messages {
        let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        for block in blocks {
            let ty = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match (role, ty) {
                ("assistant", "tool_use") => {
                    if let Some(id) = block.get("id").and_then(|i| i.as_str()) {
                        let _ignored = tool_use_ids.insert(id.to_owned());
                    }
                }
                ("user", "tool_result") => {
                    if let Some(id) = block.get("tool_use_id").and_then(|i| i.as_str()) {
                        let _ignored = tool_result_ids.insert(id.to_owned());
                    }
                }
                _ => {}
            }
        }
    }

    let orphan_tool_uses: std::collections::HashSet<&String> =
        tool_use_ids.difference(&tool_result_ids).collect();
    let orphan_tool_results: std::collections::HashSet<&String> =
        tool_result_ids.difference(&tool_use_ids).collect();

    if orphan_tool_uses.is_empty() && orphan_tool_results.is_empty() {
        return None;
    }

    // Second pass: rebuild messages with orphans stripped.
    let mut out: Vec<Value> = Vec::with_capacity(messages.len());
    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) else {
            // String content or no content — pass through.
            out.push(msg.clone());
            continue;
        };

        let mut kept: Vec<Value> = Vec::with_capacity(blocks.len());
        for block in blocks {
            let ty = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let drop = match (role, ty) {
                ("assistant", "tool_use") => block
                    .get("id")
                    .and_then(|i| i.as_str())
                    .is_some_and(|id| orphan_tool_uses.contains(&id.to_owned())),
                ("user", "tool_result") => block
                    .get("tool_use_id")
                    .and_then(|i| i.as_str())
                    .is_some_and(|id| orphan_tool_results.contains(&id.to_owned())),
                _ => false,
            };
            if !drop {
                kept.push(block.clone());
            }
        }

        if kept.is_empty() {
            // Whole message emptied out — drop it.
            continue;
        }

        let mut new_msg = msg.clone();
        if let Some(obj) = new_msg.as_object_mut() {
            let _ignored = obj.insert("content".into(), Value::Array(kept));
        }
        out.push(new_msg);
    }

    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn field<'val>(value: &'val Value, key: &str) -> &'val Value {
        value.get(key).expect("expected JSON field")
    }

    fn item<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item")
    }

    fn content_blocks(value: &Value) -> &[Value] {
        field(value, "content")
            .as_array()
            .expect("expected content blocks")
    }

    fn assistant_text(text: &str) -> Value {
        json!({
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        })
    }

    fn assistant_tool_use(id: &str, name: &str) -> Value {
        json!({
            "role": "assistant",
            "content": [{"type": "tool_use", "id": id, "name": name, "input": {}}],
        })
    }

    fn user_tool_result(id: &str, content: &str) -> Value {
        json!({
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": id, "content": content}],
        })
    }

    fn user_text(text: &str) -> Value {
        json!({
            "role": "user",
            "content": [{"type": "text", "text": text}],
        })
    }

    #[test]
    fn no_orphans_returns_none() {
        let msgs = vec![
            user_text("hi"),
            assistant_tool_use("call_1", "search"),
            user_tool_result("call_1", "5 results"),
            assistant_text("done"),
        ];
        assert!(sanitize_tool_pairs(&msgs).is_none());
    }

    #[test]
    fn empty_input_returns_none() {
        assert!(sanitize_tool_pairs(&[]).is_none());
    }

    #[test]
    fn no_tool_blocks_returns_none() {
        let msgs = vec![user_text("hi"), assistant_text("hello")];
        assert!(sanitize_tool_pairs(&msgs).is_none());
    }

    #[test]
    fn orphan_tool_result_only_block_drops_message() {
        // user msg with a tool_result that has no preceding tool_use:
        // the only block is the orphan, so the message itself is dropped.
        let msgs = vec![
            user_text("hi"),
            user_tool_result("orphan_id", "stale"),
            assistant_text("ok"),
        ];
        let cleaned = sanitize_tool_pairs(&msgs).expect("should detect orphan");
        assert_eq!(cleaned.len(), 2);
        assert_eq!(
            field(item(content_blocks(item(&cleaned, 0)), 0), "text"),
            "hi"
        );
        assert_eq!(
            field(item(content_blocks(item(&cleaned, 1)), 0), "text"),
            "ok"
        );
    }

    #[test]
    fn orphan_tool_use_only_block_drops_message() {
        // assistant msg with a tool_use that has no matching tool_result:
        // the only block is the orphan, so the message is dropped.
        let msgs = vec![
            user_text("hi"),
            assistant_tool_use("orphan_id", "search"),
            user_text("never mind"),
        ];
        let cleaned = sanitize_tool_pairs(&msgs).expect("should detect orphan");
        assert_eq!(cleaned.len(), 2);
        assert_eq!(
            field(item(content_blocks(item(&cleaned, 0)), 0), "text"),
            "hi"
        );
        assert_eq!(
            field(item(content_blocks(item(&cleaned, 1)), 0), "text"),
            "never mind"
        );
    }

    #[test]
    fn user_msg_with_text_and_orphan_keeps_text() {
        let msg = json!({
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "orphan", "content": "stale"},
                {"type": "text", "text": "actual question"},
            ],
        });
        let msgs = vec![msg];
        let cleaned = sanitize_tool_pairs(&msgs).expect("orphan present");
        assert_eq!(cleaned.len(), 1);
        let blocks = content_blocks(item(&cleaned, 0));
        assert_eq!(blocks.len(), 1);
        assert_eq!(field(item(blocks, 0), "type"), "text");
        assert_eq!(field(item(blocks, 0), "text"), "actual question");
    }

    #[test]
    fn assistant_msg_with_text_and_orphan_tool_use_keeps_text() {
        let msg = json!({
            "role": "assistant",
            "content": [
                {"type": "text", "text": "let me check"},
                {"type": "tool_use", "id": "orphan", "name": "search", "input": {}},
            ],
        });
        let msgs = vec![msg];
        let cleaned = sanitize_tool_pairs(&msgs).expect("orphan present");
        assert_eq!(cleaned.len(), 1);
        let blocks = content_blocks(item(&cleaned, 0));
        assert_eq!(blocks.len(), 1);
        assert_eq!(field(item(blocks, 0), "type"), "text");
    }

    #[test]
    fn user_msg_with_valid_and_orphan_tool_results_keeps_valid() {
        let msgs = vec![
            assistant_tool_use("real_id", "search"),
            json!({
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "real_id", "content": "good"},
                    {"type": "tool_result", "tool_use_id": "orphan_id", "content": "stale"},
                ],
            }),
        ];
        let cleaned = sanitize_tool_pairs(&msgs).expect("orphan present");
        assert_eq!(cleaned.len(), 2);
        let user_blocks = content_blocks(item(&cleaned, 1));
        assert_eq!(user_blocks.len(), 1);
        assert_eq!(field(item(user_blocks, 0), "tool_use_id"), "real_id");
    }

    #[test]
    fn multi_round_tool_loop_passes_through() {
        let msgs = vec![
            user_text("do two things"),
            assistant_tool_use("call_a", "search"),
            user_tool_result("call_a", "ok"),
            assistant_tool_use("call_b", "fetch"),
            user_tool_result("call_b", "ok"),
            assistant_text("done"),
        ];
        assert!(sanitize_tool_pairs(&msgs).is_none());
    }

    #[test]
    fn string_content_messages_pass_through() {
        // OpenAI-style string content — must not be treated as orphan candidates.
        let msgs = vec![
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": "hello"}),
            user_tool_result("orphan", "stale"),
        ];
        let cleaned = sanitize_tool_pairs(&msgs).expect("orphan present");
        // String-content messages pass through; only the orphan-only user
        // message is dropped.
        assert_eq!(cleaned.len(), 2);
        assert_eq!(field(item(&cleaned, 0), "content"), "hi");
        assert_eq!(field(item(&cleaned, 1), "content"), "hello");
    }
}
