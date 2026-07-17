use serde_json::json;
use shore_protocol::server_msg::ServerMessage;
use shore_test_harness::TestHarness;

#[tokio::test]
async fn test_basic_message_roundtrip() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("Hello from mock!").await;

    let response = harness.send_and_collect("Hi there").await;

    response.assert_text_contains("Hello from mock!");
    assert!(
        response.stream_ended,
        "Expected stream_ended to be true, but it was false"
    );

    harness.shutdown().await;
}

#[tokio::test]
async fn test_message_persistence() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("Persisted response").await;

    let _response = harness.send_and_collect("Save this message").await;

    // Give the daemon a moment to flush persistence.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let messages = harness.read_persisted_messages();

    assert!(
        messages.len() >= 2,
        "Expected at least 2 persisted messages (user + assistant), got {}",
        messages.len()
    );

    let has_user = messages
        .iter()
        .any(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));
    let has_assistant = messages
        .iter()
        .any(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"));

    assert!(has_user, "No user message found in persisted messages");
    assert!(
        has_assistant,
        "No assistant message found in persisted messages"
    );

    harness.shutdown().await;
}

#[tokio::test]
async fn test_streaming_chunks_arrive_in_order() {
    let mut harness = TestHarness::boot().await;

    harness
        .mock_llm
        .enqueue_text("Streaming works correctly")
        .await;

    let response = harness.send_and_collect("Test streaming").await;

    response.assert_text_contains("Streaming works correctly");
    assert!(
        response.stream_ended,
        "Expected stream to end after collecting all chunks"
    );
    assert!(
        !response.raw_messages.is_empty(),
        "Expected at least one raw message in the collected response"
    );

    harness.shutdown().await;
}

/// Verify the full tool execution roundtrip:
/// 1. Enqueue a tool_use response (LLM wants to call roll_dice).
/// 2. Enqueue a final text response (LLM's reply after seeing the tool result).
/// 3. Send a user message and collect both stream phases.
/// 4. Assert the mock received at least 2 requests (initial + post-tool).
/// 5. Assert the collected response contains the roll_dice tool call.
#[expect(
    clippy::indexing_slicing,
    reason = "indexes known-shape command-output JSON / Vec fixtures and panics on mismatch"
)]
#[tokio::test]
async fn test_tool_use_roundtrip() {
    let mut harness = TestHarness::boot().await;

    // Phase 1: LLM responds with a tool_use call.
    harness
        .mock_llm
        .enqueue_tool_use("toolu_test01", "roll_dice", json!({"notation": "2d6"}))
        .await;

    // Phase 2: LLM responds with final text after receiving the tool result.
    harness
        .mock_llm
        .enqueue_text("The dice have been rolled successfully.")
        .await;

    // Send the user message. The daemon will:
    //   call LLM → get tool_use → execute roll_dice → call LLM again → get text
    let _ignored = harness
        .conn
        .send_message("Roll me some dice right now.", true)
        .await
        .expect("failed to send message");

    // The stream consumer sends a StreamEnd after each LLM call, so there are two:
    //   Phase 1: StreamStart → StreamEnd  (tool_use event; no text chunks)
    //   Phase 2: ToolCall → ToolResult → StreamStart → chunks → StreamEnd  (final phase)
    //
    // ToolCall is emitted AFTER the first StreamEnd, so it lands in phase 2.
    // collect_stream stops at StreamEnd, so we call it twice.
    let first_phase = harness.collect_stream().await;

    // Immediately collect phase 2 — collect_stream has a 30s timeout, so no sleep needed.
    let second_phase = harness.collect_stream().await;

    // The second phase should carry the final text response.
    second_phase.assert_text_contains("dice have been rolled successfully");

    // Both phases must have ended their stream.
    assert!(
        first_phase.stream_ended,
        "Expected first phase to have stream_ended = true"
    );
    assert!(
        second_phase.stream_ended,
        "Expected second phase to have stream_ended = true"
    );

    // The mock must have received at least 2 sidecar stream requests:
    // one for the initial user message and one after tool execution.
    let requests = harness.mock_llm.received_requests().await;
    assert!(
        requests.len() >= 2,
        "Expected at least 2 LLM requests (initial + post-tool), got {}",
        requests.len()
    );

    // The second request's messages array should include the tool_result.
    let second_req = &requests[1];
    let messages = second_req.get("messages").and_then(|m| m.as_array());
    let has_tool_result = messages.is_some_and(|msgs| {
        msgs.iter().any(|m| {
            m.get("content")
                .and_then(|c| c.as_array())
                .is_some_and(|blocks| {
                    blocks
                        .iter()
                        .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                })
        })
    });
    assert!(
        has_tool_result,
        "Second LLM request should contain a tool_result block; messages: {messages:#?}"
    );

    // The second phase raw messages should include a ToolCall event.
    // (ToolCall is emitted AFTER the first StreamEnd, so it appears in phase 2.)
    let has_tool_call = second_phase
        .raw_messages
        .iter()
        .any(|m| matches!(m, ServerMessage::ToolCall(_)));
    assert!(
        has_tool_call,
        "Expected a ToolCall message in the second phase; got: {:?}",
        second_phase
            .raw_messages
            .iter()
            .map(std::mem::discriminant)
            .collect::<Vec<_>>()
    );

    harness.shutdown().await;
}

/// Verify that tool_use blocks are persisted to the JSONL conversation log.
///
/// After a roll_dice roundtrip the persisted JSONL file should contain either
/// "tool_use" (the assistant block type) or "roll_dice" (the tool name).
#[tokio::test]
async fn test_tool_result_persisted_in_jsonl() {
    let mut harness = TestHarness::boot().await;

    harness
        .mock_llm
        .enqueue_tool_use("toolu_persist01", "roll_dice", json!({"notation": "2d6"}))
        .await;
    harness.mock_llm.enqueue_text("Dice roll complete.").await;

    let _ignored = harness
        .conn
        .send_message("Roll the dice please.", true)
        .await
        .expect("failed to send message");

    // Drain both stream phases (no sleep needed; collect_stream waits up to 30s).
    let _first = harness.collect_stream().await;
    let _second = harness.collect_stream().await;

    // Give the daemon time to flush persistence.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let messages = harness.read_persisted_messages();

    assert!(
        !messages.is_empty(),
        "Expected persisted messages but found none"
    );

    // The JSONL must contain either a "tool_use" type block or the "roll_dice" name.
    let raw_jsonl: String = messages
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        raw_jsonl.contains("tool_use") || raw_jsonl.contains("roll_dice"),
        "Expected JSONL to contain 'tool_use' or 'roll_dice', but got:\n{raw_jsonl}"
    );

    harness.shutdown().await;
}

/// Verify that the daemon sends a "tools" array to the LLM provider when tool_use is enabled.
///
/// The default TestHarness config has tool_use enabled, so the first POST to the mock
/// should include a non-empty "tools" array alongside "messages" and a "system" field.
#[expect(
    clippy::indexing_slicing,
    reason = "indexes known-shape command-output JSON / Vec fixtures and panics on mismatch"
)]
#[tokio::test]
async fn test_request_body_includes_tools() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("Tools are present.").await;

    let _response = harness.send_and_collect("Check if tools are sent").await;

    let requests = harness.mock_llm.received_requests().await;
    assert!(
        !requests.is_empty(),
        "Expected at least one LLM request, got none"
    );

    let body = &requests[0];

    // "tools" must be present and non-empty.
    let tools = body
        .get("tools")
        .and_then(|t| t.as_array())
        .expect("Expected 'tools' array in request body");
    assert!(
        !tools.is_empty(),
        "Expected non-empty 'tools' array, but it was empty"
    );

    // "messages" must be present.
    let messages = body
        .get("messages")
        .and_then(|m| m.as_array())
        .expect("Expected 'messages' array in request body");
    assert!(
        !messages.is_empty(),
        "Expected non-empty 'messages' array, but it was empty"
    );

    // "system" field must be present (may be a string or array of blocks).
    assert!(
        body.get("system").is_some(),
        "Expected 'system' field in request body, but it was absent; body keys: {:?}",
        body.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );

    harness.shutdown().await;
}

/// Verify that the user's message text is forwarded verbatim in the LLM request body.
///
/// The "messages" array in the POST body must contain at least one entry whose content
/// includes the exact string "Hello test message".
#[expect(
    clippy::indexing_slicing,
    reason = "indexes known-shape command-output JSON / Vec fixtures and panics on mismatch"
)]
#[tokio::test]
async fn test_request_body_contains_user_message() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("Message received.").await;

    let _response = harness.send_and_collect("Hello test message").await;

    let requests = harness.mock_llm.received_requests().await;
    assert!(
        !requests.is_empty(),
        "Expected at least one LLM request, got none"
    );

    let body = &requests[0];
    let messages = body
        .get("messages")
        .and_then(|m| m.as_array())
        .expect("Expected 'messages' array in request body");

    // Walk every message and every content block looking for the user text.
    let found = messages.iter().any(|msg| {
        // Content may be a plain string or an array of blocks.
        if let Some(content_str) = msg.get("content").and_then(|c| c.as_str()) {
            return content_str.contains("Hello test message");
        }
        if let Some(content_arr) = msg.get("content").and_then(|c| c.as_array()) {
            return content_arr.iter().any(|block| {
                block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .is_some_and(|t| t.contains("Hello test message"))
            });
        }
        false
    });

    assert!(
        found,
        "Expected 'Hello test message' in the LLM request messages, but did not find it.\nMessages: {messages:#?}"
    );

    harness.shutdown().await;
}
