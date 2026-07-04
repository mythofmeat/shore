//! Runtime verification driver for the search_history fix.
//!
//! Boots the real daemon + SWP socket (mock LLM stands in for the provider),
//! seeds an on-disk history corpus (old 2025 segment + recent 2026 segment),
//! then drives real `search_chat_logs` tool calls and prints the daemon's actual
//! tool-result JSON. This is NOT a unit test of the handler — it exercises the
//! full dispatch path (SWP -> tool dispatch -> SegmentReader/MessageStore ->
//! ranking -> serialization) through the booted daemon.

#![deny(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

use serde_json::{json, Value};
use shore_config::{character_data_dir, COMPACTION_MANIFEST_FILE, SEGMENTS_DIR};
use shore_protocol::types::{ContentBlock, Message, Role};
use shore_test_harness::TestHarness;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

macro_rules! test_out {
    () => {
        write_stdout_line(format_args!(""))
    };
    ($($arg:tt)*) => {
        write_stdout_line(format_args!($($arg)*))
    };
}

fn write_stdout_line(args: std::fmt::Arguments<'_>) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ignored = std::io::Write::write_fmt(&mut out, format_args!("{args}\n"));
}

fn test_error(message: impl Into<String>) -> Box<dyn std::error::Error> {
    std::io::Error::other(message.into()).into()
}

fn msg(id: &str, role: Role, text: &str, ts: &str) -> Message {
    Message {
        msg_id: id.to_owned(),
        origin: None,
        role,
        content: text.to_owned(),
        images: vec![],
        content_blocks: vec![ContentBlock::Text {
            text: text.to_owned(),
        }],
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        provider_key: None,
        model: None,
        timestamp: ts.to_owned(),
    }
}

fn write_segment(dir: &std::path::Path, file: &str, msgs: &[Message]) -> TestResult {
    let lines = msgs
        .iter()
        .map(Message::serialize_for_storage)
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    std::fs::write(dir.join(file), format!("{lines}\n"))?;
    Ok(())
}

/// Pull the most recent `search_chat_logs` tool-result JSON out of the persisted
/// transcript whose echoed `query` matches.
fn tool_result_for(harness: &TestHarness, query: &str) -> TestResult<Value> {
    let mut found = None;
    for message in harness.read_persisted_messages() {
        let Some(blocks) = message.get("content_blocks").and_then(|b| b.as_array()) else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                continue;
            }
            let Some(content) = block.get("content").and_then(|c| c.as_str()) else {
                continue;
            };
            if let Ok(parsed) = serde_json::from_str::<Value>(content) {
                if parsed.get("query").and_then(|q| q.as_str()) == Some(query) {
                    found = Some(parsed);
                }
            }
        }
    }
    found.ok_or_else(|| test_error(format!("no tool_result found for query {query:?}")))
}

fn results_array<'val>(result: &'val Value, label: &str) -> TestResult<&'val [Value]> {
    result["results"]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| test_error(format!("{label} missing results array")))
}

fn print_result(label: &str, result: &Value) -> TestResult {
    let results = results_array(result, label)?;
    test_out!("\n=== {label} ===");
    test_out!("query            : {}", result["query"]);
    test_out!("count            : {}", result["count"]);
    test_out!("searched_messages: {}", result["searched_messages"]);
    for (i, hit) in results.iter().enumerate() {
        test_out!(
            "  [{i}] {}  {}  {}\n      {}",
            hit["msg_id"],
            hit["timestamp"],
            hit["source"],
            hit["excerpt"]
        );
    }
    Ok(())
}

async fn run_search(harness: &mut TestHarness, id: &str, input: Value) -> TestResult {
    harness
        .mock_llm
        .enqueue_tool_use(id, "search_chat_logs", input)
        .await;
    harness.mock_llm.enqueue_text("done").await;
    let _ignored = harness
        .conn
        .send_message("please search the history", true)
        .await?;
    // A tool call yields two stream phases: the tool-use turn, then the final
    // answer turn. Drain both so the tool_result is persisted before we read.
    let _tool_turn = harness.collect_stream().await;
    let _final_turn = harness.collect_stream().await;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "runtime smoke test keeps seed data, probes, and assertions together"
)]
async fn search_history_runtime_smoke() -> TestResult {
    let mut harness = TestHarness::boot().await;

    // Seed an on-disk corpus under the live character's data dir.
    let char_dir = character_data_dir(&harness.data_dir, "TestChar");
    let seg_dir = char_dir.join(SEGMENTS_DIR);
    std::fs::create_dir_all(&seg_dir)?;

    // Oldest segment: mid-2025 imported history (mirrors the user's report).
    write_segment(
        &seg_dir,
        "0001.jsonl",
        &[
            msg(
                "old-overnight",
                Role::User,
                "We turned the cache daemon off overnight and it caused a bug.",
                "2025-06-10T09:00:00Z",
            ),
            msg(
                "old-cache",
                Role::Assistant,
                "The cache layer was slow in early testing.",
                "2025-06-11T09:00:00Z",
            ),
            msg(
                "old-daemon",
                Role::User,
                "Daemon restarts were noisy back then.",
                "2025-06-12T09:00:00Z",
            ),
        ],
    )?;

    // Recent segment: this week. These should outrank the 2025 hits.
    write_segment(
        &seg_dir,
        "0002.jsonl",
        &[
            msg(
                "recent-cache",
                Role::Assistant,
                "The cache bug came back this week.",
                "2026-05-27T09:00:00Z",
            ),
            msg(
                "recent-daemon",
                Role::User,
                "We restarted the daemon today to clear the cache.",
                "2026-05-28T09:00:00Z",
            ),
        ],
    )?;

    std::fs::write(
        char_dir.join(COMPACTION_MANIFEST_FILE),
        r#"{
          "segments": [
            {"file": "0001.jsonl", "message_count": 3, "compacted_at": "2025-06-13T00:00:00Z"},
            {"file": "0002.jsonl", "message_count": 2, "compacted_at": "2026-05-29T00:00:00Z"}
          ],
          "total_compacted_messages": 5
        }"#,
    )?;

    // Report item #2: recency-weighted ranking. Run first, on a clean
    // transcript, so the only "cache" hits are the seeded corpus.
    run_search(&mut harness, "toolu_cache", json!({"query": "cache"})).await?;
    let cache = tool_result_for(&harness, "cache")?;
    print_result("single keyword: \"cache\" (recency blend)", &cache)?;

    // Report item #1: multi-word natural-language query (previously 0 results).
    run_search(
        &mut harness,
        "toolu_multi",
        json!({"query": "cache daemon overnight"}),
    )
    .await?;
    let multi = tool_result_for(&harness, "cache daemon overnight")?;
    print_result("multi-word query: \"cache daemon overnight\"", &multi)?;

    // Report item #3: searched_messages should reflect the full corpus even
    // with a small cap.
    run_search(
        &mut harness,
        "toolu_cap",
        json!({"query": "cache", "max_results": 2}),
    )
    .await?;
    let capped = tool_result_for(&harness, "cache")?;
    print_result("capped max_results=2", &capped)?;

    // --- assertions the verdict rests on (evidence is the printed output) ---

    // #1: multi-word query returns matches (was 0 before the fix).
    if results_array(&multi, "multi-word query")?.is_empty() {
        return Err(test_error("multi-word query must return matches"));
    }

    // #2: among the seeded corpus, the 2026 hits rank above the 2025 hits.
    let seeded = results_array(&cache, "cache query")?
        .iter()
        .filter(|h| {
            h["source"]
                .as_str()
                .is_some_and(|s| s.starts_with("segment:"))
        })
        .map(|h| {
            h["timestamp"]
                .as_str()
                .ok_or_else(|| test_error(format!("seeded hit missing timestamp: {h}")))
        })
        .collect::<TestResult<Vec<_>>>()?;
    let expected_seeded = vec![
        "2026-05-28T09:00:00Z",
        "2026-05-27T09:00:00Z",
        "2025-06-11T09:00:00Z",
        "2025-06-10T09:00:00Z",
    ];
    if seeded != expected_seeded {
        return Err(test_error(format!(
            "recent matches must rank above older ones; got {seeded:?}"
        )));
    }

    // #3: cap limits returned results but not the corpus scanned.
    let capped_count = capped.get("count").cloned().unwrap_or(Value::Null);
    if capped_count != json!(2) {
        return Err(test_error(format!(
            "max_results cap must be honored; got {capped_count}"
        )));
    }
    let searched_messages = capped
        .get("searched_messages")
        .and_then(Value::as_u64)
        .ok_or_else(|| test_error("capped result missing searched_messages"))?;
    if searched_messages < 5 {
        return Err(test_error(format!(
            "searched_messages must report the full corpus, not just the cap; got {searched_messages}"
        )));
    }

    harness.shutdown().await;
    Ok(())
}
