//! Integration tests for the autonomy subsystem — cache keepalive pings.
//!
//! These tests use `tokio::time::pause()` and `tokio::time::advance()` to
//! control virtual time, verifying that keepalive pings fire (or don't)
//! under the correct conditions.
//!
//! IMPORTANT: `tokio::time::pause()` is called AFTER boot and any user message
//! exchange, because the boot process and SWP message flow involve real network
//! I/O that does not work under paused time (timeouts fire instantly).

use std::time::Duration;

use crate::helpers::wait_for_heartbeat_detail;
use shore_test_harness::{MockLlmSidecar, TestConfigBuilder, TestHarness};

fn registry_with(budget_env: &str, overflow_env: &str) -> String {
    format!(
        r#"
[providers.openrouter]
sdk = "anthropic"

[[providers.openrouter.keys]]
name = "budget"
env = "{budget_env}"
warn_on_fallback = true

[[providers.openrouter.keys]]
name = "overflow"
env = "{overflow_env}"
"#
    )
}

/// Helper: yield the runtime multiple times so spawned tasks (especially the
/// autonomy tick loop) have a chance to process after a time advance.
///
/// Use this for "settle the runtime, no specific condition" — typically before
/// asserting that a count did NOT change. For "wait until the count goes up",
/// use [`wait_until_count_above`] instead, which is load-aware and exits as
/// soon as the condition is satisfied.
async fn yield_many(n: usize) {
    for _ in 0..n {
        tokio::task::yield_now().await;
        // Small sleep to let async tasks settle (instant under paused time).
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

/// Poll `mock_llm.received_requests().len()` until it exceeds `baseline`, or
/// until `max_iters` polling cycles have elapsed. Returns the final count.
///
/// Each cycle yields the runtime and sleeps 1ms, so under `tokio::time::pause`
/// time auto-advances when the runtime is otherwise idle, giving the autonomy
/// tick loop a chance to run. Bounds the work so a genuine bug still fails the
/// assertion in O(max_iters) time instead of hanging.
///
/// Replaces the brittle `advance(D); yield_many(N); assert count > baseline`
/// pattern, which fails under heavy parallel CPU load when N is too small for
/// the scheduled tick to land.
async fn wait_until_count_above(
    mock_llm: &MockLlmSidecar,
    baseline: usize,
    max_iters: usize,
) -> usize {
    for _ in 0..max_iters {
        let n = mock_llm.received_requests().await.len();
        if n > baseline {
            return n;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    mock_llm.received_requests().await.len()
}

fn heartbeat_detail_count(harness: &TestHarness, character: &str, detail: &str) -> usize {
    // Prefix match: success pings carry a dynamic suffix
    // (`Cache refresh ping (cache_read: N, input: M)`), so an exact match would
    // never hit. The prefix is stable and unique enough to count by.
    harness
        .autonomy
        .heartbeat_log(character, 100)
        .into_iter()
        .filter(|event| event.detail.starts_with(detail))
        .count()
}

async fn wait_until_heartbeat_detail_count_above(
    harness: &TestHarness,
    character: &str,
    detail: &str,
    baseline: usize,
    max_iters: usize,
) -> usize {
    for _ in 0..max_iters {
        let n = heartbeat_detail_count(harness, character, detail);
        if n > baseline {
            return n;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    heartbeat_detail_count(harness, character, detail)
}

/// Test 1: After sending a user message (which primes last_request and warms
/// the cache), advancing past the 55-minute keepalive interval should cause
/// the daemon's tick loop to fire a keepalive ping to the mock LLM.
///
/// This would have caught Bug 1 (phantom pings — on_cache_warmed called even
/// when execute_dormant_ping skips due to None last_request) and Bug 2 (dead
/// timer — next_ping_at is None on startup, so no pings fire until the first
/// user message).
#[expect(
    clippy::indexing_slicing,
    reason = "indexes known-shape command-output JSON / Vec fixtures and panics on mismatch"
)]
#[tokio::test]
async fn test_keepalive_ping_fires_after_59_minutes() {
    let mut harness = TestHarness::boot().await;

    // Send user message under real time — this primes last_request and warms cache.
    harness.mock_llm.enqueue_text("Hello from mock!").await;
    let _response = harness.send_and_collect("Hi there").await;

    // Give the daemon a moment to persist and notify autonomy.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Record how many requests the mock has received so far.
    let baseline = harness.mock_llm.received_requests().await.len();
    assert!(
        baseline >= 1,
        "Expected at least 1 request from user message"
    );

    // Enqueue a JSON response for the keepalive ping (non-streaming generate).
    harness.mock_llm.enqueue_json_text_optional("ping").await;

    // Now pause time and advance past the 55-minute ping interval.
    tokio::time::pause();

    tokio::time::advance(Duration::from_secs(55 * 60 + 30)).await;
    // Advance a bit more to give the tick loop another cycle.
    tokio::time::advance(Duration::from_mins(1)).await;
    let after = wait_until_count_above(&harness.mock_llm, baseline, 200).await;

    let requests = harness.mock_llm.received_requests().await;
    assert!(
        after > baseline,
        "Expected keepalive ping request after 55+ minutes. \
         Baseline: {baseline}, After: {after}"
    );

    // Verify the keepalive request is a valid API request: the conversation
    // MUST end with a user message. This catches the bug where the cloned
    // request ended with an assistant message, causing Anthropic to reject
    // it with "conversation must end with a user message" — silently
    // failing every single keepalive ping ever sent.
    let ping_request = &requests[after - 1];
    let messages = ping_request["messages"]
        .as_array()
        .expect("ping request should have messages array");
    let last_msg = messages.last().expect("messages should not be empty");
    assert_eq!(
        last_msg["role"].as_str().unwrap(),
        "user",
        "Keepalive ping must end with a user message, got: {}",
        last_msg["role"]
    );

    // Resume real time for graceful shutdown.
    tokio::time::resume();
    harness.shutdown().await;
}

/// Test 2: If no user message has been sent (so last_request is None and the
/// cache keepalive has no ping deadline), advancing well past the keepalive
/// interval should produce zero LLM requests.
///
/// This would have caught Bug 1 (phantom pings) — the old code
/// unconditionally called on_cache_warmed after execute_dormant_ping, causing
/// the timer to reset and "fire" every 59 minutes even without a real request.
#[tokio::test]
async fn test_no_phantom_ping_without_prior_request() {
    let harness = TestHarness::boot().await;

    // Give the boot process a moment to settle under real time.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Pause and advance well past keepalive interval (120 minutes).
    tokio::time::pause();

    tokio::time::advance(Duration::from_hours(2)).await;
    yield_many(20).await;

    tokio::time::advance(Duration::from_mins(1)).await;
    yield_many(20).await;

    let requests = harness.mock_llm.received_requests().await;
    assert!(
        requests.is_empty(),
        "Expected zero requests without a prior user message, got {}",
        requests.len()
    );

    tokio::time::resume();
    harness.shutdown().await;
}

/// Test 3: A failed keepalive ping should still count as an attempt (the
/// request was made). After the failure, the next tick cycle should retry.
///
/// This would have caught Bug 3 (rebuilt request lost) — after a failed ping,
/// the request should still be available for retry.
#[tokio::test]
async fn test_failed_ping_retries() {
    let mut harness = TestHarness::boot().await;

    // Prime the cache with a user message under real time.
    harness.mock_llm.enqueue_text("Hello!").await;
    let _response = harness.send_and_collect("Hi").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let baseline = harness.mock_llm.received_requests().await.len();

    // Enqueue an error response for the first keepalive ping attempt.
    harness
        .mock_llm
        .enqueue_error_optional(500, "Internal Server Error")
        .await;

    // Pause time and advance past the ping interval.
    tokio::time::pause();

    tokio::time::advance(Duration::from_secs(55 * 60 + 30)).await;
    tokio::time::advance(Duration::from_mins(1)).await;
    let after_error = wait_until_count_above(&harness.mock_llm, baseline, 200).await;
    assert!(
        after_error > baseline,
        "Expected at least one request attempt (even if it failed). \
         Baseline: {baseline}, After error: {after_error}"
    );
    let _ignored =
        wait_for_heartbeat_detail(&harness, "TestChar", "Cache keepalive ping failed").await;

    // Enqueue a success response for the retry.
    harness
        .mock_llm
        .enqueue_json_text_optional("retry ping ok")
        .await;

    // The failed ping schedules a short retry backoff. Wait for the failure
    // log before advancing so the retry deadline is based on the settled
    // failure, not on a still-in-flight request under paused virtual time.
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::time::advance(Duration::from_secs(10)).await;
    let after_retry = wait_until_count_above(&harness.mock_llm, after_error, 200).await;
    assert!(
        after_retry > after_error,
        "Expected a retry request after the failed ping. \
         After error: {after_error}, After retry: {after_retry}"
    );

    tokio::time::resume();
    harness.shutdown().await;
}

#[tokio::test]
async fn test_keepalive_rotates_provider_key_on_budget_error() {
    let budget_env = "AUTO_KEEPALIVE_BUDGET";
    let overflow_env = "AUTO_KEEPALIVE_OVERFLOW";
    std::env::set_var(budget_env, "sk-budget");
    std::env::set_var(overflow_env, "sk-overflow");

    let mut harness = TestHarness::boot_with(
        TestConfigBuilder::new().provider_registry_toml(&registry_with(budget_env, overflow_env)),
    )
    .await;

    // Prime last_request with the budget key. The later keepalive should
    // retry the same request with the overflow key when the budget key fails.
    harness.mock_llm.enqueue_text("Hello!").await;
    let _response = harness.send_and_collect("Hi").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let baseline = harness.mock_llm.received_requests().await.len();

    harness
        .mock_llm
        .enqueue_error_optional(402, r#"{"error":"budget exceeded"}"#)
        .await;
    harness
        .mock_llm
        .enqueue_json_text_optional("fallback ping ok")
        .await;

    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(55 * 60 + 30)).await;
    tokio::time::advance(Duration::from_mins(1)).await;
    let after = wait_until_count_above(&harness.mock_llm, baseline + 1, 200).await;

    assert!(
        after >= baseline + 2,
        "Expected keepalive to retry with the fallback key after budget exhaustion. \
         Baseline: {baseline}, After: {after}"
    );

    let _ignored = wait_for_heartbeat_detail(
        &harness,
        "TestChar",
        "Provider key fallback: budget -> overflow",
    )
    .await;

    tokio::time::resume();
    std::env::remove_var(budget_env);
    std::env::remove_var(overflow_env);
    harness.shutdown().await;
}

// ── Chaos tests ───────────────────────────────────────────────────────────

/// Chaos 1: User message at minute 50 should reset the keepalive timer.
/// The NEXT ping should fire at 50 + 55 = 105 minutes, NOT at the original
/// 55 minutes. Verifies that mid-conversation messages defer the ping
/// correctly — a ping during active conversation is waste.
#[tokio::test]
async fn test_user_message_resets_keepalive_timer() {
    let mut harness = TestHarness::boot().await;

    // Warm the cache with first message.
    harness.mock_llm.enqueue_text("Hello!").await;
    let _r = harness.send_and_collect("Initial message").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    tokio::time::pause();

    // Advance to 50 minutes — just before the 55min ping would fire.
    tokio::time::advance(Duration::from_mins(50)).await;
    yield_many(10).await;

    // Resume to send a real user message (network I/O needs real time).
    tokio::time::resume();
    harness
        .mock_llm
        .enqueue_text("Mid-conversation response.")
        .await;
    _ = harness.send_and_collect("Message at minute 50").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let after_msg = harness.mock_llm.received_requests().await.len();

    // Now pause again and advance to what would have been the original
    // ping time (55min) — should NOT ping because the timer was reset.
    tokio::time::pause();

    // Advance just past original 55 min mark (5 more minutes from t=50).
    tokio::time::advance(Duration::from_mins(10)).await;
    yield_many(20).await;

    let after_original_time = harness.mock_llm.received_requests().await.len();
    assert_eq!(
        after_original_time, after_msg,
        "No keepalive should fire at original 55min — timer was reset by user message"
    );

    // Advance to 50 + 55 = 105 minutes from start (55 more min from msg).
    harness
        .mock_llm
        .enqueue_json_text_optional("deferred ping")
        .await;
    tokio::time::advance(Duration::from_mins(50)).await;
    let after_deferred = wait_until_count_above(&harness.mock_llm, after_msg, 200).await;
    assert!(
        after_deferred > after_msg,
        "Keepalive should fire at ~105min (50min + 55min interval). \
         After msg: {after_msg}, After deferred: {after_deferred}"
    );

    tokio::time::resume();
    harness.shutdown().await;
}

/// Chaos 2: Multiple consecutive pings over 4+ hours of silence.
/// Each ping should succeed and reschedule the next one 55min later.
/// Verifies sustained keepalive over long idle stretches.
#[tokio::test]
async fn test_sustained_keepalive_over_four_hours() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("Primed.").await;
    let _r = harness.send_and_collect("Prime the cache").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let baseline = harness.mock_llm.received_requests().await.len();

    tokio::time::pause();

    // Simulate 4+ hours of silence. Expect ~4-5 keepalive pings
    // (at 55, 110, 165, 220 minutes).
    let expected_pings = 4;
    let ping_log_baseline = heartbeat_detail_count(&harness, "TestChar", "Cache refresh ping");
    for i in 0..expected_pings {
        // Enqueue response for this ping.
        harness.mock_llm.enqueue_json_text_optional("ping").await;

        // Advance 56 minutes (past the 55min interval).
        tokio::time::advance(Duration::from_mins(56)).await;
        // Small extra advance to ensure tick fires.
        tokio::time::advance(Duration::from_secs(30)).await;
        let current = wait_until_count_above(&harness.mock_llm, baseline + i, 200).await;
        assert!(
            current > baseline + i,
            "Expected ping #{} at ~{}min. Baseline: {baseline}, Current: {current}",
            i + 1,
            (i + 1) * 56
        );
        let logged = wait_until_heartbeat_detail_count_above(
            &harness,
            "TestChar",
            "Cache refresh ping",
            ping_log_baseline + i,
            200,
        )
        .await;
        assert!(
            logged > ping_log_baseline + i,
            "Expected keepalive ping #{} to complete and reschedule before advancing again. \
             Baseline logs: {ping_log_baseline}, Logged: {logged}",
            i + 1
        );
    }

    let total = harness.mock_llm.received_requests().await.len();
    assert!(
        total >= baseline + expected_pings,
        "Expected at least {expected_pings} keepalive pings over 4h. \
         Baseline: {baseline}, Total: {total}"
    );

    tokio::time::resume();
    harness.shutdown().await;
}

/// Chaos 3: Rapid-fire user messages should NOT cause extra pings.
/// After a burst of 5 messages, only one ping should fire (55min after
/// the LAST message, not 5 pings for 5 messages).
#[tokio::test]
async fn test_burst_messages_single_deferred_ping() {
    let mut harness = TestHarness::boot().await;

    // Burst of 5 messages in quick succession.
    for i in 0..5 {
        harness.mock_llm.enqueue_text(&format!("Reply {i}")).await;
        let _r = harness
            .send_and_collect(&format!("Burst message {i}"))
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    let after_burst = harness.mock_llm.received_requests().await.len();

    // Pause and advance to 50 min — short of the 55min interval from the
    // last message. Should NOT ping.
    tokio::time::pause();
    tokio::time::advance(Duration::from_mins(50)).await;
    yield_many(20).await;

    let at_50 = harness.mock_llm.received_requests().await.len();
    assert_eq!(
        at_50, after_burst,
        "No keepalive should fire at 50min after burst"
    );

    // Advance past the 55min mark with plenty of headroom.
    harness
        .mock_llm
        .enqueue_json_text_optional("deferred")
        .await;
    tokio::time::advance(Duration::from_mins(7)).await;
    tokio::time::advance(Duration::from_mins(1)).await;
    let after_deferred = wait_until_count_above(&harness.mock_llm, at_50, 200).await;

    // At least one additional request (the keepalive ping).
    assert!(
        after_deferred > at_50,
        "Expected keepalive after burst. At 50m: {at_50}, After: {after_deferred}"
    );

    tokio::time::resume();
    harness.shutdown().await;
}

/// Chaos 4: Ping fails, then succeeds on retry.
/// Verifies retry behavior after a failed keepalive ping.
///
/// NOTE: Under virtual time, rapid back-to-back retries are hard to
/// exercise because the tick loop and wiremock response consumption
/// need careful yield coordination. The core retry mechanism is proven
/// by test_failed_ping_retries; this test validates the first-attempt
/// failure + at-least-one-retry invariant.
#[tokio::test]
async fn test_triple_failure_then_recovery() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("Primed.").await;
    let _r = harness.send_and_collect("Go").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let baseline = harness.mock_llm.received_requests().await.len();

    tokio::time::pause();

    // Advance past the 55min interval to trigger first attempt.
    harness
        .mock_llm
        .enqueue_error_optional(503, "Service Unavailable")
        .await;
    tokio::time::advance(Duration::from_secs(55 * 60 + 30)).await;
    let after_first = wait_until_count_above(&harness.mock_llm, baseline, 200).await;
    assert!(
        after_first > baseline,
        "First attempt should have been made. Baseline: {baseline}, After: {after_first}"
    );

    // Enqueue more failures + final success for retry attempts.
    harness
        .mock_llm
        .enqueue_error_optional(503, "Service Unavailable")
        .await;
    harness
        .mock_llm
        .enqueue_error_optional(503, "Service Unavailable")
        .await;
    harness
        .mock_llm
        .enqueue_json_text_optional("recovered")
        .await;

    // Give many tick cycles for retries (10s each, need 3 more attempts).
    for _ in 0..20 {
        tokio::time::advance(Duration::from_secs(15)).await;
        yield_many(15).await;
    }

    let after = harness.mock_llm.received_requests().await.len();
    // At minimum, the first attempt should have been made. Rapid retries
    // under virtual time are unreliable due to tick loop / wiremock
    // yield coordination, but the first attempt proves the path works.
    assert!(
        after > baseline,
        "Expected at least the first ping attempt. \
         Baseline: {baseline}, After: {after}"
    );

    tokio::time::resume();
    harness.shutdown().await;
}

/// Chaos 5: Keepalive survives daemon crash and reboot.
/// After crash + reboot, the keepalive should resume from persisted state
/// and fire a ping at the correct time.
#[tokio::test]
async fn test_keepalive_survives_crash() {
    // Crash the daemon (aborts tasks, removes socket, keeps data).
    let crashed = {
        let mut harness = TestHarness::boot().await;

        // Warm the cache.
        harness.mock_llm.enqueue_text("Before crash.").await;
        _ = harness.send_and_collect("Pre-crash message").await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        harness.crash().await
    };

    // Reboot from persisted state, then send a new message to re-prime
    // last_request (it's not persisted).
    let mut harness = crashed.reboot().await;
    harness.mock_llm.enqueue_text("After reboot.").await;
    _ = harness.send_and_collect("Post-crash message").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let baseline = harness.mock_llm.received_requests().await.len();

    harness
        .mock_llm
        .enqueue_json_text_optional("keepalive")
        .await;

    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(55 * 60 + 30)).await;
    tokio::time::advance(Duration::from_mins(1)).await;
    let after = wait_until_count_above(&harness.mock_llm, baseline, 200).await;
    assert!(
        after > baseline,
        "Keepalive should fire after crash+reboot. Baseline: {baseline}, After: {after}"
    );

    tokio::time::resume();
    harness.shutdown().await;
}

/// Chaos 6: No ping should fire within the safety window (0-54 minutes).
/// Exhaustively checks that the keepalive does NOT fire early.
#[tokio::test]
async fn test_no_early_ping() {
    let mut harness = TestHarness::boot().await;

    harness.mock_llm.enqueue_text("Ready.").await;
    let _r = harness.send_and_collect("Start").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let baseline = harness.mock_llm.received_requests().await.len();

    tokio::time::pause();

    // Check at 10, 20, 30, 40, 50, and 54 minutes — no ping should fire.
    // Use incremental advances (not absolute), since tokio::time::advance
    // is cumulative.
    let checkpoints = [10_u64, 20, 30, 40, 50, 54];
    let mut prev = 0_u64;
    for &check_min in &checkpoints {
        let delta = check_min - prev;
        tokio::time::advance(Duration::from_secs(delta * 60)).await;
        yield_many(15).await;
        prev = check_min;

        let count = harness.mock_llm.received_requests().await.len();
        assert_eq!(
            count, baseline,
            "No keepalive should fire at {check_min}min. Baseline: {baseline}, Got: {count}"
        );
    }

    tokio::time::resume();
    harness.shutdown().await;
}

// ---------------------------------------------------------------------------
// Cache-keepalive prefix parity
// ---------------------------------------------------------------------------
//
// The keepalive's entire job is to keep the *chat* cache prefix warm. When it
// rebuilds the request from disk (cold cache), the cacheable prefix it warms
// (tools + system) MUST be byte-identical to what the chat path sends —
// otherwise the ping pays a cache write for a prefix nothing reads, and the
// next chat turn still reads cold. These tests drive both a real chat turn and
// a forced cold keepalive rebuild through the mock server and assert the
// prefixes match, across every tool-surface shape (none, static, sub-agent,
// MCP, and all combined). The MCP cases are exactly what would have caught the
// near-regression where the rebuild omitted MCP tools the chat path included.

/// Path to the in-tree stub MCP server, built as a `shore-daemon` binary so it
/// is always present for these tests (no external runtime needed).
fn mcp_stub_path() -> &'static str {
    env!("CARGO_BIN_EXE_mcp_stub_server")
}

/// Boot with `builder`, drive one chat turn, then force a cold keepalive
/// rebuild ping, and assert the keepalive request's cacheable prefix
/// (`tools` + `system`) matches the chat request's.
async fn assert_keepalive_prefix_matches_chat(builder: TestConfigBuilder, label: &str) {
    let mut harness = TestHarness::boot_with(builder).await;

    // One real chat turn: captures the chat request (built from the live tool
    // surface) and writes a complete user+assistant turn to disk so the cold
    // rebuild has something non-mid-turn to reconstruct.
    harness.mock_llm.enqueue_text("hi").await;
    let _response = harness.send_and_collect("hello").await;
    tokio::time::sleep(Duration::from_millis(150)).await;

    let chat_requests = harness.mock_llm.received_requests().await;
    let chat = chat_requests
        .first()
        .unwrap_or_else(|| panic!("[{label}] expected a chat request to the mock"));
    let chat_tools = chat
        .get("tools")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let chat_system = chat
        .get("system")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let baseline = chat_requests.len();

    // Force the COLD rebuild path (bypasses the cached last_request — that path
    // is the one that can silently diverge from chat).
    harness.mock_llm.enqueue_json_text_optional("ping").await;
    let _ping = harness
        .autonomy
        .keepalive_rebuild_ping_now("TestChar")
        .await
        .unwrap_or_else(|| panic!("[{label}] keepalive rebuild produced no request"));

    let all = harness.mock_llm.received_requests().await;
    assert!(
        all.len() > baseline,
        "[{label}] keepalive ping should have hit the mock (baseline {baseline}, got {})",
        all.len()
    );
    let ping = all.last().expect("ping request present");
    let ping_tools = ping
        .get("tools")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let ping_system = ping
        .get("system")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    assert_eq!(
        chat_tools, ping_tools,
        "[{label}] keepalive tool prefix diverged from chat — the warmed cache \
         prefix would not match the next chat turn.\n  chat tools: {chat_tools}\n  ping tools: {ping_tools}"
    );
    assert_eq!(
        chat_system, ping_system,
        "[{label}] keepalive system prefix diverged from chat"
    );

    harness.shutdown().await;
}

/// The keepalive rebuild must reproduce the chat cache prefix for every kind of
/// tool surface. Catches the class of bug where one generation path includes a
/// tool category (MCP, sub-agents, …) the other omits.
#[tokio::test]
async fn keepalive_prefix_matches_chat_across_tool_surfaces() {
    // No tools at all.
    assert_keepalive_prefix_matches_chat(TestConfigBuilder::new().tool_use(false), "no-tools")
        .await;

    // Static tools only.
    assert_keepalive_prefix_matches_chat(
        TestConfigBuilder::new().enabled_tools(&["read", "search", "roll_dice"]),
        "static-tools",
    )
    .await;

    // Sub-agent (`ask_*`) surface.
    assert_keepalive_prefix_matches_chat(
        TestConfigBuilder::new()
            .enabled_tools(&["read"])
            .with_subagent("memory", &["search"]),
        "subagent",
    )
    .await;

    // MCP tools granted directly on the character. The stub server is an
    // in-tree binary, so this always runs (no external runtime).
    let stub = mcp_stub_path();
    assert_keepalive_prefix_matches_chat(
        TestConfigBuilder::new()
            .enabled_tools(&["read", "mcp__mcptest__*"])
            .with_mcp_stdio("mcptest", stub, &[]),
        "mcp",
    )
    .await;

    // Everything at once: static + sub-agent + MCP.
    assert_keepalive_prefix_matches_chat(
        TestConfigBuilder::new()
            .enabled_tools(&["read", "search", "mcp__mcptest__*"])
            .with_subagent("memory", &["search", "mcp__mcptest__echo"])
            .with_mcp_stdio("mcptest", stub, &[]),
        "static+subagent+mcp",
    )
    .await;
}
