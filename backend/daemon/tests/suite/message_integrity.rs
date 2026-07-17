use serde_json::json;
use shore_protocol::server_msg::ServerMessage;
use shore_test_harness::{AnthropicStreamBuilder, TestHarness};

/// Verify that a multi-turn conversation with tool calls maintains structural
/// integrity: every tool_use block in the final LLM request has a matching
/// tool_result, and the message array alternates user/assistant correctly.
#[expect(
    clippy::indexing_slicing,
    reason = "indexes known-shape command-output JSON / Vec fixtures and panics on mismatch"
)]
#[expect(
    clippy::too_many_lines,
    reason = "end-to-end scenario drives multiple turns with tool calls through the full pipeline"
)]
#[tokio::test]
async fn test_multi_turn_tool_conversation_valid() {
    let mut harness = TestHarness::boot().await;

    // Round 1: plain text exchange
    harness
        .mock_llm
        .enqueue_text("Hello! How can I help you?")
        .await;
    let r1 = harness.send_and_collect("Hi there").await;
    r1.assert_text_contains("Hello");

    // Round 2: LLM responds with a tool call, then a follow-up text
    harness
        .mock_llm
        .enqueue_tool_use("toolu_r2_01", "roll_dice", json!({"notation": "2d6"}))
        .await;
    harness.mock_llm.enqueue_text("You rolled a nine.").await;
    let _ignored = harness
        .conn
        .send_message("Roll me some dice.", true)
        .await
        .expect("failed to send message");
    let _r2_phase1 = harness.collect_stream().await;
    let r2_phase2 = harness.collect_stream().await;
    r2_phase2.assert_text_contains("rolled a nine");

    // Round 3: another tool call
    harness
        .mock_llm
        .enqueue_tool_use("toolu_r3_01", "roll_dice", json!({"notation": "2d6"}))
        .await;
    harness.mock_llm.enqueue_text("Rolled again.").await;
    _ = harness
        .conn
        .send_message("And roll again.", true)
        .await
        .expect("failed to send message");
    let _r3_phase1 = harness.collect_stream().await;
    let r3_phase2 = harness.collect_stream().await;
    r3_phase2.assert_text_contains("Rolled again");

    // Round 4: plain text final response
    harness.mock_llm.enqueue_text("All done!").await;
    let r4 = harness.send_and_collect("Thanks!").await;
    r4.assert_text_contains("All done");

    // Inspect the LAST request sent to the mock — it has the full conversation history.
    let requests = harness.mock_llm.received_requests().await;
    assert!(
        !requests.is_empty(),
        "Expected at least one LLM request, got none"
    );
    let last_req = requests.last().unwrap();
    let messages = last_req
        .get("messages")
        .and_then(|m| m.as_array())
        .expect("Expected 'messages' array in last request body");

    // Collect all tool_use IDs and all tool_result IDs from the messages array.
    let mut tool_use_ids: Vec<String> = Vec::new();
    let mut tool_result_ids: Vec<String> = Vec::new();

    for msg in messages {
        let Some(content) = msg.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        for block in content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("tool_use") => {
                    if let Some(id) = block.get("id").and_then(|id| id.as_str()) {
                        tool_use_ids.push(id.to_owned());
                    }
                }
                Some("tool_result") => {
                    if let Some(id) = block.get("tool_use_id").and_then(|id| id.as_str()) {
                        tool_result_ids.push(id.to_owned());
                    }
                }
                _ => {}
            }
        }
    }

    // Every tool_result must have a matching tool_use.
    for result_id in &tool_result_ids {
        assert!(
            tool_use_ids.contains(result_id),
            "tool_result with id '{result_id}' has no matching tool_use. tool_use IDs: {tool_use_ids:?}"
        );
    }

    // Every tool_use must have a matching tool_result (no orphaned tool_use blocks).
    for use_id in &tool_use_ids {
        assert!(
            tool_result_ids.contains(use_id),
            "tool_use with id '{use_id}' has no matching tool_result. tool_result IDs: {tool_result_ids:?}"
        );
    }

    // Validate message role alternation: user/assistant must strictly alternate.
    // tool_result blocks are sent as user messages, so adjacent user messages are
    // allowed when one carries tool_results. We just check no two plain-text
    // assistant messages appear back-to-back without an intervening user message.
    let roles: Vec<&str> = messages
        .iter()
        .filter_map(|m| m.get("role").and_then(|r| r.as_str()))
        .collect();
    assert!(
        !roles.is_empty(),
        "Expected non-empty roles in messages array"
    );
    // First message must be user.
    assert_eq!(
        roles[0], "user",
        "Expected first message to be 'user', got '{}'",
        roles[0]
    );
    // No two consecutive assistant messages.
    for window in roles.windows(2) {
        assert!(
            !(window[0] == "assistant" && window[1] == "assistant"),
            "Found two consecutive 'assistant' messages in the messages array: {roles:?}"
        );
    }

    harness.shutdown().await;
}

/// Verify that the system prompt sent to the LLM doesn't contain stale internal
/// XML syntax like `<sendMessage>` or raw tool call brackets.
#[tokio::test]
async fn test_request_body_no_stale_metadata() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("First response").await;
    let _r1 = harness.send_and_collect("Hello").await;

    harness.mock_llm.enqueue_text("Second response").await;
    let _r2 = harness.send_and_collect("How are you?").await;

    let requests = harness.mock_llm.received_requests().await;
    assert!(
        !requests.is_empty(),
        "Expected at least one LLM request, got none"
    );

    let last_req = requests.last().unwrap();

    // Extract system field as a string for inspection.
    let system_str = match last_req.get("system") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(blocks)) => {
            // System may be an array of cache-control blocks; concatenate text fields.
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        }
        Some(other) => other.to_string(),
        None => String::new(),
    };

    assert!(
        !system_str.contains("<sendMessage>"),
        "System prompt contains leaked <sendMessage> open tag:\n{system_str}"
    );
    assert!(
        !system_str.contains("</sendMessage>"),
        "System prompt contains leaked </sendMessage> close tag:\n{system_str}"
    );

    harness.shutdown().await;
}

/// Verify that the `system` field in EVERY request sent to the LLM is a JSON
/// array of `{"type": "text", "text": "..."}` blocks — never a bare string.
/// The Anthropic API rejects bare-string system prompts.
#[tokio::test]
async fn test_system_prompt_always_array_format() {
    let mut harness = TestHarness::boot().await;

    // Round 1: simple exchange
    harness.mock_llm.enqueue_text("Hello!").await;
    let _r1 = harness.send_and_collect("Hi").await;

    // Round 2: tool call round-trip (exercises post-tool request too)
    harness
        .mock_llm
        .enqueue_tool_use("toolu_sys_01", "roll_dice", json!({"notation": "2d6"}))
        .await;
    harness.mock_llm.enqueue_text("You rolled a seven.").await;
    let _ignored = harness
        .conn
        .send_message("Roll again?", true)
        .await
        .expect("failed to send message");
    let _phase1 = harness.collect_stream().await;
    let _phase2 = harness.collect_stream().await;

    // Now inspect EVERY request the mock received.
    let requests = harness.mock_llm.received_requests().await;
    assert!(
        !requests.is_empty(),
        "Expected at least one LLM request, got none"
    );

    for (i, req) in requests.iter().enumerate() {
        let Some(system) = req.get("system") else {
            // system field absent is fine (unlikely but valid)
            continue;
        };

        assert!(
            system.is_array(),
            "Request {i} has 'system' as a string instead of an array. \
             All system prompts must be arrays of {{\"type\": \"text\", \"text\": \"...\"}} blocks. \
             Got: {system}"
        );

        let blocks = system.as_array().unwrap();
        for (j, block) in blocks.iter().enumerate() {
            assert_eq!(
                block.get("type").and_then(|t| t.as_str()),
                Some("text"),
                "Request {i} system block {j} missing type: 'text'. Got: {block}"
            );
            assert!(
                block.get("text").and_then(|t| t.as_str()).is_some(),
                "Request {i} system block {j} missing 'text' field. Got: {block}"
            );
        }
    }

    harness.shutdown().await;
}

/// Verify that when the LLM returns two tool_use blocks in a single response,
/// the follow-up request carries two tool_result blocks with unique IDs.
#[expect(
    clippy::indexing_slicing,
    reason = "indexes known-shape command-output JSON / Vec fixtures and panics on mismatch"
)]
#[expect(
    clippy::too_many_lines,
    reason = "end-to-end scenario verifies two simultaneous tool_use blocks get unique IDs"
)]
#[tokio::test]
async fn test_multiple_tool_calls_have_unique_ids() {
    let mut harness = TestHarness::boot().await;

    // Enqueue a response with TWO tool_use blocks in the same message.
    let two_tools = AnthropicStreamBuilder::new()
        .tool_use("toolu_multi_01", "roll_dice", json!({"notation": "2d6"}))
        .tool_use("toolu_multi_02", "roll_dice", json!({"notation": "2d6"}));
    harness.mock_llm.enqueue_stream(two_tools).await;

    // Follow-up text response after both tools execute.
    harness.mock_llm.enqueue_text("Both tools executed.").await;

    let _ignored = harness
        .conn
        .send_message("Run two tools please", true)
        .await
        .expect("failed to send message");

    // Collect phase 1 (tool_use event) and phase 2 (final text).
    let _phase1 = harness.collect_stream().await;
    let phase2 = harness.collect_stream().await;
    phase2.assert_text_contains("Both tools executed");

    // Check the SECOND request (post-tool) for two tool_result blocks with unique IDs.
    let requests = harness.mock_llm.received_requests().await;
    assert!(
        requests.len() >= 2,
        "Expected at least 2 LLM requests (initial + post-tool), got {}",
        requests.len()
    );

    let post_tool_req = &requests[requests.len() - 1];
    let messages = post_tool_req
        .get("messages")
        .and_then(|m| m.as_array())
        .expect("Expected 'messages' array in post-tool request");

    // Collect all tool_result IDs.
    let mut result_ids: Vec<String> = Vec::new();
    for msg in messages {
        let Some(content) = msg.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                if let Some(id) = block.get("tool_use_id").and_then(|id| id.as_str()) {
                    result_ids.push(id.to_owned());
                }
            }
        }
    }

    assert_eq!(
        result_ids.len(),
        2,
        "Expected exactly 2 tool_result blocks in post-tool request, got {}. IDs: {:?}",
        result_ids.len(),
        result_ids
    );

    // IDs must be unique.
    let id0 = &result_ids[0];
    let id1 = &result_ids[1];
    assert_ne!(
        id0, id1,
        "tool_result IDs must be unique, but both are '{id0}'. \
         This indicates duplicate tool_use IDs were emitted."
    );

    // IDs must match the original tool_use IDs.
    assert!(
        result_ids.contains(&"toolu_multi_01".to_owned()),
        "Expected tool_result for 'toolu_multi_01', got: {result_ids:?}"
    );
    assert!(
        result_ids.contains(&"toolu_multi_02".to_owned()),
        "Expected tool_result for 'toolu_multi_02', got: {result_ids:?}"
    );

    // Verify no ToolCall/ToolResult server messages have duplicate tool IDs either.
    let tool_call_ids: Vec<String> = phase2
        .raw_messages
        .iter()
        .filter_map(|m| {
            if let ServerMessage::ToolCall(tc) = m {
                Some(tc.tool_id.clone())
            } else {
                None
            }
        })
        .collect();

    if tool_call_ids.len() >= 2 {
        let unique_count = {
            let mut deduped = tool_call_ids.clone();
            deduped.sort();
            deduped.dedup();
            deduped.len()
        };
        assert_eq!(
            unique_count,
            tool_call_ids.len(),
            "Duplicate tool_id values in ToolCall server messages: {tool_call_ids:?}"
        );
    }

    harness.shutdown().await;
}
