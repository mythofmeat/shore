use std::time::Duration;

use serde_json::json;
use shore_protocol::client_msg::{Cancel, ClientMessage};
use shore_protocol::server_msg::ServerMessage;
use shore_test_harness::TestHarness;

use super::helpers::{collect_messages_for, is_request_scoped_message, wait_for_mock_requests};

#[tokio::test]
async fn streaming_is_direct_to_requesting_client() {
    let mut harness = TestHarness::boot().await;
    let mut second = harness.connect_second_client().await;

    harness.mock_llm.enqueue_text("direct hello").await;

    let _ignored = harness
        .conn
        .send_message("Hi there", true)
        .await
        .expect("failed to send message");

    let (first_response, second_msgs) = tokio::join!(
        harness.collect_stream(),
        collect_messages_for(&mut second, Duration::from_secs(1)),
    );

    first_response.assert_text_contains("direct hello");
    assert!(first_response.stream_ended);
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

#[tokio::test]
async fn command_results_are_direct_to_requesting_client() {
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

#[tokio::test]
async fn tool_events_are_direct_to_requesting_client() {
    let mut harness = TestHarness::boot().await;
    let mut second = harness.connect_second_client().await;

    harness
        .mock_llm
        .enqueue_tool_use("toolu_guardrail01", "roll_dice", json!({"notation": "2d6"}))
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

#[tokio::test]
async fn cancel_is_direct_to_requesting_client() {
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
