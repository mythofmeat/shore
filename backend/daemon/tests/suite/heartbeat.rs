//! Integration tests for organic heartbeat semantics.
//!
//! A heartbeat is a bounded private tool loop. The runtime may deliver
//! `<sendMessage>` and intercept `set_next_wake`, but it must not force recap
//! generation or write daily memory notes by itself.

use std::time::Duration;

use crate::helpers::{wait_for_file_contents, wait_for_heartbeat_detail, wait_for_mock_requests};
use serde_json::json;
use shore_test_harness::{TestConfigBuilder, TestHarness};

const CHARACTER: &str = "TestChar";

fn init_tracing() {
    let _ignored = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("off")),
        )
        .with_test_writer()
        .try_init();
}

async fn primed_harness(max_tool_rounds: u32) -> TestHarness {
    let mut harness = TestHarness::boot_with(
        TestConfigBuilder::new()
            .autonomy(true)
            .heartbeat_max_tool_rounds(max_tool_rounds),
    )
    .await;
    harness.mock_llm.enqueue_text("ack").await;
    let _ignored = harness.send_and_collect("hello").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    harness
}

async fn fire_tick(harness: &TestHarness) {
    let dormant = harness.autonomy.heartbeat_tick_now(CHARACTER);
    assert_eq!(
        dormant,
        Some(false),
        "first heartbeat tick should report the character as not dormant"
    );
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(15)).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::resume();
}

#[tokio::test]
async fn heartbeat_ok_is_one_call_and_writes_no_memory_file() {
    init_tracing();
    let harness = primed_harness(12).await;
    let before = harness.mock_llm.received_requests().await.len();

    harness.mock_llm.enqueue_json_text("HEARTBEAT_OK").await;
    fire_tick(&harness).await;

    // The tick's LLM call is recorded by the mock asynchronously; wait for it
    // to register before asserting the exact count.
    wait_for_mock_requests(&harness, before + 1).await;
    let requests = harness.mock_llm.received_requests().await;
    assert_eq!(
        requests.len() - before,
        1,
        "a no-tool heartbeat should make exactly one LLM call"
    );
    let memory_dir = shore_config::character_memory_dir(&harness.config.dirs.config, CHARACTER);
    assert!(
        !memory_dir.join("daily").exists(),
        "heartbeat must not create daily notes automatically"
    );
    let active = std::fs::read_to_string(harness.data_dir.join(CHARACTER).join("active.jsonl"))
        .unwrap_or_default();
    assert!(
        !active.contains("HEARTBEAT_OK"),
        "HEARTBEAT_OK is an ack/drop signal, not a user-visible message"
    );

    harness.shutdown().await;
}

/// A heartbeat tick records a curated transcript row in the observability
/// store, tagged `source = heartbeat`, so `shore log --heartbeat` has data.
#[tokio::test]
async fn heartbeat_tick_records_transcript_row() {
    use shore_call_store::CallStore;

    init_tracing();
    let mut harness = TestHarness::boot_with(
        TestConfigBuilder::new()
            .autonomy(true)
            .heartbeat_max_tool_rounds(12)
            .api_payload_logging(true),
    )
    .await;
    harness.mock_llm.enqueue_text("ack").await;
    let _ignored = harness.send_and_collect("hello").await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    harness.mock_llm.enqueue_json_text("HEARTBEAT_OK").await;
    fire_tick(&harness).await;

    let store = CallStore::open(&harness.config.dirs.cache.join("calls.db"))
        .expect("call store DB must exist once capture is on");
    let mut rows = Vec::new();
    for _ in 0..100 {
        rows = store
            .query_transcripts("heartbeat", Some(CHARACTER), 0)
            .expect("query heartbeat transcripts");
        if !rows.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !rows.is_empty(),
        "a heartbeat tick must record at least one heartbeat transcript row"
    );
    let row = rows.first().expect("row present");
    assert_eq!(
        row.source, "heartbeat",
        "row tagged with the heartbeat source"
    );
    assert!(
        row.entry.get("tool_calls").is_some(),
        "curated entry carries a tool_calls field: {}",
        row.entry
    );

    harness.shutdown().await;
}

#[tokio::test]
async fn send_message_is_delivered_without_recap() {
    init_tracing();
    let harness = primed_harness(12).await;
    let body = "I found the thread again.";

    harness
        .mock_llm
        .enqueue_json_text(&format!("<sendMessage>{body}</sendMessage>"))
        .await;
    fire_tick(&harness).await;

    // Wait for the sendMessage body to land in active.jsonl rather than reading
    // immediately — the tick spawns the persistence write, which lags the tick
    // return on a loaded runner.
    let active_path = harness.data_dir.join(CHARACTER).join("active.jsonl");
    let _ignored = wait_for_file_contents(&active_path, body).await;
    let memory_dir = shore_config::character_memory_dir(&harness.config.dirs.config, CHARACTER);
    assert!(
        !memory_dir.join("daily").exists(),
        "sendMessage should not require or create a recap note"
    );

    harness.shutdown().await;
}

#[tokio::test]
async fn set_next_wake_still_schedules_from_tool_use() {
    init_tracing();
    let harness = primed_harness(1).await;

    harness
        .mock_llm
        .enqueue_json_tool_use(
            "tu_wake_01",
            "set_next_wake",
            json!({ "hours_from_now": 2.0, "reason": "pick this up later" }),
        )
        .await;
    fire_tick(&harness).await;

    let _ignored = wait_for_heartbeat_detail(&harness, CHARACTER, "set_next_wake: 2.0h").await;

    harness.shutdown().await;
}

/// A tick run flushes the heartbeat log to disk so events survive an
/// ungraceful crash. The tick loop calls `flush_if_dirty` alongside
/// `save_state`, so by the time the tick returns the file should exist
/// and contain the recorded events.
#[tokio::test]
async fn heartbeat_log_persists_to_disk_after_tick() {
    init_tracing();
    let harness = primed_harness(12).await;

    harness.mock_llm.enqueue_json_text("HEARTBEAT_OK").await;
    fire_tick(&harness).await;

    let log_path = harness.data_dir.join(CHARACTER).join("heartbeat.jsonl");
    assert!(
        log_path.exists(),
        "heartbeat.jsonl should exist after a tick fires"
    );
    let contents = wait_for_file_contents(&log_path, "tick_fired").await;
    assert!(
        contents.contains("tick_fired"),
        "disk log should record tick_fired event, got: {contents}"
    );
    assert!(
        contents.contains("message_skipped"),
        "disk log should record HEARTBEAT_OK as message_skipped, got: {contents}"
    );

    harness.shutdown().await;
}

/// Heartbeat events recorded before a crash are restored on reboot.
/// `ensure_state` calls `HeartbeatLog::load_from` which seeds the in-memory
/// ring from disk, so post-reboot `heartbeat_log()` includes pre-crash events.
#[tokio::test]
async fn heartbeat_log_survives_crash_and_reboot() {
    init_tracing();
    let crashed = {
        let harness = primed_harness(12).await;

        harness
            .mock_llm
            .enqueue_json_text("<sendMessage>before crash</sendMessage>")
            .await;
        fire_tick(&harness).await;

        // Sanity-check the pre-crash log shape so the post-reboot assertion is
        // meaningful — without these the test would silently pass if the tick
        // produced no events at all.
        let _ignored = wait_for_heartbeat_detail(&harness, CHARACTER, "before crash").await;
        let log_path = harness.data_dir.join(CHARACTER).join("heartbeat.jsonl");
        _ = wait_for_file_contents(&log_path, "before crash").await;

        harness.crash().await
    };
    let mut harness = crashed.reboot().await;

    // ensure_state runs lazily on first character access. Sending a message
    // primes it the same way the original boot sequence did.
    harness.mock_llm.enqueue_text("ack").await;
    _ = harness.send_and_collect("hello again").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let events = wait_for_heartbeat_detail(&harness, CHARACTER, "before crash").await;
    let recovered = events
        .iter()
        .filter(|e| e.detail.contains("before crash"))
        .count();
    assert_eq!(
        recovered, 1,
        "the pre-crash sendMessage event should be loaded from disk on reboot, \
         got events: {events:?}"
    );

    harness.shutdown().await;
}
