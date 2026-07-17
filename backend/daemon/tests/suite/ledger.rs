use serde_json::json;
use shore_test_harness::TestHarness;

/// After a successful LLM call the ledger DB must contain at least one entry
/// with non-zero token counts.
#[expect(
    clippy::indexing_slicing,
    reason = "indexes known-shape command-output JSON / Vec fixtures and panics on mismatch"
)]
#[tokio::test]
async fn test_successful_call_recorded_in_ledger() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("Ledger test response").await;
    let response = harness.send_and_collect("Hello ledger").await;
    response.assert_text_contains("Ledger test response");

    // Give the daemon a moment to flush the ledger write.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let entries = harness.read_ledger_entries();
    assert!(
        !entries.is_empty(),
        "Expected at least 1 ledger entry after a successful LLM call, got 0"
    );

    let entry = &entries[0];
    let input_tokens = entry
        .get("input_tokens")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let output_tokens = entry
        .get("output_tokens")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);

    assert!(
        input_tokens > 0 || output_tokens > 0,
        "Expected non-zero token counts in ledger entry, got input={input_tokens} output={output_tokens}"
    );

    harness.shutdown().await;
}

/// After a 500 error followed by a successful retry, the ledger must contain
/// at least one entry (the successful retry call).
///
/// Note: the ledger only records successful calls — failed HTTP requests are
/// not written to the DB. The retry is expected to produce one entry.
#[tokio::test]
async fn test_failed_call_recorded_in_ledger() {
    let mut harness = TestHarness::boot().await;

    // Enqueue a 500 error first — the daemon will retry.
    harness
        .mock_llm
        .enqueue_error(
            500,
            r#"{"error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        )
        .await;
    // Enqueue the successful response the retry will consume.
    harness.mock_llm.enqueue_text("Retry succeeded").await;

    let response = harness.send_and_collect("Trigger retry").await;
    response.assert_text_contains("Retry succeeded");

    // Give the daemon time to flush the ledger write.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let entries = harness.read_ledger_entries();
    assert!(
        !entries.is_empty(),
        "Expected at least 1 ledger entry after a retried call succeeded, got 0"
    );

    harness.shutdown().await;
}

/// A tool-use roundtrip causes two LLM calls. Both must be recorded in the ledger.
#[tokio::test]
async fn test_tool_loop_records_multiple_calls() {
    let mut harness = TestHarness::boot().await;

    // Phase 1: LLM returns a tool_use block.
    harness
        .mock_llm
        .enqueue_tool_use("toolu_ledger01", "roll_dice", json!({"notation": "2d6"}))
        .await;

    // Phase 2: LLM returns the final text after seeing the tool result.
    harness
        .mock_llm
        .enqueue_text("Rolled and ledger updated.")
        .await;

    let _ignored = harness
        .conn
        .send_message("Roll me some dice.", true)
        .await
        .expect("failed to send message");

    // Two stream phases: one for the tool_use response, one for the final reply.
    let _first = harness.collect_stream().await;
    let second = harness.collect_stream().await;
    second.assert_text_contains("Rolled and ledger updated");

    // Give the daemon time to flush both ledger writes.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let entries = harness.read_ledger_entries();
    assert!(
        entries.len() >= 2,
        "Expected at least 2 ledger entries for a tool-loop (one per LLM call), got {}",
        entries.len()
    );

    harness.shutdown().await;
}
