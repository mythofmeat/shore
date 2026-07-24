//! Tool-loop message merging for client consumption.
//!
//! Storage keeps separate messages (assistant tool_use, user tool_result,
//! assistant text) for LLM API compatibility. This module collapses them
//! into single assistant messages for client display:
//!
//! ```text
//! [user, asst(tool_use), user(tool_result), asst(text)]
//!   -> [user, asst(thinking + tool_use + tool_result + text)]
//! ```

use crate::protocol::types::{ContentBlock, Message, Role};

/// A "tool loop assistant" has ToolUse blocks.
///
/// The model may emit text before calling tools ("let me check...") — this
/// text is still part of the tool loop and gets merged into the final
/// assistant message's content_blocks.
fn is_tool_loop_assistant(msg: &Message) -> bool {
    msg.role == Role::Assistant
        && msg
            .content_blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
}

/// A "tool result user" message has ONLY ToolResult blocks.
fn is_tool_result_only(msg: &Message) -> bool {
    msg.role == Role::User
        && !msg.content_blocks.is_empty()
        && msg
            .content_blocks
            .iter()
            .all(|b| matches!(b, ContentBlock::ToolResult { .. }))
}

/// Derive content from Text blocks only (for merged messages).
///
/// Excludes ToolResult content because merged messages embed tool results
/// in content_blocks.
fn derive_content_text_only(blocks: &[ContentBlock]) -> String {
    super::types::derive_content_from_blocks_with(blocks, false)
}

/// Collect blocks from one tool-loop round (assistant + user result pair).
///
/// Preserves block ordering: text and thinking blocks are emitted in their
/// original position, while each ToolUse is followed by its matching
/// ToolResult (matched by `id` == `tool_use_id`).
fn collect_round(assistant: &Message, results: Option<&Message>, out: &mut Vec<ContentBlock>) {
    for block in &assistant.content_blocks {
        match block {
            ContentBlock::ToolUse { id, .. } => {
                out.push(block.clone());
                // Find and emit the matching tool result.
                if let Some(result_msg) = results {
                    if let Some(tr) = result_msg.content_blocks.iter().find(|b| {
                        matches!(b, ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == id)
                    }) {
                        out.push(tr.clone());
                    }
                }
            }
            // Text, Thinking, RedactedThinking — emit in place.
            ContentBlock::Text { text } if text.trim().is_empty() => {
                // Skip whitespace-only text blocks (LLM noise).
            }
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => {
                out.push(block.clone());
            }
        }
    }
}

/// Merge tool-loop messages into logical assistant turns.
///
/// The merged message's `content_blocks` contain all blocks in interleaved
/// order: thinking blocks, then (tool_use, tool_result) pairs per round,
/// then text. The `content` field is derived from Text blocks only.
///
/// Messages without tool loops pass through unchanged. Tool-result-only
/// user messages are consumed by the merge and do not appear in output.
pub fn merge_tool_loop_messages(messages: &[Message]) -> Vec<Message> {
    let mut output: Vec<Message> = Vec::new();
    let mut i = 0;

    while let Some(msg) = messages.get(i) {
        // Non-assistant messages: pass through unless tool-result-only.
        if msg.role != Role::Assistant {
            if !is_tool_result_only(msg) {
                output.push(msg.clone());
            }
            i = i.saturating_add(1);
            continue;
        }

        // Assistant with Text blocks (not a tool-loop intermediate): pass through.
        if !is_tool_loop_assistant(msg) {
            output.push(msg.clone());
            i = i.saturating_add(1);
            continue;
        }

        // ── Tool loop detected ──────────────────────────────────────────
        let mut merged_blocks: Vec<ContentBlock> = Vec::new();
        let mut last_assistant = msg;

        while let Some(current) = messages.get(i) {
            // Peek at next for tool results.
            let results = i
                .checked_add(1)
                .and_then(|next_index| messages.get(next_index))
                .filter(|next| is_tool_result_only(next));
            let next_is_result = results.is_some();

            collect_round(current, results, &mut merged_blocks);
            last_assistant = current;

            // Consume the pair (or just the assistant if no result yet).
            if next_is_result {
                i = i.saturating_add(2);
            } else {
                i = i.saturating_add(1);
            }

            // Check what comes next.
            if i >= messages.len() {
                break; // End of conversation (incomplete loop).
            }

            let Some(next) = messages.get(i) else {
                break;
            };
            if next.role == Role::Assistant && is_tool_loop_assistant(next) {
                continue; // Another tool-loop round.
            }

            if next.role == Role::Assistant {
                // Final assistant message with text — append its blocks and finish.
                merged_blocks.extend(next.content_blocks.iter().cloned());
                last_assistant = next;
                i = i.saturating_add(1);
                break;
            }

            // Non-assistant (unexpected mid-loop, or just next user message).
            break;
        }

        // Build the merged message.
        let content = derive_content_text_only(&merged_blocks);
        output.push(Message {
            msg_id: last_assistant.msg_id.clone(),
            role: Role::Assistant,
            content,
            images: last_assistant.images.clone(),
            content_blocks: merged_blocks,
            alt_index: last_assistant.alt_index,
            alt_count: last_assistant.alt_count,
            alternatives: last_assistant.alternatives.clone(),
            timestamp: last_assistant.timestamp.clone(),
            provider_key: last_assistant.provider_key.clone(),
            model: last_assistant.model.clone(),
            origin: last_assistant.origin,
        });
    }

    output
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_msg(id: &str, role: Role, content: &str, blocks: Vec<ContentBlock>) -> Message {
        Message {
            msg_id: id.into(),
            role,
            content: content.into(),
            images: vec![],
            content_blocks: blocks,
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            origin: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn user_msg(id: &str, content: &str) -> Message {
        make_msg(id, Role::User, content, vec![])
    }

    fn assistant_text(id: &str, text: &str) -> Message {
        make_msg(
            id,
            Role::Assistant,
            text,
            vec![ContentBlock::Text { text: text.into() }],
        )
    }

    fn assistant_tool_use(id: &str, tools: Vec<(&str, &str)>) -> Message {
        let blocks: Vec<ContentBlock> = tools
            .into_iter()
            .map(|(tid, name)| ContentBlock::ToolUse {
                id: tid.into(),
                name: name.into(),
                input: json!({}),
            })
            .collect();
        make_msg(id, Role::Assistant, "", blocks)
    }

    fn assistant_thinking_and_tool_use(
        id: &str,
        thinking: &str,
        tools: Vec<(&str, &str)>,
    ) -> Message {
        let mut blocks = vec![ContentBlock::Thinking {
            thinking: thinking.into(),
            signature: None,
        }];
        for (tid, name) in tools {
            blocks.push(ContentBlock::ToolUse {
                id: tid.into(),
                name: name.into(),
                input: json!({}),
            });
        }
        make_msg(id, Role::Assistant, "", blocks)
    }

    fn user_tool_results(id: &str, results: Vec<(&str, &str, bool)>) -> Message {
        let blocks: Vec<ContentBlock> = results
            .into_iter()
            .map(|(tid, content, is_error)| ContentBlock::ToolResult {
                tool_use_id: tid.into(),
                content: content.into(),
                is_error,
            })
            .collect();
        let content = crate::protocol::types::derive_content_from_blocks(&blocks);
        make_msg(id, Role::User, &content, blocks)
    }

    fn item<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item")
    }

    // ── Basic cases ─────────────────────────────────────────────────

    #[test]
    fn empty_conversation() {
        assert!(merge_tool_loop_messages(&[]).is_empty());
    }

    #[test]
    fn no_tool_use() {
        let msgs = vec![user_msg("u1", "hello"), assistant_text("a1", "hi there")];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        assert_eq!(item(&merged, 0).msg_id, "u1");
        assert_eq!(item(&merged, 1).msg_id, "a1");
    }

    #[test]
    fn whitespace_text_block_does_not_prevent_merge() {
        // Real-world: LLM emits "\n\n" text block before thinking/tool_use.
        let mut asst = assistant_thinking_and_tool_use(
            "a1",
            "Let me check",
            vec![("t1", "memory_search"), ("t2", "check_time")],
        );
        // Insert a whitespace-only Text block at the front (as the LLM does).
        asst.content_blocks.insert(
            0,
            ContentBlock::Text {
                text: "\n\n".into(),
            },
        );

        let msgs = vec![
            user_msg("u1", "hello"),
            asst,
            user_tool_results(
                "u2",
                vec![("t1", "mem result", false), ("t2", "3:22 PM", false)],
            ),
            assistant_text("a2", "Hey there!"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2, "should merge into user + assistant");
        let assistant = item(&merged, 1);
        assert_eq!(assistant.msg_id, "a2");
        assert_eq!(assistant.content, "Hey there!");

        // Blocks: thinking, tu(memory_search), tr(memory_search), tu(check_time), tr(check_time), text
        let blocks = &assistant.content_blocks;
        assert_eq!(blocks.len(), 6);
        assert!(matches!(item(blocks, 0), ContentBlock::Thinking { .. }));
        assert!(
            matches!(item(blocks, 1), ContentBlock::ToolUse { name, .. } if name == "memory_search")
        );
        assert!(matches!(item(blocks, 2), ContentBlock::ToolResult { .. }));
        assert!(
            matches!(item(blocks, 3), ContentBlock::ToolUse { name, .. } if name == "check_time")
        );
        assert!(matches!(item(blocks, 4), ContentBlock::ToolResult { .. }));
        assert!(matches!(item(blocks, 5), ContentBlock::Text { text } if text == "Hey there!"));
    }

    #[test]
    fn text_before_tool_calls_merged() {
        // Real-world: model says "let me check" then calls tools.
        let mut asst =
            assistant_tool_use("a1", vec![("t1", "memory_search"), ("t2", "check_time")]);
        asst.content_blocks.insert(
            0,
            ContentBlock::Text {
                text: "let me look that up!".into(),
            },
        );

        let msgs = vec![
            user_msg("u1", "what do you know about me?"),
            asst,
            user_tool_results(
                "u2",
                vec![("t1", "Trevor", false), ("t2", "3:22 PM", false)],
            ),
            assistant_text("a2", "You're Trevor!"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2, "should merge into user + assistant");
        let assistant = item(&merged, 1);
        assert_eq!(assistant.msg_id, "a2");

        // Blocks: text("let me look..."), tu(memory_search), tr(memory_search), tu(check_time), tr(check_time), text("You're Trevor!")
        let blocks = &assistant.content_blocks;
        assert_eq!(blocks.len(), 6);
        assert!(
            matches!(item(blocks, 0), ContentBlock::Text { text } if text == "let me look that up!")
        );
        assert!(
            matches!(item(blocks, 1), ContentBlock::ToolUse { name, .. } if name == "memory_search")
        );
        assert!(matches!(item(blocks, 2), ContentBlock::ToolResult { .. }));
        assert!(
            matches!(item(blocks, 3), ContentBlock::ToolUse { name, .. } if name == "check_time")
        );
        assert!(matches!(item(blocks, 4), ContentBlock::ToolResult { .. }));
        assert!(matches!(item(blocks, 5), ContentBlock::Text { text } if text == "You're Trevor!"));

        // content includes both text blocks
        assert!(assistant.content.contains("let me look that up!"));
        assert!(assistant.content.contains("You're Trevor!"));
    }

    #[test]
    fn single_tool_round() {
        let msgs = vec![
            user_msg("u1", "what time is it?"),
            assistant_tool_use("a1", vec![("t1", "check_time")]),
            user_tool_results("u2", vec![("t1", "3:22 PM", false)]),
            assistant_text("a2", "It's 3:22 PM!"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        assert_eq!(item(&merged, 0).msg_id, "u1");
        let assistant = item(&merged, 1);
        assert_eq!(assistant.msg_id, "a2");
        assert_eq!(assistant.content, "It's 3:22 PM!");

        // Check blocks: tool_use, tool_result, text
        let blocks = &assistant.content_blocks;
        assert_eq!(blocks.len(), 3);
        assert!(
            matches!(item(blocks, 0), ContentBlock::ToolUse { name, .. } if name == "check_time")
        );
        assert!(
            matches!(item(blocks, 1), ContentBlock::ToolResult { content, .. } if content == "3:22 PM")
        );
        assert!(matches!(item(blocks, 2), ContentBlock::Text { text } if text == "It's 3:22 PM!"));
    }

    #[test]
    fn multiple_tools_single_round() {
        let msgs = vec![
            user_msg("u1", "time and save"),
            assistant_tool_use("a1", vec![("t1", "check_time"), ("t2", "memory_write")]),
            user_tool_results("u2", vec![("t1", "3:22 PM", false), ("t2", "saved", false)]),
            assistant_text("a2", "Done!"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);

        let blocks = &item(&merged, 1).content_blocks;
        assert_eq!(blocks.len(), 5); // tu1, tr1, tu2, tr2, text
        assert!(matches!(item(blocks, 0), ContentBlock::ToolUse { id, .. } if id == "t1"));
        assert!(
            matches!(item(blocks, 1), ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "t1")
        );
        assert!(matches!(item(blocks, 2), ContentBlock::ToolUse { id, .. } if id == "t2"));
        assert!(
            matches!(item(blocks, 3), ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "t2")
        );
        assert!(matches!(item(blocks, 4), ContentBlock::Text { .. }));
    }

    #[test]
    fn multi_round_tool_loop() {
        let msgs = vec![
            user_msg("u1", "do stuff"),
            assistant_tool_use("a1", vec![("t1", "search")]),
            user_tool_results("u2", vec![("t1", "result A", false)]),
            assistant_tool_use("a2", vec![("t2", "fetch")]),
            user_tool_results("u3", vec![("t2", "result B", false)]),
            assistant_text("a3", "Here you go."),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        assert_eq!(item(&merged, 1).msg_id, "a3");

        let blocks = &item(&merged, 1).content_blocks;
        assert_eq!(blocks.len(), 5); // tu1, tr1, tu2, tr2, text
    }

    // ── Thinking ────────────────────────────────────────────────────

    #[test]
    fn thinking_preserved() {
        let msgs = vec![
            user_msg("u1", "remember me?"),
            assistant_thinking_and_tool_use(
                "a1",
                "Let me search memory",
                vec![("t1", "memory_search")],
            ),
            user_tool_results("u2", vec![("t1", "Trevor", false)]),
            assistant_text("a2", "Yes, you're Trevor!"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);

        let blocks = &item(&merged, 1).content_blocks;
        assert_eq!(blocks.len(), 4); // thinking, tool_use, tool_result, text
        assert!(
            matches!(item(blocks, 0), ContentBlock::Thinking { thinking, .. } if thinking == "Let me search memory")
        );
        assert!(matches!(item(blocks, 1), ContentBlock::ToolUse { .. }));
        assert!(matches!(item(blocks, 2), ContentBlock::ToolResult { .. }));
        assert!(matches!(item(blocks, 3), ContentBlock::Text { .. }));
    }

    #[test]
    fn redacted_thinking_preserved() {
        let mut msgs = vec![user_msg("u1", "test")];
        // Assistant with redacted thinking + tool use.
        let blocks = vec![
            ContentBlock::RedactedThinking {
                data: "opaque".into(),
            },
            ContentBlock::ToolUse {
                id: "t1".into(),
                name: "search".into(),
                input: json!({}),
            },
        ];
        msgs.push(make_msg("a1", Role::Assistant, "", blocks.clone()));
        msgs.push(user_tool_results("u2", vec![("t1", "found", false)]));
        msgs.push(assistant_text("a2", "Result"));

        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        assert!(matches!(
            item(&item(&merged, 1).content_blocks, 0),
            ContentBlock::RedactedThinking { .. }
        ));
    }

    // ── Incomplete loops ────────────────────────────────────────────

    #[test]
    fn incomplete_loop_no_result() {
        let msgs = vec![
            user_msg("u1", "test"),
            assistant_tool_use("a1", vec![("t1", "search")]),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        let assistant = item(&merged, 1);
        assert_eq!(assistant.msg_id, "a1");
        assert_eq!(assistant.content_blocks.len(), 1);
        assert!(matches!(
            item(&assistant.content_blocks, 0),
            ContentBlock::ToolUse { .. }
        ));
    }

    #[test]
    fn incomplete_loop_mid_chain() {
        let msgs = vec![
            user_msg("u1", "test"),
            assistant_tool_use("a1", vec![("t1", "search")]),
            user_tool_results("u2", vec![("t1", "result", false)]),
            assistant_tool_use("a2", vec![("t2", "fetch")]),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        assert_eq!(item(&merged, 1).msg_id, "a2");

        let blocks = &item(&merged, 1).content_blocks;
        assert_eq!(blocks.len(), 3); // tu1, tr1, tu2 (no tr2, no text)
    }

    // ── Content field ───────────────────────────────────────────────

    #[test]
    fn content_field_text_only() {
        let msgs = vec![
            user_msg("u1", "test"),
            assistant_tool_use("a1", vec![("t1", "check_time")]),
            user_tool_results("u2", vec![("t1", "3:22 PM", false)]),
            assistant_text("a2", "The time is 3:22 PM."),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        // Content should be the text response only, not tool results.
        assert_eq!(item(&merged, 1).content, "The time is 3:22 PM.");
    }

    #[test]
    fn content_field_empty_for_incomplete() {
        let msgs = vec![
            user_msg("u1", "test"),
            assistant_tool_use("a1", vec![("t1", "search")]),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(item(&merged, 1).content, "");
    }

    // ── Metadata inheritance ────────────────────────────────────────

    #[test]
    fn merged_msg_inherits_final_metadata() {
        let mut final_msg = assistant_text("a_final", "Done");
        final_msg.timestamp = "2026-03-29T15:30:00Z".into();
        final_msg.alt_index = Some(1);
        final_msg.alt_count = Some(3);
        final_msg.provider_key = Some("anthropic".into());
        final_msg.model = Some("claude-opus-4-6".into());

        let msgs = vec![
            user_msg("u1", "test"),
            assistant_tool_use("a1", vec![("t1", "search")]),
            user_tool_results("u2", vec![("t1", "found", false)]),
            final_msg,
        ];
        let merged = merge_tool_loop_messages(&msgs);
        let assistant = item(&merged, 1);
        assert_eq!(assistant.msg_id, "a_final");
        assert_eq!(assistant.timestamp, "2026-03-29T15:30:00Z");
        assert_eq!(assistant.alt_index, Some(1));
        assert_eq!(assistant.alt_count, Some(3));
        assert_eq!(assistant.provider_key.as_deref(), Some("anthropic"));
        assert_eq!(assistant.model.as_deref(), Some("claude-opus-4-6"));
    }

    // ── Filtering ───────────────────────────────────────────────────

    #[test]
    fn orphan_tool_result_user_filtered() {
        let msgs = vec![
            user_msg("u1", "hello"),
            user_tool_results("u2", vec![("t1", "orphan result", false)]),
            assistant_text("a1", "hi"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        assert_eq!(item(&merged, 0).msg_id, "u1");
        assert_eq!(item(&merged, 1).msg_id, "a1");
    }

    #[test]
    fn normal_user_messages_preserved() {
        let msgs = vec![
            user_msg("u1", "first"),
            assistant_text("a1", "reply 1"),
            user_msg("u2", "second"),
            assistant_text("a2", "reply 2"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 4);
    }

    #[test]
    fn system_messages_preserved() {
        let msgs = vec![
            make_msg("s1", Role::System, "system prompt", vec![]),
            user_msg("u1", "hello"),
            assistant_text("a1", "hi"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 3);
        assert_eq!(item(&merged, 0).role, Role::System);
    }

    // ── Multiple exchanges ──────────────────────────────────────────

    #[test]
    fn multiple_exchanges_only_first_has_tools() {
        let msgs = vec![
            user_msg("u1", "time?"),
            assistant_tool_use("a1", vec![("t1", "check_time")]),
            user_tool_results("u2", vec![("t1", "3:22 PM", false)]),
            assistant_text("a2", "It's 3:22 PM"),
            user_msg("u3", "thanks"),
            assistant_text("a3", "You're welcome!"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 4);
        assert_eq!(item(&merged, 0).msg_id, "u1");
        assert_eq!(item(&merged, 1).msg_id, "a2"); // merged
        assert_eq!(item(&merged, 2).msg_id, "u3");
        assert_eq!(item(&merged, 3).msg_id, "a3"); // passthrough
    }

    #[test]
    fn both_exchanges_have_tools() {
        let msgs = vec![
            user_msg("u1", "time?"),
            assistant_tool_use("a1", vec![("t1", "check_time")]),
            user_tool_results("u2", vec![("t1", "3:22 PM", false)]),
            assistant_text("a2", "3:22"),
            user_msg("u3", "remember me"),
            assistant_tool_use("a3", vec![("t2", "memory_search")]),
            user_tool_results("u4", vec![("t2", "Trevor", false)]),
            assistant_text("a4", "Hi Trevor!"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 4);
        assert_eq!(item(&merged, 1).content_blocks.len(), 3); // tu, tr, text
        assert_eq!(item(&merged, 3).content_blocks.len(), 3); // tu, tr, text
    }

    // ── Legacy messages ─────────────────────────────────────────────

    #[test]
    fn legacy_messages_without_content_blocks() {
        let msgs = vec![
            make_msg("u1", Role::User, "old message", vec![]),
            make_msg("a1", Role::Assistant, "old reply", vec![]),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        assert_eq!(item(&merged, 0).content, "old message");
        assert_eq!(item(&merged, 1).content, "old reply");
    }

    // ── Error results ───────────────────────────────────────────────

    #[test]
    fn unmatched_tool_use_id_no_result_paired() {
        // Assistant calls tool "t1" but result message has "t999" — no match.
        let msgs = vec![
            user_msg("u1", "test"),
            assistant_tool_use("a1", vec![("t1", "search")]),
            user_tool_results("u2", vec![("t999", "orphan result", false)]),
            assistant_text("a2", "Done"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        assert_eq!(merged.len(), 2);
        // ToolUse present but no ToolResult paired (mismatched IDs).
        let blocks = &item(&merged, 1).content_blocks;
        assert!(matches!(item(blocks, 0), ContentBlock::ToolUse { id, .. } if id == "t1"));
        // No ToolResult for t1 in the merged output.
        assert!(
            !blocks.iter().any(
                |b| matches!(b, ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "t1")
            ),
            "should not have a tool result for t1"
        );
    }

    #[test]
    fn multiple_tool_uses_partial_results() {
        // Two tools called, but only one has a matching result.
        let msgs = vec![
            user_msg("u1", "test"),
            assistant_tool_use("a1", vec![("t1", "search"), ("t2", "fetch")]),
            user_tool_results("u2", vec![("t1", "found it", false)]),
            assistant_text("a2", "Result"),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        let blocks = &item(&merged, 1).content_blocks;
        // t1 should have its result paired, t2 should not.
        assert!(matches!(item(blocks, 0), ContentBlock::ToolUse { id, .. } if id == "t1"));
        assert!(
            matches!(item(blocks, 1), ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "t1")
        );
        assert!(matches!(item(blocks, 2), ContentBlock::ToolUse { id, .. } if id == "t2"));
        // No ToolResult for t2.
        assert!(!blocks.iter().any(
            |b| matches!(b, ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "t2")
        ));
    }

    #[test]
    fn tool_error_results_preserved() {
        let msgs = vec![
            user_msg("u1", "search something"),
            assistant_tool_use("a1", vec![("t1", "web_search")]),
            user_tool_results("u2", vec![("t1", "Connection refused", true)]),
            assistant_text("a2", "Sorry, the search failed."),
        ];
        let merged = merge_tool_loop_messages(&msgs);
        let blocks = &item(&merged, 1).content_blocks;
        assert!(matches!(
            item(blocks, 1),
            ContentBlock::ToolResult { is_error, content, .. }
            if *is_error && content == "Connection refused"
        ));
    }
}
