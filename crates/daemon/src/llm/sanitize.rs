//! Defensive sanitization of tool_use / tool_result pairing in outbound LLM
//! requests. See `sanitize_tool_pairs` for details.
//!
//! **Ported.** `llm-sidecar/src/llm/sanitize.ts` is the implementation now,
//! pinned by `llm-sidecar/tests/llm_fixtures/sanitize_parity.json` (frozen;
//! generated from this file at 9023b46d). Do not add behaviour here.
//!
//! Not deleted yet: `llm/mod.rs::preprocess_request` is its only caller and has
//! not moved (#12, step 3). It goes with it.

use crate::llm::types::{WireBlock, WireMessage, WireRole};

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
pub fn sanitize_tool_pairs(messages: &[WireMessage]) -> Option<Vec<WireMessage>> {
    // First pass: collect every tool_use id and every tool_result tool_use_id.
    let mut tool_use_ids = std::collections::HashSet::<&str>::default();
    let mut tool_result_ids = std::collections::HashSet::<&str>::default();

    for msg in messages {
        for block in &msg.content {
            match (msg.role, block) {
                (WireRole::Assistant, WireBlock::ToolUse { id, .. }) => {
                    let _ignored = tool_use_ids.insert(id.as_str());
                }
                (WireRole::User, WireBlock::ToolResult { tool_use_id, .. }) => {
                    let _ignored = tool_result_ids.insert(tool_use_id.as_str());
                }
                _ => {}
            }
        }
    }

    let orphan_tool_uses: std::collections::HashSet<&&str> =
        tool_use_ids.difference(&tool_result_ids).collect();
    let orphan_tool_results: std::collections::HashSet<&&str> =
        tool_result_ids.difference(&tool_use_ids).collect();

    if orphan_tool_uses.is_empty() && orphan_tool_results.is_empty() {
        return None;
    }

    // Second pass: rebuild messages with orphans stripped.
    let mut out: Vec<WireMessage> = Vec::with_capacity(messages.len());
    for msg in messages {
        let kept: Vec<WireBlock> = msg
            .content
            .iter()
            .filter(|block| match (msg.role, block) {
                (WireRole::Assistant, WireBlock::ToolUse { id, .. }) => {
                    !orphan_tool_uses.contains(&id.as_str())
                }
                (WireRole::User, WireBlock::ToolResult { tool_use_id, .. }) => {
                    !orphan_tool_results.contains(&tool_use_id.as_str())
                }
                _ => true,
            })
            .cloned()
            .collect();

        if kept.is_empty() {
            // Whole message emptied out — drop it.
            continue;
        }

        out.push(WireMessage {
            role: msg.role,
            content: kept,
            provider_key: msg.provider_key.clone(),
            model: msg.model.clone(),
        });
    }

    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::ToolResultContent;

    fn item<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item")
    }

    fn content_blocks(msg: &WireMessage) -> &[WireBlock] {
        &msg.content
    }

    fn block_text(block: &WireBlock) -> &str {
        let WireBlock::Text { text } = block else {
            panic!("expected a text block, got {block:?}")
        };
        text
    }

    fn tool_result_id(block: &WireBlock) -> &str {
        let WireBlock::ToolResult { tool_use_id, .. } = block else {
            panic!("expected a tool_result block, got {block:?}")
        };
        tool_use_id
    }

    fn assistant_text(text: &str) -> WireMessage {
        WireMessage::text(WireRole::Assistant, text)
    }

    fn tool_use_block(id: &str, name: &str) -> WireBlock {
        WireBlock::ToolUse {
            id: id.to_owned(),
            name: name.to_owned(),
            input: serde_json::json!({}),
        }
    }

    fn tool_result_block(id: &str, content: &str) -> WireBlock {
        WireBlock::ToolResult {
            tool_use_id: id.to_owned(),
            content: ToolResultContent::Text(content.to_owned()),
            is_error: false,
        }
    }

    fn assistant_tool_use(id: &str, name: &str) -> WireMessage {
        WireMessage::new(WireRole::Assistant, vec![tool_use_block(id, name)])
    }

    fn user_tool_result(id: &str, content: &str) -> WireMessage {
        WireMessage::new(WireRole::User, vec![tool_result_block(id, content)])
    }

    fn user_text(text: &str) -> WireMessage {
        WireMessage::text(WireRole::User, text)
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
        assert_eq!(block_text(item(content_blocks(item(&cleaned, 0)), 0)), "hi");
        assert_eq!(block_text(item(content_blocks(item(&cleaned, 1)), 0)), "ok");
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
        assert_eq!(block_text(item(content_blocks(item(&cleaned, 0)), 0)), "hi");
        assert_eq!(
            block_text(item(content_blocks(item(&cleaned, 1)), 0)),
            "never mind"
        );
    }

    #[test]
    fn user_msg_with_text_and_orphan_keeps_text() {
        let msgs = vec![WireMessage::new(
            WireRole::User,
            vec![
                tool_result_block("orphan", "stale"),
                WireBlock::text("actual question"),
            ],
        )];
        let cleaned = sanitize_tool_pairs(&msgs).expect("orphan present");
        assert_eq!(cleaned.len(), 1);
        let blocks = content_blocks(item(&cleaned, 0));
        assert_eq!(blocks.len(), 1);
        assert_eq!(block_text(item(blocks, 0)), "actual question");
    }

    #[test]
    fn assistant_msg_with_text_and_orphan_tool_use_keeps_text() {
        let msgs = vec![WireMessage::new(
            WireRole::Assistant,
            vec![
                WireBlock::text("let me check"),
                tool_use_block("orphan", "search"),
            ],
        )];
        let cleaned = sanitize_tool_pairs(&msgs).expect("orphan present");
        assert_eq!(cleaned.len(), 1);
        let blocks = content_blocks(item(&cleaned, 0));
        assert_eq!(blocks.len(), 1);
        assert_eq!(block_text(item(blocks, 0)), "let me check");
    }

    #[test]
    fn user_msg_with_valid_and_orphan_tool_results_keeps_valid() {
        let msgs = vec![
            assistant_tool_use("real_id", "search"),
            WireMessage::new(
                WireRole::User,
                vec![
                    tool_result_block("real_id", "good"),
                    tool_result_block("orphan_id", "stale"),
                ],
            ),
        ];
        let cleaned = sanitize_tool_pairs(&msgs).expect("orphan present");
        assert_eq!(cleaned.len(), 2);
        let user_blocks = content_blocks(item(&cleaned, 1));
        assert_eq!(user_blocks.len(), 1);
        assert_eq!(tool_result_id(item(user_blocks, 0)), "real_id");
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
    fn plain_text_turns_pass_through() {
        // Turns carrying no tool blocks are never orphan candidates. This used
        // to also cover a bare-string `content` shape; `WireMessage` has no
        // such shape, so that case is now unrepresentable rather than handled.
        let msgs = vec![
            user_text("hi"),
            assistant_text("hello"),
            user_tool_result("orphan", "stale"),
        ];
        let cleaned = sanitize_tool_pairs(&msgs).expect("orphan present");
        assert_eq!(cleaned.len(), 2, "only the orphan-only turn is dropped");
        assert_eq!(block_text(item(content_blocks(item(&cleaned, 0)), 0)), "hi");
        assert_eq!(
            block_text(item(content_blocks(item(&cleaned, 1)), 0)),
            "hello"
        );
    }
}
