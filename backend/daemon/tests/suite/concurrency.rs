use std::time::Duration;

use serde_json::json;
use shore_protocol::client_msg::{Cancel, ClientMessage};
use shore_protocol::server_msg::ServerMessage;
use shore_test_harness::TestHarness;
use tokio::time::timeout;

use super::helpers::{collect_messages_for, is_request_scoped_message, wait_for_mock_requests};

/// Request-scoped stream responses should only reach the requesting session.
#[tokio::test]
async fn test_streaming_is_direct_to_requesting_client() {
    let mut harness = TestHarness::boot().await;
    let mut second = harness.connect_second_client().await;

    harness.mock_llm.enqueue_text("direct hello").await;

    let _ignored = harness
        .conn
        .send_message("Hi there", true)
        .await
        .expect("failed to send message");

    let (r1, second_msgs) = tokio::join!(
        harness.collect_stream(),
        collect_messages_for(&mut second, Duration::from_secs(1)),
    );

    r1.assert_text_contains("direct hello");
    assert!(r1.stream_ended);
    assert!(
        second_msgs
            .iter()
            .all(|msg| !is_request_scoped_message(msg)),
        "non-requesting client received request-scoped messages: {second_msgs:?}"
    );
    assert!(
        second_msgs.iter().all(|msg| matches!(
            msg,
            ServerMessage::History(_) | ServerMessage::NewMessage(_)
        )),
        "non-requesting client should only see event-style state updates: {second_msgs:?}"
    );

    harness.shutdown().await;
}

/// Command results should only reach the requesting session.
#[tokio::test]
async fn test_command_results_are_direct_to_requesting_client() {
    let mut harness = TestHarness::boot().await;
    let mut second = harness.connect_second_client().await;

    let first_msgs = harness.send_command("status").await;
    let second_msgs = collect_messages_for(&mut second, Duration::from_millis(300)).await;

    assert!(
        first_msgs.iter().any(
            |msg| matches!(msg, ServerMessage::CommandOutput(output) if output.name == "status")
        ),
        "requesting client did not receive status output: {first_msgs:?}"
    );
    assert!(
        second_msgs
            .iter()
            .all(|msg| !is_request_scoped_message(msg)),
        "non-requesting client received request-scoped command output: {second_msgs:?}"
    );

    harness.shutdown().await;
}

/// Sending a new message while the previous generation is in-flight should
/// abort the first generation and produce a response for the second.
#[tokio::test]
async fn test_new_message_during_generation_aborts_previous() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_hanging_optional().await;

    let _ignored = harness
        .conn
        .send_message("first message", true)
        .await
        .expect("failed to send first message");

    // Wait until the first upstream request has actually matched the hanging
    // mock before enqueueing the replacement response.
    wait_for_mock_requests(&harness, 1).await;

    harness.mock_llm.enqueue_text("second response").await;

    _ = harness
        .conn
        .send_message("second message", true)
        .await
        .expect("failed to send second message");

    let mut response = harness.collect_stream().await;
    if response.text.is_empty() && response.stream_ended {
        response = harness.collect_stream().await;
    }

    response.assert_text_contains("second response");
    assert!(response.stream_ended);

    harness.shutdown().await;
}

/// Dropping the SWP connection during an in-flight generation should not crash
/// the daemon. A new client should be able to connect and get responses.
#[tokio::test]
async fn test_client_disconnect_during_generation() {
    let mut harness = TestHarness::boot().await;

    let mut victim = harness.connect_second_client().await;

    harness.mock_llm.enqueue_hanging_optional().await;

    let _ignored = victim
        .send_message("start hanging", true)
        .await
        .expect("failed to send message");

    tokio::time::sleep(Duration::from_millis(300)).await;

    drop(victim);

    tokio::time::sleep(Duration::from_millis(500)).await;

    while let Ok(Ok(_)) = timeout(Duration::from_millis(500), harness.conn.recv()).await {}

    harness.mock_llm.enqueue_text("daemon is alive").await;

    let response = harness.send_and_collect("are you alive?").await;

    response.assert_text_contains("daemon is alive");
    assert!(response.stream_ended);

    harness.shutdown().await;
}

/// Tool traffic and streamed assistant output should only reach the requesting session.
#[tokio::test]
async fn test_tool_events_are_direct_to_requesting_client() {
    let mut harness = TestHarness::boot().await;
    let mut second = harness.connect_second_client().await;

    harness
        .mock_llm
        .enqueue_tool_use(
            "toolu_concurrent01",
            "roll_dice",
            json!({"notation": "2d6"}),
        )
        .await;
    harness
        .mock_llm
        .enqueue_text("Rolled for one client.")
        .await;

    let _ignored = harness
        .conn
        .send_message("Roll me some dice.", true)
        .await
        .expect("failed to send message");

    let (first_phases, second_msgs) = tokio::join!(
        async {
            let phase1 = harness.collect_stream().await;
            let phase2 = harness.collect_stream().await;
            (phase1, phase2)
        },
        collect_messages_for(&mut second, Duration::from_secs(1)),
    );

    let (phase1, phase2) = first_phases;
    assert!(phase1.stream_ended);
    assert!(phase2.stream_ended);
    phase2.assert_text_contains("Rolled for one client");
    assert!(
        phase2
            .raw_messages
            .iter()
            .any(|msg| matches!(msg, ServerMessage::ToolCall(_))),
        "requesting client missing ToolCall event: {:?}",
        phase2.raw_messages
    );
    assert!(
        phase2
            .raw_messages
            .iter()
            .any(|msg| matches!(msg, ServerMessage::ToolResult(_))),
        "requesting client missing ToolResult event: {:?}",
        phase2.raw_messages
    );
    assert!(
        second_msgs
            .iter()
            .all(|msg| !is_request_scoped_message(msg)),
        "non-requesting client received request-scoped tool traffic: {second_msgs:?}"
    );

    harness.shutdown().await;
}

/// Cancellation should only deliver the cancelled terminal message to the requesting session.
#[tokio::test]
async fn test_cancel_is_direct_to_requesting_client() {
    let mut harness = TestHarness::boot().await;
    let mut second = harness.connect_second_client().await;

    harness.mock_llm.enqueue_hanging_optional().await;

    let _ignored = harness
        .conn
        .send_message("please hang", true)
        .await
        .expect("failed to send hanging message");

    wait_for_mock_requests(&harness, 1).await;

    harness
        .conn
        .send(&ClientMessage::Cancel(Cancel {}))
        .await
        .expect("failed to send cancel");

    let (first_response, second_msgs) = tokio::join!(
        harness.collect_stream(),
        collect_messages_for(&mut second, Duration::from_millis(500)),
    );

    assert!(matches!(
        first_response.raw_messages.last(),
        Some(ServerMessage::StreamEnd(end)) if end.finish_reason == "cancelled"
    ));
    assert!(
        second_msgs
            .iter()
            .all(|msg| !is_request_scoped_message(msg)),
        "non-requesting client received cancel response: {second_msgs:?}"
    );

    harness.shutdown().await;
}
